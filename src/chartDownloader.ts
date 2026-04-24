import fs from 'fs'
import path from 'path'
import pLimit from 'p-limit'
import type {
  BBox,
  FeatureCollection,
  Polygon,
  MultiPolygon,
  Feature,
  Position
} from 'geojson'
import splitGeoJSON from 'geojson-antimeridian-cut'
import booleanIntersects from '@turf/boolean-intersects'
import { bbox } from '@turf/bbox'
import { polygon } from '@turf/helpers'
import checkDiskSpace from 'check-disk-space'
import { ResourcesApi } from '@signalk/server-api'
import { ChartProvider } from './types'
import { lonLatToMercator, lonLatToTile, tileToBBox } from './projection'
import { MIN_ZOOM } from './tileServer'
import isSea from 'is-sea'

export interface Tile {
  x: number
  y: number
  z: number
}

export enum Status {
  Stopped,
  Running
}

export class ChartSeedingManager {
  public static ActiveJobs: { [key: number]: ChartDownloader } = {}

  public static async createJob(
    resourcesApi: ResourcesApi,
    chartsPath: string,
    provider: ChartProvider,
    maxZoom: number,
    regionGUID: string | undefined = undefined,
    bbox: BBox | undefined = undefined,
    tile: Tile | undefined = undefined
  ): Promise<ChartDownloader> {
    const downloader = new ChartDownloader(resourcesApi, chartsPath, provider)
    // Init must complete before the job is usable; callers get back a job that
    // knows its tile set and totalTiles. Without awaiting, a follow-up "start"
    // action would race the init reads of this.tiles.
    if (regionGUID)
      await downloader.initializeJobFromRegion(regionGUID, maxZoom)
    else if (bbox) await downloader.initializeJobFromBBox(bbox, maxZoom)
    else if (tile) await downloader.initializeJobFromTile(tile, maxZoom)
    else throw new Error('createJob requires regionGUID, bbox, or tile')
    this.ActiveJobs[downloader.ID] = downloader
    return downloader
  }

  // Cancel all running jobs and clear the registry. Used when the plugin stops
  // so a disabled plugin doesn't keep pulling tiles in the background.
  public static cancelAll(): void {
    for (const job of Object.values(this.ActiveJobs)) {
      job.cancelJob()
    }
    this.ActiveJobs = {}
  }
}

export class ChartDownloader {
  private static MINIMUM_FREE_DISK_SPACE = 1024 * 1024 * 1024 // 1 GB
  private static nextJobId = 1

  private id: number = ChartDownloader.nextJobId++
  private status: Status = Status.Stopped
  private totalTiles = 0
  private downloadedTiles = 0
  private failedTiles = 0
  private cachedTiles = 0

  private concurrentDownloadsLimit = 20
  private areaDescription = ''
  private cancelRequested = false

  private tiles: Tile[] = []
  private tilesToDownload: Tile[] = []

  constructor(
    private resourcesApi: ResourcesApi,
    private chartsPath: string,
    private provider: ChartProvider
  ) {}

  get ID(): number {
    return this.id
  }

  public async initializeJobFromRegion(
    regionGUID: string,
    maxZoom: number
  ): Promise<void> {
    const region = (await this.resourcesApi.getResource(
      'regions',
      regionGUID
    )) as Record<string, unknown>
    const geojson = this.convertRegionToGeoJSON(region)
    this.tiles = this.getTilesForGeoJSON(
      geojson,
      this.provider.minzoom,
      maxZoom
    )
    this.tilesToDownload = await this.filterCachedTiles(this.tiles)

    this.status = Status.Stopped
    this.totalTiles = this.tiles.length
    this.cachedTiles = this.totalTiles - this.tilesToDownload.length
    this.areaDescription = `Region: ${region?.name ?? ''}`
  }

  public async initializeJobFromBBox(
    bbox: BBox,
    maxZoom: number
  ): Promise<void> {
    this.tiles = this.getTilesForBBox(bbox, maxZoom)
    this.tilesToDownload = await this.filterCachedTiles(this.tiles)

    this.status = Status.Stopped
    this.totalTiles = this.tiles.length
    this.cachedTiles = this.totalTiles - this.tilesToDownload.length
    this.areaDescription = `BBox: [${bbox.join(', ')}]`
  }

  public async initializeJobFromTile(
    tile: Tile,
    maxZoom: number
  ): Promise<void> {
    this.tiles = this.getSubTiles(tile, maxZoom)
    this.tilesToDownload = await this.filterCachedTiles(this.tiles)

    this.status = Status.Stopped
    this.totalTiles = this.tiles.length
    this.cachedTiles = this.totalTiles - this.tilesToDownload.length
    this.areaDescription = `Tile: [${tile.x}, ${tile.y}, ${tile.z}]`
  }

  private static DISK_CHECK_INTERVAL_MS = 30_000

  /**
   * Download map tiles for a specific area.
   */
  async seedCache(): Promise<void> {
    // Guard against double-start: a second call while Running would share
    // counters and concurrency slots with the first and corrupt progress.
    if (this.status === Status.Running) return

    this.cancelRequested = false
    this.status = Status.Running
    this.tilesToDownload = await this.filterCachedTiles(this.tiles)
    this.downloadedTiles = 0
    this.failedTiles = 0
    this.cachedTiles = this.totalTiles - this.tilesToDownload.length
    const limit = pLimit(this.concurrentDownloadsLimit) // concurrent download limit
    let lastDiskCheck = 0

    const tasks = this.tilesToDownload.map((tile) =>
      limit(async () => {
        if (this.cancelRequested) return
        // Time-based (rather than tile-count-based) disk-space probing: a
        // tight per-1000-tile cadence fired hundreds of times on a large
        // bbox, whereas real disk consumption grows with wall-clock time.
        const now = Date.now()
        if (now - lastDiskCheck >= ChartDownloader.DISK_CHECK_INTERVAL_MS) {
          lastDiskCheck = now
          try {
            const { free } = await checkDiskSpace(this.chartsPath)
            if (free < ChartDownloader.MINIMUM_FREE_DISK_SPACE) {
              console.warn(`Low disk space. Stopping download.`)
              this.cancelRequested = true
              return
            }
          } catch (err) {
            console.error(`Error checking disk space:`, err)
            this.cancelRequested = true
            return
          }
        }
        const buffer = await ChartDownloader.getTileFromCacheOrRemote(
          this.chartsPath,
          this.provider,
          tile
        )
        // Re-check after the await: the job may have been cancelled while the
        // fetch was in flight. Still-running fetches would otherwise keep
        // mutating counters after status flips to Stopped.
        if (this.cancelRequested) return
        if (buffer === null) {
          this.failedTiles++
        } else {
          this.downloadedTiles++
        }
      })
    )

    // allSettled ensures every in-flight task completes before we flip back
    // to Stopped; Promise.all would resolve on the first rejection while
    // other tasks still incremented counters in the background.
    const results = await Promise.allSettled(tasks)
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('Error downloading tile:', r.reason)
      }
    }
    this.status = Status.Stopped
  }

  async deleteCache(): Promise<void> {
    this.status = Status.Running
    for (const tile of this.tiles) {
      if (this.cancelRequested) break
      const tilePath = path.join(
        this.chartsPath,
        `${this.provider.name}`,
        `${tile.z}`,
        `${tile.x}`,
        `${tile.y}.${this.provider.format}`
      )

      try {
        await fs.promises.unlink(tilePath)
        this.cachedTiles = Math.max(this.cachedTiles - 1, 0)
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`Error deleting cached tile ${tilePath}:`, err)
        }
      }
    }
    this.status = Status.Stopped
  }

  public cancelJob() {
    this.cancelRequested = true
  }

  private async filterCachedTiles(allTiles: Tile[]): Promise<Tile[]> {
    // Bound the concurrent fs.access calls. 100k+ tiles in a large bbox would
    // otherwise fire all accesses at once, risking EMFILE on default rlimit
    // and spiking the event loop.
    const limit = pLimit(64)
    const checks = allTiles.map((tile) =>
      limit(async () => {
        const tilePath = path.join(
          this.chartsPath,
          this.provider.name,
          `${tile.z}`,
          `${tile.x}`,
          `${tile.y}.${this.provider.format}`
        )

        try {
          await fs.promises.access(tilePath) // file exists
          return null // filter out cached tile
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return tile // file does not exist → uncached
          }
          console.error('Unexpected fs error:', err)
          return tile // treat unknown errors as uncached
        }
      })
    )

    const results = await Promise.all(checks)
    return results.filter((t): t is Tile => t !== null)
  }

  public info() {
    return {
      id: this.id,
      chartName: this.provider.name,
      regionName: this.areaDescription,
      totalTiles: this.totalTiles,
      downloadedTiles: this.downloadedTiles,
      cachedTiles: this.cachedTiles,
      failedTiles: this.failedTiles,
      progress:
        this.totalTiles > 0
          ? (this.downloadedTiles + this.cachedTiles + this.failedTiles) /
            this.totalTiles
          : 0,
      status: this.status
    }
  }

  static async getTileFromCacheOrRemote(
    chartsPath: string,
    provider: ChartProvider,
    tile: Tile
  ): Promise<Buffer | null> {
    const tilePath = path.join(
      chartsPath,
      `${provider.name}`,
      `${tile.z}`,
      `${tile.x}`,
      `${tile.y}.${provider.format}`
    )

    try {
      const data = await fs.promises.readFile(tilePath)
      return data
    } catch (err) {
      //Cache miss, proceed to fetch from remote
    }
    const buffer = await this.fetchTileFromRemote(provider, tile)
    if (buffer) {
      try {
        await fs.promises.mkdir(path.dirname(tilePath), { recursive: true })
        await fs.promises.writeFile(tilePath, buffer)
      } catch (err) {
        console.error(`Error writing tile ${tilePath}:`, err)
      }
    }
    return buffer
  }

  static async fetchTileFromRemote(
    provider: ChartProvider,
    tile: Tile,
    timeoutMs = 5000
  ): Promise<Buffer | null> {
    // Local (non-proxy) providers have no remoteUrl; the POST /cache endpoint
    // is open to any provider, so callers can still land here and should get
    // a well-defined null rather than a crash.
    if (!provider.remoteUrl) {
      return null
    }

    const hasSeaOrLandFilter = provider.onlySea !== provider.onlyLand;
    if (hasSeaOrLandFilter) {
      const [minLon, minLat, maxLon, maxLat] = tileToBBox(
        tile.x,
        tile.y,
        tile.z
      )
      
      const hasSea = isSea(minLat, minLon) || isSea(minLat, maxLon) || isSea(maxLat, minLon) || isSea(maxLat, maxLon);
      const hasLand = !isSea(minLat, minLon) || !isSea(minLat, maxLon) || !isSea(maxLat, minLon) || !isSea(maxLat, maxLon);
      if (provider.onlySea && !hasSea) {
        return null;
      }
      if (provider.onlyLand && !hasLand) {
        return null;
      }
    }

    let url = provider.remoteUrl
      .replace('{z}', tile.z.toString())
      // To be able to handle NOAA WMTS caching as a tilemap source with -2 offset
      .replace('{z-2}', (tile.z - 2).toString())
      .replace('{x}', tile.x.toString())
      .replace('{y}', tile.y.toString())
      .replace('{-y}', (Math.pow(2, tile.z) - 1 - tile.y).toString())

    // Support {bbox} (EPSG:4326) and {bbox_3857} (EPSG:3857) for WMS-style sources.
    // {bbox} emits minLon,minLat,maxLon,maxLat — this is WMS 1.1.1 order, and also
    // matches WMS 1.3.0 for projected CRSes. For WMS 1.3.0 with a geographic CRS
    // (e.g. EPSG:4326) the spec requires lat,lon axis order; prefer {bbox_3857} in
    // that case, or use a WMS 1.1.1 endpoint.
    if (url.includes('{bbox}') || url.includes('{bbox_3857}')) {
      const [minLon, minLat, maxLon, maxLat] = tileToBBox(
        tile.x,
        tile.y,
        tile.z
      )
      if (url.includes('{bbox}')) {
        url = url.replace('{bbox}', `${minLon},${minLat},${maxLon},${maxLat}`)
      }
      if (url.includes('{bbox_3857}')) {
        const [mx1, my1] = lonLatToMercator(minLon, minLat)
        const [mx2, my2] = lonLatToMercator(maxLon, maxLat)
        url = url.replace('{bbox_3857}', `${mx1},${my1},${mx2},${my2}`)
      }
    }
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        headers: provider.headers,
        signal: controller.signal
      })
      // Clear the abort timer as soon as the response head is in. A long body
      // read was otherwise racing the timeout and could be aborted mid-stream
      // while the caller waited on arrayBuffer().
      clearTimeout(timeoutId)
      if (!response.ok) {
        return null
      }
      const arrayBuffer = await response.arrayBuffer()
      return Buffer.from(arrayBuffer)
    } catch (_err) {
      clearTimeout(timeoutId)
      return null
    }
  }

  getSubTiles(tile: Tile, maxZoom: number): Tile[] {
    const tiles: Tile[] = [tile]

    for (let z = tile.z + 1; z <= maxZoom; z++) {
      const zoomDiff = z - tile.z
      const factor = Math.pow(2, zoomDiff)

      const startX = tile.x * factor
      const startY = tile.y * factor

      for (let x = startX; x < startX + factor; x++) {
        for (let y = startY; y < startY + factor; y++) {
          tiles.push({ x, y, z })
        }
      }
    }

    return tiles
  }

  /**
   * Get all tiles that intersect a bounding box up to a maximum zoom level.
   * bbox = [minLon, minLat, maxLon, maxLat]
   */
  getTilesForBBox(bbox: BBox, maxZoom: number): Tile[] {
    const tiles: Tile[] = []
    const [minLon, minLat, maxLon, maxLat] = bbox

    const crossesAntiMeridian = minLon > maxLon
    // Respect the provider's minzoom: low zooms outside the provider's range
    // would 404 from the remote and just inflate totalTiles.
    const minZoom = Math.max(MIN_ZOOM, this.provider.minzoom ?? MIN_ZOOM)

    // Helper to process a lon/lat box normally. lonLatToTileXY returns
    // tile-Y increasing southward, so for a box with minLat < maxLat the
    // south edge yields the larger tile-Y.
    const processBBox = (
      lo1: number,
      la1: number,
      lo2: number,
      la2: number
    ) => {
      for (let z = minZoom; z <= maxZoom; z++) {
        const [minX, maxY] = lonLatToTile(lo1, la1, z) // SW corner
        const [maxX, minY] = lonLatToTile(lo2, la2, z) // NE corner

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            tiles.push({ x, y, z })
          }
        }
      }
    }

    if (!crossesAntiMeridian) {
      // normal
      processBBox(minLon, minLat, maxLon, maxLat)
    } else {
      // crosses antimeridian — split into two boxes:
      // [minLon -> 180] and [-180 -> maxLon]
      processBBox(minLon, minLat, 180, maxLat)
      processBBox(-180, minLat, maxLon, maxLat)
    }

    return tiles
  }

  getTilesForGeoJSON(
    geojson: FeatureCollection,
    zoomMin = 1,
    zoomMax = 14
  ): Tile[] {
    const tiles: Tile[] = []

    for (const feature of geojson.features) {
      if (
        feature.geometry.type !== 'Polygon' &&
        feature.geometry.type !== 'MultiPolygon'
      ) {
        console.warn('Skipping non-polygon feature')
        continue
      }

      const boundingBox = bbox(feature.geometry as Polygon) // [minX, minY, maxX, maxY]
      for (let z = zoomMin; z <= zoomMax; z++) {
        const [minX, minY] = lonLatToTile(boundingBox[0], boundingBox[3], z) // top-left
        const [maxX, maxY] = lonLatToTile(boundingBox[2], boundingBox[1], z) // bottom-right

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            // Cheap AABB pre-filter avoids allocating a turf polygon and
            // running booleanIntersects for tiles that can't possibly
            // overlap the feature's bbox. Saves 90%+ of the turf work on
            // concave regions.
            const [tMinLon, tMinLat, tMaxLon, tMaxLat] = tileToBBox(x, y, z)
            if (
              tMaxLon < boundingBox[0] ||
              tMinLon > boundingBox[2] ||
              tMaxLat < boundingBox[1] ||
              tMinLat > boundingBox[3]
            ) {
              continue
            }
            const tilePoly = this.bboxPolygon([
              tMinLon,
              tMinLat,
              tMaxLon,
              tMaxLat
            ])
            if (booleanIntersects(feature as Feature, tilePoly)) {
              tiles.push({ x, y, z })
            }
          }
        }
      }
    }

    return tiles
  }

  private convertRegionToGeoJSON(
    region: Record<string, unknown>
  ): FeatureCollection {
    const feature = region.feature as
      | {
          type?: string
          geometry?: Polygon | MultiPolygon
          id?: string
          properties?: Record<string, unknown>
        }
      | undefined
    if (!feature || feature.type !== 'Feature' || !feature.geometry) {
      throw new Error('Invalid region: missing feature or geometry')
    }

    const geoFeature = {
      type: 'Feature' as const,
      id: feature.id || undefined,
      geometry: feature.geometry,
      properties: {
        name: (region.name as string) || '',
        description: (region.description as string) || '',
        timestamp: (region.timestamp as string) || '',
        source: (region.$source as string) || '',
        ...(feature.properties || {})
      }
    }
    const splitGeoFeature = splitGeoJSON(geoFeature)
    const features: Feature<Polygon>[] = []

    const pushFeaturePolygon = (
      orig: Feature,
      coords: Position[][],
      idx?: number
    ) => {
      const poly: Feature<Polygon> = {
        type: 'Feature',
        id: idx != null && orig.id ? `${orig.id}-${idx}` : orig.id,
        geometry: {
          type: 'Polygon',
          coordinates: coords
        },
        properties: orig.properties || {}
      }
      features.push(poly)
    }

    const f = splitGeoFeature as Feature
    if (f.geometry && f.geometry.type === 'MultiPolygon') {
      const coords = (f.geometry as MultiPolygon).coordinates
      coords.forEach((ring, i) => pushFeaturePolygon(f, ring, i))
    } else if (f.geometry && f.geometry.type === 'Polygon') {
      features.push(f as Feature<Polygon>)
    }

    return {
      type: 'FeatureCollection' as const,
      features
    }
  }

  private bboxPolygon(boundingBox: BBox) {
    const [minLon, minLat, maxLon, maxLat] = boundingBox
    return polygon([
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat]
      ]
    ])
  }
}
