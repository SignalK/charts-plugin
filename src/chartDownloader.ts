import path from 'path'
import type { DatabaseSync } from 'node:sqlite'
import type { BBox } from 'geojson'
import checkDiskSpace from 'check-disk-space'
import { ChartProvider, MBTilesHandle } from './types'
import { lonLatToMercator, tileToBBox } from './projection'

// All DB-touching helpers (delete / purge / vacuum / region-tile listing) need
// the raw node:sqlite handle exposed by @signalk/mbtiles. Reaching through
// `provider._mbtilesHandle!._db!` worked but lied about the contract: a proxy
// provider whose mbtiles file failed to open at startup has neither, and the
// non-null assertions papered over the resulting TypeError. Centralising here
// gives a single descriptive failure surface and removes seven `!` operators
// from call sites.
function requireMbtilesDb(provider: ChartProvider): DatabaseSync {
  const db = provider._mbtilesHandle?._db
  if (!db) {
    throw new Error(
      `Provider "${provider.identifier}": mbtiles cache not open. ` +
        `Configure the provider with proxy:true and ensure the cache path ` +
        `is writable; this operation needs the raw SQLite handle.`
    )
  }
  return db
}

import {
  Tile,
  convertFeatureToGeoJSON,
  getTilesForGeoJSON,
  TileGeneratorFactory,
  convertBboxToGeoJSON,
  countTilesAdaptiveIterative
} from './chartDownloaderTileHelpers'

export type { Tile }

import {
  openOrCreateMbtiles,
  deleteTilesInChunks,
  getMBTilesForPolygon,
  purgeAllOrphanImages,
  vacuumMbtiles
} from './chartDownloaderMBTilesHelpers'

export enum State {
  Stopped,
  Running
}

interface CacheStatistic {
  requests: number
  hits: number
  misses: number
  failures: number
}

export interface JobOptions {
  refetch: boolean
  mbtiles: boolean
  vacuum: boolean
}

enum JobType {
  None,
  Seed,
  Delete
}

export enum TileSource {
  None,
  FetchedFromCache,
  FetchedFromRemote
}

export interface TileFetchResult {
  buffer: Buffer | null
  source: TileSource
}

export class ChartSeedingManager {
  public static ActiveJobs: { [key: number]: ChartDownloader } = {}

  public static async createJob(
    cachePath: string,
    provider: ChartProvider,
    options: JobOptions,
    minZoom: number,
    maxZoom: number,
    feature: GeoJSON.Feature<GeoJSON.Geometry> | undefined = undefined,
    bbox: BBox | undefined = undefined
  ): Promise<ChartDownloader> {
    const downloader = new ChartDownloader(cachePath, provider, options)
    this.ActiveJobs[downloader.ID] = downloader
    if (feature) downloader.initalizeJobFromFeature(feature, minZoom, maxZoom)
    else if (bbox) downloader.initializeJobFromBBox(bbox, minZoom, maxZoom)

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
  private static CachingEnabled = true
  private static CacheStatistics: Map<string, CacheStatistic> = new Map()
  private static TilesCached = 0
  private static lastDiskSpaceCheck = 0
  private static lastDiskSpaceResult = true

  private id: number = ChartDownloader.nextJobId++

  private type: JobType = JobType.None
  private state: State = State.Stopped
  private status = 'Idle'
  private totalTiles = 0
  private downloadedTiles = 0
  private failedTiles = 0
  private cachedTiles = 0
  private deletedTiles = 0

  private areaDescription = ''
  private cancelRequested = false

  private regionName = 'Unnamed'
  private tiles!: TileGeneratorFactory
  private tilesInDB!: TileGeneratorFactory

  constructor(
    private cachePath: string,
    private provider: ChartProvider,
    private options: JobOptions
  ) {}

  get ID(): number {
    return this.id
  }

  public async initalizeJobFromFeature(
    feature: GeoJSON.Feature<GeoJSON.Geometry>,
    minZoom: number,
    maxZoom: number
  ): Promise<void> {
    const geojson = convertFeatureToGeoJSON(feature)

    this.tiles = () => getTilesForGeoJSON(geojson, minZoom, maxZoom)
    // Defer the requireMbtilesDb call to factory invocation: the handle may
    // not be open yet when initialize* runs (e.g. createJob before the
    // proxy mbtiles is reconciled), but it must be open by the time the
    // generator is iterated.
    this.tilesInDB = () =>
      getMBTilesForPolygon(
        requireMbtilesDb(this.provider),
        geojson,
        minZoom,
        maxZoom
      )
    this.totalTiles = countTilesAdaptiveIterative(geojson, minZoom, maxZoom)
    this.state = State.Stopped
    this.regionName = feature?.properties?.name ?? 'Unnamed'
    this.areaDescription = `Region: ${this.regionName}`
  }

  public async initializeJobFromBBox(
    bbox: BBox,
    minZoom: number,
    maxZoom: number
  ): Promise<void> {
    const geojson = convertBboxToGeoJSON(bbox)
    this.tiles = () => getTilesForGeoJSON(geojson, minZoom, maxZoom)
    this.tilesInDB = () =>
      getMBTilesForPolygon(
        requireMbtilesDb(this.provider),
        geojson,
        minZoom,
        maxZoom
      )
    this.totalTiles = countTilesAdaptiveIterative(geojson, minZoom, maxZoom)
    this.state = State.Stopped
    this.areaDescription = `BBox: [${bbox
      .map((v) => Number(v).toFixed(3))
      .join(', ')}]`
  }

  /**
   * Download map tiles for a specific area.
   */
  async seedCache(): Promise<void> {
    // Guard against double-start: a second call while Running would share
    // counters and concurrency slots with the first and corrupt progress.
    if (this.state === State.Running) return
    const concurrency = 32
    this.cancelRequested = false
    this.state = State.Running
    this.downloadedTiles = 0
    this.cachedTiles = 0
    this.failedTiles = 0
    this.type = JobType.Seed

    const tileIterator = this.tiles()
    let generatorDone = false

    const nextTile = (): Tile | null => {
      if (generatorDone || this.cancelRequested) return null

      const { value, done } = tileIterator.next()
      if (done) {
        generatorDone = true
        return null
      }

      return value
    }

    const worker = async () => {
      while (!this.cancelRequested) {
        const tile = nextTile()
        if (!tile) return

        if (!ChartDownloader.CachingEnabled) {
          this.cancelRequested = true
          this.status = 'Insufficient disk space, canceling job'
          return
        }

        try {
          const result = await ChartDownloader.getTileFromCacheOrRemote(
            this.cachePath,
            this.provider,
            tile,
            this.options.refetch
          )

          if (result.source === TileSource.None) {
            this.failedTiles++
          } else if (result.source === TileSource.FetchedFromCache) {
            this.cachedTiles++
          } else {
            this.downloadedTiles++
          }
          this.totalTiles = Math.max(
            this.totalTiles,
            this.downloadedTiles + this.failedTiles + this.cachedTiles
          )
        } catch (err) {
          this.failedTiles++
        }
      }
    }
    this.status = 'Seeding'
    const workers = Array.from({ length: concurrency }, () => worker())
    await Promise.all(workers)
    this.state = State.Stopped

    if (this.options.mbtiles) {
      this.status = 'Creating MBTiles'
      const safeRegionName = this.regionName
        .normalize('NFKC') // normalize unicode
        .replace(/[^a-zA-Z0-9_-]/g, '_') // allow only safe chars
        .replace(/_+/g, '_') // collapse repeats
        .replace(/^_+|_+$/g, '') // trim underscores
        .slice(0, 100) // limit length
      const baseDir = path.resolve(this.cachePath, 'mbtiles')
      const filePath = path.resolve(
        baseDir,
        `${safeRegionName}_${this.provider.identifier}.mbtiles`
      )

      if (!filePath.startsWith(baseDir)) {
        throw new Error('Invalid path detected')
      }

      // TODO: Check for diskspace

      const mbtiles = await openOrCreateMbtiles(filePath, this.provider)
      const iterator = this.tiles()
      for (const tile of iterator) {
        const buffer = await ChartDownloader.getTileFromMbTiles(
          this.provider._mbtilesHandle!,
          tile
        )
        if (buffer) {
          await ChartDownloader.cacheTileToMbTiles(mbtiles, tile, buffer)
        }
      }
      mbtiles._db?.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    }
    this.status = 'Completed'
  }

  async deleteCache(): Promise<void> {
    this.state = State.Running
    this.deletedTiles = 0
    this.type = JobType.Delete
    this.status = 'Deleting tiles'
    const db = requireMbtilesDb(this.provider)
    await deleteTilesInChunks(db, this.tilesInDB(), 1000, (deleted) => {
      console.log(`Deleted ${deleted} / ${this.totalTiles}`)
    })
    this.status = 'Purging orphaned images'
    await purgeAllOrphanImages(db, 1000, (deleted, totalDeleted) => {
      this.deletedTiles += deleted
      console.log(
        `Purged ${totalDeleted} orphaned images (last chunk ${deleted})`
      )
    })
    if (this.options.vacuum) {
      this.status = 'Vacuuming MBTiles database'
      vacuumMbtiles(db)
    }
    this.status = 'Completed'
    this.state = State.Stopped
  }

  public cancelJob() {
    this.cancelRequested = true
  }

  public info() {
    const progress = () => {
      if (this.totalTiles > 0) {
        if (this.type === JobType.Seed) {
          return (
            (this.downloadedTiles + this.cachedTiles + this.failedTiles) /
            this.totalTiles
          )
        } else if (this.type === JobType.Delete) {
          return this.deletedTiles / this.totalTiles
        }
      }
      return 0
    }

    return {
      id: this.id,
      type: this.type,
      chartName: this.provider.name,
      regionName: this.areaDescription,
      totalTiles: this.totalTiles,
      downloadedTiles: this.downloadedTiles,
      cachedTiles: this.cachedTiles,
      failedTiles: this.failedTiles,
      deletedTiles: this.deletedTiles,
      progress: progress(),
      status: this.status,
      state: this.state
    }
  }

  static async getTileFromCacheOrRemote(
    chartsPath: string,
    provider: ChartProvider,
    tile: Tile,
    overwrite = false
  ): Promise<TileFetchResult> {
    let stats = ChartDownloader.CacheStatistics.get(provider.identifier)
    if (!stats) {
      stats = { requests: 0, hits: 0, misses: 0, failures: 0 }
      ChartDownloader.CacheStatistics.set(provider.identifier, stats)
    }
    stats.requests++
    // Try MBTiles cache first
    if (!overwrite) {
      const mbtilesBuffer = await ChartDownloader.getTileFromMbTiles(
        provider._mbtilesHandle!,
        tile
      )
      if (mbtilesBuffer) {
        stats.hits++
        return { buffer: mbtilesBuffer, source: TileSource.FetchedFromCache }
      }
    }

    // Cache miss: fetch from remote
    const buffer = await ChartDownloader.fetchTileFromRemote(provider, tile)
    ChartDownloader.CachingEnabled =
      await ChartDownloader.hasDiskSpace(chartsPath)
    if (ChartDownloader.CachingEnabled && buffer) {
      stats.misses++
      //Writing to mbtiles must be awaited
      await ChartDownloader.cacheTileToMbTiles(
        provider._mbtilesHandle!,
        tile,
        buffer
      )
      return { buffer, source: TileSource.FetchedFromRemote }
    }
    stats.failures++
    return { buffer: null, source: TileSource.None }
  }

  static async getTileFromMbTiles(
    mbtilesHandle: MBTilesHandle,
    tile: Tile
  ): Promise<Buffer | null> {
    if (!mbtilesHandle) {
      return null
    }
    try {
      const cachedBuffer = await new Promise<Buffer | null>(
        (resolve, reject) => {
          mbtilesHandle.getTile(
            tile.z,
            tile.x,
            tile.y,
            (err: Error | null, data: Buffer) => {
              if (err) {
                // MBTiles returns an error when tile does not exist
                if (err.message?.includes('Tile does not exist')) {
                  return resolve(null)
                }
                return reject(err)
              }
              resolve(data)
            }
          )
        }
      )

      if (cachedBuffer) {
        return cachedBuffer
      }
    } catch (err) {
      console.error('Failed to read tile from MBTiles cache:', err)
    }
    return null
  }

  static async cacheTileToMbTiles(
    mbtilesHandle: MBTilesHandle,
    tile: Tile,
    buffer: Buffer | null
  ): Promise<void> {
    if (buffer && ChartDownloader.CachingEnabled) {
      try {
        await new Promise<void>((resolve, reject) => {
          mbtilesHandle.putTile(
            tile.z,
            tile.x,
            tile.y,
            buffer,
            (err: Error | null) => {
              if (err) reject(err)
              else resolve()
            }
          )
        })
        ChartDownloader.TilesCached++
      } catch (err) {
        console.error('Failed to write tile to mbtiles cache:', err)
      }
    }
  }

  static async fetchTileFromRemote(
    provider: ChartProvider,
    tile: Tile,
    timeoutMs = 5000
  ): Promise<Buffer | null> {
    // Token providers fetch their token lazily; awaiting here ensures
    // remoteUrl/headers below template against a non-stale token. Fast-path
    // when the cached token is still inside its TTL: the call returns
    // synchronously without I/O.
    if (provider._tokenProvider) {
      await provider._tokenProvider.ensureFreshToken()
    }
    // Local (non-proxy) providers have no remoteUrl; the POST /cache endpoint
    // is open to any provider, so callers can still land here and should get
    // a well-defined null rather than a crash.
    if (!provider.remoteUrl) {
      return null
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

  static async hasDiskSpace(path: string): Promise<boolean> {
    const now = Date.now()

    // cache for 2 seconds
    if (now - ChartDownloader.lastDiskSpaceCheck < 2000) {
      return ChartDownloader.lastDiskSpaceResult
    }

    try {
      const { free } = await checkDiskSpace(path)
      ChartDownloader.lastDiskSpaceResult =
        free >= ChartDownloader.MINIMUM_FREE_DISK_SPACE
    } catch (err) {
      ChartDownloader.lastDiskSpaceResult = false
    }

    ChartDownloader.lastDiskSpaceCheck = now
    return ChartDownloader.lastDiskSpaceResult
  }

  static getStatistics() {
    return Object.fromEntries(ChartDownloader.CacheStatistics)
  }
}
