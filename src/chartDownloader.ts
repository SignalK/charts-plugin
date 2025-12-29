import path from 'path'
import type { BBox } from 'geojson'
import checkDiskSpace from 'check-disk-space'
import { ChartProvider } from './types'
import {
  Tile,
  convertFeatureToGeoJSON,
  estimateTilesForGeoJSON,
  getTilesForBBox,
  getTilesForGeoJSON,
  TileGeneratorFactory,
  countTiles
} from './chartDownloaderTileHelpers'

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
}

export class ChartDownloader {
  private static MINIMUM_FREE_DISK_SPACE = 1024 * 1024 * 1024 // 1 GB
  private static nextJobId = 1
  private static CachingDisabled = false
  private static CacheStatistics: Map<string, CacheStatistic> = new Map()
  private static TilesCached = 0

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
    this.tilesInDB = () =>
      getMBTilesForPolygon(
        this.provider._mbtilesHandle._db,
        geojson,
        minZoom,
        maxZoom
      )
    this.totalTiles = estimateTilesForGeoJSON(geojson, minZoom, maxZoom)
    if (this.totalTiles < 10000) {
      this.totalTiles = countTiles(this.tiles, 11000)
    }
    this.state = State.Stopped
    this.regionName = feature?.properties?.name ?? 'Unnamed'
    this.areaDescription = `Region: ${this.regionName}`
  }

  public async initializeJobFromBBox(
    bbox: BBox,
    minZoom: number,
    maxZoom: number
  ): Promise<void> {
    this.tiles = () => getTilesForBBox(bbox, minZoom, maxZoom)

    this.state = State.Stopped
    this.areaDescription = `BBox: [${bbox
      .map((v) => Number(v).toFixed(3))
      .join(', ')}]`
  }

  /**
   * Download map tiles for a specific area.
   */
  async seedCache(): Promise<void> {
    const concurrency = 32
    this.cancelRequested = false
    this.state = State.Running
    this.downloadedTiles = 0
    this.cachedTiles = 0
    this.failedTiles = 0
    this.type = JobType.Seed
    let tileCounter = 0

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
        const current = ++tileCounter
        if (current % 1000 === 0) {
          const hasSpace = await ChartDownloader.hasDiskSpace(this.cachePath)
          if (!hasSpace) {
            this.state = State.Stopped
            this.cancelRequested = true
            return
          }
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
          if (
            this.totalTiles <
            this.downloadedTiles + this.failedTiles + this.cachedTiles
          ) {
            this.totalTiles =
              this.downloadedTiles + this.failedTiles + this.cachedTiles
          }
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
      const mbtiles = await openOrCreateMbtiles(
        path.join(
          this.cachePath,
          'mbtiles',
          `${this.regionName}_${this.provider.identifier}.mbtiles`
        ),
        this.provider
      )
      const iterator = this.tiles()
      for (const tile of iterator) {
        const buffer = await ChartDownloader.getTileFromMbTiles(
          this.provider._mbtilesHandle,
          tile
        )
        if (buffer) {
          await ChartDownloader.cacheTileToMbTiles(mbtiles, tile, buffer)
        }
      }
      mbtiles._db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    }
    this.status = 'Completed'
  }

  async deleteCache(): Promise<void> {
    this.state = State.Running
    this.deletedTiles = 0
    this.type = JobType.Delete
    this.status = 'Deleting tiles'
    await deleteTilesInChunks(
      this.provider._mbtilesHandle._db,
      this.tilesInDB(),
      1000,
      (deleted) => {
        console.log(`Deleted ${deleted} / ${this.totalTiles}`)
      }
    )
    this.status = 'Purging orphaned images'
    await purgeAllOrphanImages(
      this.provider._mbtilesHandle._db,
      1000,
      (deleted, totalDeleted) => {
        this.deletedTiles += deleted
        console.log(
          `Purged ${totalDeleted} orphaned images (last chunk ${deleted})`
        )
      }
    )
    if (this.options.vacuum) {
      this.status = 'Vacuuming MBTiles database'
      vacuumMbtiles(this.provider._mbtilesHandle._db)
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
        provider._mbtilesHandle,
        tile
      )
      if (mbtilesBuffer) {
        stats.hits++
        return { buffer: mbtilesBuffer, source: TileSource.FetchedFromCache }
      }
    }

    // Cache miss: fetch from remote
    const buffer = await ChartDownloader.fetchTileFromRemote(provider, tile)
    if (
      !ChartDownloader.CachingDisabled &&
      ChartDownloader.TilesCached % 1000 === 0 &&
      !(await ChartDownloader.hasDiskSpace(chartsPath))
    ) {
      ChartDownloader.CachingDisabled = true
      console.warn(`Disabling tilemap caching due to low disk space.`)
    }
    if (!ChartDownloader.CachingDisabled && buffer) {
      stats.misses++
      //Writing to mbtiles must be awaited
      await ChartDownloader.cacheTileToMbTiles(
        provider._mbtilesHandle,
        tile,
        buffer
      )
      return { buffer, source: TileSource.FetchedFromRemote }
    }
    stats.failures++
    return { buffer: null, source: TileSource.None }
  }

  static async getTileFromMbTiles(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mbtilesHandle: any,
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
            (err: Error, data: Buffer) => {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mbtilesHandle: any,
    tile: Tile,
    buffer: Buffer | null
  ): Promise<void> {
    if (buffer && !ChartDownloader.CachingDisabled) {
      try {
        await new Promise<void>((resolve, reject) => {
          mbtilesHandle.putTile(
            tile.z,
            tile.x,
            tile.y,
            buffer,
            (err: Error) => {
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
    if (!provider.remoteUrl) {
      console.error(`No remote URL defined for provider ${provider.name}`)
      return null
    }
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

  static async hasDiskSpace(path: string): Promise<boolean> {
    try {
      const { free } = await checkDiskSpace(path)
      if (free < ChartDownloader.MINIMUM_FREE_DISK_SPACE) {
        return false
      }
    } catch (err) {
      return false
    }

    return true
  }

  static getStatistics() {
    return Object.fromEntries(ChartDownloader.CacheStatistics)
  }
}
