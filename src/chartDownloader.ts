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
    provider: any,
    maxZoom: number,
    regionGUI: string | undefined = undefined,
    bbox: BBox | undefined = undefined,
    tile: Tile | undefined = undefined
  ): Promise<ChartDownloader> {
    const downloader = new ChartDownloader(resourcesApi, chartsPath, provider)
    if (regionGUI) downloader.initalizeJobFromRegion(regionGUI, maxZoom)
    else if (bbox) downloader.initializeJobFromBBox(bbox, maxZoom)
    else if (tile) {
      downloader.initializeJobFromTile(tile, maxZoom)
    }
    this.ActiveJobs[downloader.ID] = downloader
    return downloader
  }
}

export class ChartDownloader {
  private static DISK_USAGE_LIMIT = 1024 * 1024 * 1024 // 1 GB
  private static nextJobId = 1

  private id: number = ChartDownloader.nextJobId++
  private maxZoom = 15
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
    private provider: any
  ) {}

  get ID(): number {
    return this.id
  }

  public async initalizeJobFromRegion(
    regionGUID: string,
    maxZoom: number
  ): Promise<void> {
    const region = (await this.resourcesApi.getResource(
      'regions',
      regionGUID
    )) as Record<string, any>
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
    this.maxZoom = maxZoom
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
    this.maxZoom = maxZoom
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
    this.maxZoom = maxZoom
  }

  /**
   * Download map tiles for a specific area.
   *
   */
  async seedCache(): Promise<void> {
    this.cancelRequested = false
    this.status = Status.Running
    this.tilesToDownload = await this.filterCachedTiles(this.tiles)
    this.downloadedTiles = 0
    this.failedTiles = 0
    this.cachedTiles = this.totalTiles - this.tilesToDownload.length
    const limit = pLimit(this.concurrentDownloadsLimit) // concurrent download limit
    let tileCounter = 0
    this.tilesToDownload = await this.filterCachedTiles(this.tiles)

    const tasks = this.tilesToDownload.map((tile) =>
      limit(async () => {
        if (this.cancelRequested) {
          this.status = Status.Stopped
          return
        }
        if (tileCounter % 1000 === 0) {
          await new Promise((r) => setTimeout(r, 0))
          try {
            const { free } = await checkDiskSpace(this.chartsPath)
            if (free < ChartDownloader.DISK_USAGE_LIMIT) {
              console.warn(`Low disk space. Stopping download.`)
              this.status = Status.Stopped
              return
            }
          } catch (err) {
            console.error(`Error checking disk space:`, err)
            this.status = Status.Stopped
            return
          }
        }
        tileCounter++
        const buffer = await ChartDownloader.getTileFromCacheOrRemote(
          this.chartsPath,
          this.provider,
          tile
        )
        if (buffer === null) {
          this.failedTiles++
        } else {
          this.downloadedTiles++
        }
      })
    )

    try {
      await Promise.all(tasks)
    } catch (err) {
      console.error('Error downloading tiles:', err)
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
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
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
    const checks = allTiles.map(async (tile) => {
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
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return tile // file does not exist → uncached
        }
        console.error('Unexpected fs error:', err)
        return tile // treat unknown errors as uncached
      }
    })

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
    provider: any,
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
    provider: any,
    tile: Tile,
    timeoutMs = 5000
  ): Promise<Buffer | null> {
    const url = provider.remoteUrl
      .replace('{z}', tile.z.toString())
      // To be able to handle NOAA WMTS caching as a tilemap source with -2 offset
      .replace('{z-2}', (tile.z - 2).toString())
      .replace('{x}', tile.x.toString())
      .replace('{y}', tile.y.toString())
      .replace('{-y}', (Math.pow(2, tile.z) - 1 - tile.y).toString())
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        headers: provider.headers,
        signal: controller.signal
      })
      if (!response.ok) {
        return null
      }
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      return buffer
    } catch (err) {
      return null
    } finally {
      clearTimeout(id)
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

    // Helper to process a lon/lat box normally
    const processBBox = (
      lo1: number,
      la1: number,
      lo2: number,
      la2: number
    ) => {
      for (let z = 0; z <= maxZoom; z++) {
        const [minX, maxY] = this.lonLatToTileXY(lo1, la1, z)
        const [maxX, minY] = this.lonLatToTileXY(lo2, la2, z)

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
        const [minX, minY] = this.lonLatToTileXY(
          boundingBox[0],
          boundingBox[3],
          z
        ) // top-left
        const [maxX, maxY] = this.lonLatToTileXY(
          boundingBox[2],
          boundingBox[1],
          z
        ) // bottom-right

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            const tileBbox = this.tileToBBox(x, y, z)
            const tilePoly = this.bboxPolygon(tileBbox)

            if (booleanIntersects(feature as any, tilePoly)) {
              tiles.push({ x, y, z })
            }
          }
        }
      }
    }

    return tiles
  }

  private convertRegionToGeoJSON(
    region: Record<string, any>
  ): FeatureCollection {
    const feature = region.feature
    if (!feature || feature.type !== 'Feature' || !feature.geometry) {
      throw new Error('Invalid region: missing feature or geometry')
    }

    const geoFeature = {
      type: 'Feature' as const,
      id: feature.id || undefined,
      geometry: feature.geometry,
      properties: {
        name: region.name || '',
        description: region.description || '',
        timestamp: region.timestamp || '',
        source: region.$source || '',
        ...feature.properties
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
      for (
        let i = 0;
        i < (f.geometry as MultiPolygon).coordinates.length;
        i++
      ) {
        pushFeaturePolygon(f, (f.geometry as MultiPolygon).coordinates[i], i)
      }
    } else if (f.geometry && f.geometry.type === 'Polygon') {
      features.push(f as Feature<Polygon>)
    }

    return {
      type: 'FeatureCollection' as const,
      features
    }
  }

  private lonLatToTileXY(
    lon: number,
    lat: number,
    zoom: number
  ): [number, number] {
    const n = 2 ** zoom
    const x = Math.floor(((lon + 180) / 360) * n)
    const y = Math.floor(
      ((1 -
        Math.log(
          Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)
        ) /
          Math.PI) /
        2) *
        n
    )
    return [x, y]
  }

  private tileToBBox(x: number, y: number, z: number): BBox {
    const n = 2 ** z
    const lon1 = (x / n) * 360 - 180
    const lat1 =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
    const lon2 = ((x + 1) / n) * 360 - 180
    const lat2 =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
    return [lon1, lat2, lon2, lat1]
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
