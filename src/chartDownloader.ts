import path from 'path'
import type { DatabaseSync } from 'node:sqlite'
import type { BBox } from 'geojson'
import checkDiskSpace from 'check-disk-space'
import { ChartProvider, MBTilesHandle } from './types'
import { lonLatToMercator, tileToBBox } from './projection'
import { exportMbtilesPath, EXPORTS_DIR } from './cacheLayout'

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

// Categorised failure kinds for tile fetches. Lets the worker keep
// per-job counts so an admin staring at "500000 failed" can tell whether
// the upstream is timing out, the auth is wrong, or the network is gone.
// Used in TileFetchResult.failure and surfaced via job.info().failures.
export enum FailureKind {
  None = 'none',
  Timeout = 'timeout',
  HttpClient = 'http_4xx',
  HttpServer = 'http_5xx',
  Network = 'network',
  NoRemoteUrl = 'no_remote_url'
}

export interface TileFetchFailure {
  kind: FailureKind
  status?: number
}

export interface TileFetchResult {
  buffer: Buffer | null
  source: TileSource
  failure?: TileFetchFailure
}

// Per-job failure-cause histogram. Keyed by FailureKind so a stalled
// progress bar in the UI can show "1234 timeouts, 5 auth, 200 5xx"
// instead of an undifferentiated count. Aggregated by the seed worker.
export type FailureCounts = Partial<Record<FailureKind, number>>

// Default tile-fetch timeout. Bumped from 5s to 10s — some legitimate
// tile providers (NOAA WMS, custom inland-water sources) take 5-15s on
// a cold-cache backend tile and a 5s default marked them as failures.
// Per-provider override available via OnlineChartProvider.timeoutMs and
// TokenProviderConfig.tile.timeoutMs (added on the same change).
const TILE_FETCH_TIMEOUT_MS = 10000
// Default backoff before a single retry on a transient 5xx (502/503).
// Picked to be long enough that an upstream momentary blip clears, short
// enough that 32 workers don't all stall on a hard outage. Configurable
// at runtime via ChartDownloader.tileRetryBackoffMs (test harness sets
// it to 0 to keep mocked-503 tests fast).
const DEFAULT_TILE_RETRY_BACKOFF_MS = 1500

export class ChartSeedingManager {
  public static ActiveJobs: { [key: number]: ChartDownloader } = {}

  /**
   * Reset all module-level static state owned by ChartSeedingManager and
   * ChartDownloader so a test harness can run from a known baseline.
   *
   * The plugin's static fields outlive a `stop()` / `start()` cycle in
   * production (which is intended — process-global gates and ID sequences),
   * but in a test process running 200+ tests in sequence the residue
   * shows up as cross-test interference: nextJobId drifts upward, an
   * earlier low-disk-space probe leaves CachingEnabled=false for 2s,
   * stale CacheStatistics from one provider get seen by an unrelated
   * test asserting "stats are an object".
   *
   * Production code never calls this. The test app's beforeEach does.
   */
  public static resetForTests(): void {
    this.ActiveJobs = {}
    ChartDownloader.resetForTests()
  }

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
  // See DEFAULT_TILE_RETRY_BACKOFF_MS. Public so the test harness can drop
  // it to 0; production code should treat it as read-only.
  public static tileRetryBackoffMs: number = DEFAULT_TILE_RETRY_BACKOFF_MS

  private id: number = ChartDownloader.nextJobId++

  private type: JobType = JobType.None
  private state: State = State.Stopped
  private status = 'Idle'
  private totalTiles = 0
  private downloadedTiles = 0
  private failedTiles = 0
  private cachedTiles = 0
  private deletedTiles = 0

  // Per-job failure histogram, keyed by FailureKind. Surfaced via
  // info().failures so the UI / admin can tell timeouts apart from
  // 5xx apart from auth failures without grepping logs. Only the
  // first failure of each kind is logged in detail (sampleLogged)
  // so a job with 500k failed tiles doesn't drown the log buffer.
  private failureCounts: FailureCounts = {}
  private sampleLogged: Set<FailureKind> = new Set()

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
    this.failureCounts = {}
    this.sampleLogged = new Set()
    this.type = JobType.Seed
    console.log(
      `[charts-plugin] job ${this.id} started seeding ` +
        `provider=${this.provider.identifier} ` +
        `area="${this.areaDescription}" totalTiles=${this.totalTiles}`
    )

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
            const kind = result.failure?.kind ?? FailureKind.Network
            this.failureCounts[kind] = (this.failureCounts[kind] ?? 0) + 1
            // Log the first instance of each failure kind in this job —
            // gives an operator something to grep for ("job 42 timeout
            // first at z=12 x=2057 y=1364 status=undefined") without
            // 500k log lines if every tile fails.
            if (!this.sampleLogged.has(kind)) {
              this.sampleLogged.add(kind)
              console.warn(
                `[charts-plugin] job ${this.id} ` +
                  `provider=${this.provider.identifier} ` +
                  `first ${kind} failure at z=${tile.z} x=${tile.x} y=${tile.y}` +
                  (result.failure?.status
                    ? ` status=${result.failure.status}`
                    : '')
              )
            }
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
          const msg = (err as Error).message ?? String(err)
          this.failureCounts[FailureKind.Network] =
            (this.failureCounts[FailureKind.Network] ?? 0) + 1
          if (!this.sampleLogged.has(FailureKind.Network)) {
            this.sampleLogged.add(FailureKind.Network)
            console.warn(
              `[charts-plugin] job ${this.id} ` +
                `provider=${this.provider.identifier} ` +
                `first uncaught failure at z=${tile.z} x=${tile.x} y=${tile.y}: ${msg}`
            )
          }
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
      // Snapshot exports go to ${cachePath}/exports/, which is excluded from
      // the chart scanner — the file is a build artifact for offline transfer
      // (USB stick to another SK server), not a chart the running plugin
      // serves. Re-running the job overwrites the file freely; no scanner
      // handle holds it open.
      const baseDir = path.resolve(this.cachePath, EXPORTS_DIR)
      const filePath = path.resolve(
        exportMbtilesPath(
          this.cachePath,
          safeRegionName,
          this.provider.identifier
        )
      )

      // Same separator-aware check as the migrate endpoint: a naive
      // startsWith would miss sibling-directory prefix collisions.
      if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
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
    console.log(
      `[charts-plugin] job ${this.id} completed ` +
        `provider=${this.provider.identifier} ` +
        `downloaded=${this.downloadedTiles} cached=${this.cachedTiles} ` +
        `failed=${this.failedTiles} ` +
        `failures=${JSON.stringify(this.failureCounts)}`
    )
  }

  async deleteCache(): Promise<void> {
    this.state = State.Running
    this.deletedTiles = 0
    this.type = JobType.Delete
    this.status = 'Deleting tiles'
    console.log(
      `[charts-plugin] job ${this.id} delete started ` +
        `provider=${this.provider.identifier} totalTiles=${this.totalTiles}`
    )
    const db = requireMbtilesDb(this.provider)
    await deleteTilesInChunks(db, this.tilesInDB(), 1000, (deleted) => {
      console.log(
        `[charts-plugin] job ${this.id} deleted ${deleted} / ${this.totalTiles}`
      )
    })
    this.status = 'Purging orphaned images'
    await purgeAllOrphanImages(db, 1000, (deleted, totalDeleted) => {
      this.deletedTiles += deleted
      console.log(
        `[charts-plugin] job ${this.id} purged ${totalDeleted} orphans ` +
          `(last chunk ${deleted})`
      )
    })
    if (this.options.vacuum) {
      this.status = 'Vacuuming MBTiles database'
      vacuumMbtiles(db)
    }
    this.status = 'Completed'
    this.state = State.Stopped
    console.log(
      `[charts-plugin] job ${this.id} delete completed ` +
        `provider=${this.provider.identifier} ` +
        `deletedTiles=${this.deletedTiles}`
    )
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
      // Per-failure-kind histogram. Empty {} for jobs with no failures.
      // Surfaced so the UI / admin can see "1234 timeouts, 5 auth, 200 5xx"
      // instead of an undifferentiated failedTiles count.
      failures: { ...this.failureCounts },
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
    const { buffer, failure } =
      await ChartDownloader.fetchTileFromRemoteDetailed(provider, tile)
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
      return {
        buffer,
        source: TileSource.FetchedFromRemote,
        failure: { kind: FailureKind.None }
      }
    }
    stats.failures++
    return { buffer: null, source: TileSource.None, failure }
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

  /**
   * Detailed-result variant of fetchTileFromRemote. Returns the buffer on
   * success and a `failure` discriminator on every other path so the
   * caller can attribute "failed" tiles to a specific cause (timeout vs
   * 5xx vs network) for diagnostic logs and per-job counters.
   *
   * Retries once on 502/503 with TILE_RETRY_BACKOFF_MS backoff: those are
   * the response codes that genuinely benefit from one more try (LB hiccup,
   * backend cold-start). 504 is excluded because it means the upstream
   * already waited; another wait makes the per-tile latency intolerable.
   * 4xx are not retried (auth or "tile genuinely doesn't exist" — neither
   * gets better by trying again).
   */
  static async fetchTileFromRemoteDetailed(
    provider: ChartProvider,
    tile: Tile,
    timeoutMs: number = TILE_FETCH_TIMEOUT_MS
  ): Promise<{ buffer: Buffer | null; failure: TileFetchFailure }> {
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
      return { buffer: null, failure: { kind: FailureKind.NoRemoteUrl } }
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

    let lastFailure: TileFetchFailure = { kind: FailureKind.Network }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((r) =>
          setTimeout(r, ChartDownloader.tileRetryBackoffMs)
        )
      }
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(url, {
          headers: provider.headers,
          signal: controller.signal
        })
        // Clear the abort timer as soon as the response head is in. A long
        // body read was otherwise racing the timeout and could be aborted
        // mid-stream while the caller waited on arrayBuffer().
        clearTimeout(timeoutId)
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer()
          return {
            buffer: Buffer.from(arrayBuffer),
            failure: { kind: FailureKind.None }
          }
        }
        // For token providers, an upstream 401/403 most likely means the
        // cached token has expired or been revoked. Invalidate so the next
        // fetch refreshes it. 5xx and other non-auth errors don't trigger
        // this — they're not about credentials.
        if (
          (response.status === 401 || response.status === 403) &&
          provider._tokenProvider
        ) {
          provider._tokenProvider.invalidateToken()
        }
        const kind =
          response.status >= 500
            ? FailureKind.HttpServer
            : FailureKind.HttpClient
        lastFailure = { kind, status: response.status }
        // Retry only on 502/503 — those are the LB/backend-blip codes
        // worth a second try. 504 already implies a long wait upstream;
        // 4xx won't change on retry.
        if (response.status === 502 || response.status === 503) continue
        return { buffer: null, failure: lastFailure }
      } catch (err) {
        clearTimeout(timeoutId)
        // AbortError vs other network errors: the timeout's controller.abort
        // throws an AbortError. Treat any other thrown error as Network.
        const isAbort =
          (err as { name?: string }).name === 'AbortError' ||
          controller.signal.aborted
        lastFailure = {
          kind: isAbort ? FailureKind.Timeout : FailureKind.Network
        }
        // Don't retry on timeout (already slow) or generic network error
        // (likely DNS/route failure — won't recover in 1.5s).
        return { buffer: null, failure: lastFailure }
      }
    }
    return { buffer: null, failure: lastFailure }
  }

  /**
   * Backwards-compatible wrapper for callers that only need the buffer.
   * Internal callers should prefer fetchTileFromRemoteDetailed for the
   * categorised failure information.
   */
  static async fetchTileFromRemote(
    provider: ChartProvider,
    tile: Tile,
    timeoutMs: number = TILE_FETCH_TIMEOUT_MS
  ): Promise<Buffer | null> {
    const { buffer } = await ChartDownloader.fetchTileFromRemoteDetailed(
      provider,
      tile,
      timeoutMs
    )
    return buffer
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

  /**
   * Reset the static fields owned by ChartDownloader. See
   * ChartSeedingManager.resetForTests for why this exists.
   */
  static resetForTests(): void {
    ChartDownloader.nextJobId = 1
    ChartDownloader.CachingEnabled = true
    ChartDownloader.CacheStatistics = new Map()
    ChartDownloader.TilesCached = 0
    ChartDownloader.lastDiskSpaceCheck = 0
    ChartDownloader.lastDiskSpaceResult = true
    // Skip the production 1.5s backoff for mocked-503 tests; production
    // value is restored per the constant on plugin reload.
    ChartDownloader.tileRetryBackoffMs = 0
  }
}
