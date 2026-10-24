import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import type { FeatureCollection } from 'geojson'
import type { MBTilesMetadata, TileStoreHandle } from './types'
import type {
  OpenInfo,
  OpenMode,
  OpenResult,
  SerializedError,
  TileCacheRequest,
  TileCacheResponse,
  TileResult
} from './tileCacheProtocol'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

type RequestInput = DistributiveOmit<TileCacheRequest, 'id'>

type ProgressCallback = (done: number, total?: number, chunk?: number) => void

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress?: ProgressCallback
}

const toError = (error: SerializedError): Error => {
  const result = new Error(error.message)
  result.name = error.name ?? 'Error'
  if (error.code) {
    ;(result as NodeJS.ErrnoException).code = error.code
  }
  return result
}

const resolveWorkerPath = (): string => {
  const compiled = path.join(__dirname, 'tileCacheWorker.js')
  if (fs.existsSync(compiled)) return compiled
  const source = path.join(__dirname, 'tileCacheWorker.ts')
  if (fs.existsSync(source)) return source
  throw new Error('Unable to locate the tile cache worker entry point')
}

export class WorkerMBTilesHandle
  extends EventEmitter
  implements TileStoreHandle
{
  constructor(
    private readonly client: TileCacheClient,
    readonly handleId: string,
    readonly providerId: string
  ) {
    super()
  }

  private call<T>(
    request: RequestInput,
    onProgress?: ProgressCallback
  ): Promise<T> {
    return this.client.call<T>(request, onProgress)
  }

  putTile(
    z: number,
    x: number,
    y: number,
    tile: Buffer,
    callback: (err: Error | null) => void
  ): void {
    this.call<void>({
      method: 'putTile',
      handleId: this.handleId,
      z,
      x,
      y,
      data: tile
    }).then(
      () => callback(null),
      (error: Error) => callback(error)
    )
  }

  startWriting(callback: (err: Error | null) => void): void {
    this.call<void>({ method: 'startWriting', handleId: this.handleId }).then(
      () => callback(null),
      (error: Error) => callback(error)
    )
  }

  putInfo(info: MBTilesMetadata, callback: (err: Error | null) => void): void {
    this.call<void>({
      method: 'putInfo',
      handleId: this.handleId,
      info
    }).then(
      () => callback(null),
      (error: Error) => callback(error)
    )
  }

  getTile(
    z: number,
    x: number,
    y: number,
    callback: (
      err: Error | null,
      tile: Buffer,
      headers: Record<string, string | number | string[]>
    ) => void
  ): void {
    this.call<TileResult | null>({
      method: 'getTile',
      handleId: this.handleId,
      z,
      x,
      y
    }).then(
      (result) => {
        if (result) {
          callback(null, Buffer.from(result.data), result.headers)
        } else {
          callback(new Error('Tile does not exist'), Buffer.alloc(0), {})
        }
      },
      (error: Error) => callback(error, Buffer.alloc(0), {})
    )
  }

  getInfo(
    callback: (err: Error | null, metadata: MBTilesMetadata) => void
  ): void {
    this.call<MBTilesMetadata>({
      method: 'getInfo',
      handleId: this.handleId
    }).then(
      (metadata) => callback(null, metadata),
      (error: Error) => callback(error, {})
    )
  }

  close(callback?: (err: Error | null) => void): void {
    this.call<void>({ method: 'close', handleId: this.handleId }).then(
      () => {
        this.client.forget(this.handleId)
        callback?.(null)
      },
      (error: Error) => callback?.(error)
    )
  }

  deleteTilesInPolygon(
    geojson: FeatureCollection,
    minZoom: number,
    maxZoom: number,
    chunkSize: number,
    onProgress?: (deleted: number) => void
  ): Promise<void> {
    return this.call<void>(
      {
        method: 'deleteTilesInPolygon',
        handleId: this.handleId,
        geojson,
        minZoom,
        maxZoom,
        chunkSize
      },
      (done) => onProgress?.(done)
    )
  }

  purgeOrphanImages(
    chunkSize: number,
    onProgress?: (deleted: number, total: number) => void
  ): Promise<number> {
    return this.call<number>(
      {
        method: 'purgeOrphanImages',
        handleId: this.handleId,
        chunkSize
      },
      (done, _total, chunk) => onProgress?.(chunk ?? done, done)
    )
  }

  vacuum(): Promise<void> {
    return this.call<void>({ method: 'vacuum', handleId: this.handleId })
  }

  checkpoint(): Promise<void> {
    return this.call<void>({ method: 'checkpoint', handleId: this.handleId })
  }

  flush(): Promise<void> {
    return this.call<void>({ method: 'flush', handleId: this.handleId })
  }

  copyRegion(
    dest: TileStoreHandle,
    geojson: FeatureCollection,
    minZoom: number,
    maxZoom: number,
    onProgress?: (done: number, total: number) => void
  ): Promise<number> {
    if (!(dest instanceof WorkerMBTilesHandle)) {
      return Promise.reject(
        new Error('copyRegion requires a worker-backed destination handle')
      )
    }
    return this.call<number>(
      {
        method: 'copyRegion',
        sourceHandleId: this.handleId,
        destHandleId: dest.handleId,
        geojson,
        minZoom,
        maxZoom
      },
      (done) => onProgress?.(done, 0)
    )
  }

  openSibling(filePath: string, info: OpenInfo): Promise<WorkerMBTilesHandle> {
    return this.client.open(`${this.providerId}:export`, filePath, 'rw', info)
  }
}

export class TileCacheClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private readonly handles = new Map<string, WorkerMBTilesHandle>()
  private nextId = 1
  private failed: Error | undefined
  private closing = false
  readonly ready: Promise<void>

  constructor() {
    const workerPath = resolveWorkerPath()
    const execArgv = workerPath.endsWith('.ts')
      ? ['--require', require.resolve('tsx/cjs')]
      : []
    this.worker = new Worker(workerPath, { execArgv })

    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.once('online', resolve)
      this.worker.once('error', reject)
    })
    this.ready.catch(() => undefined)

    this.worker.on('message', (message: TileCacheResponse) => {
      this.receive(message)
    })
    this.worker.on('error', (error: Error) => {
      this.fail(error)
    })
    this.worker.on('exit', (code) => {
      if (!this.closing) {
        this.fail(new Error(`Tile cache worker exited with code ${code}`))
      }
    })
  }

  open(
    providerId: string,
    filePath: string,
    mode: OpenMode,
    info?: OpenInfo
  ): Promise<WorkerMBTilesHandle> {
    return this.call<OpenResult>({
      method: 'open',
      providerId,
      path: filePath,
      mode,
      ...(info ? { info } : {})
    }).then((result) => {
      const handle = new WorkerMBTilesHandle(this, result.handleId, providerId)
      this.handles.set(result.handleId, handle)
      return handle
    })
  }

  call<T>(request: RequestInput, onProgress?: ProgressCallback): Promise<T> {
    if (this.failed) {
      return Promise.reject(this.failed)
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress
      })
      this.worker.postMessage({ ...request, id })
    })
  }

  forget(handleId: string): void {
    this.handles.delete(handleId)
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    try {
      await this.call<void>({ method: 'shutdown' })
    } catch {
      // The worker may already have failed; terminating below is enough.
    }
    await this.worker.terminate()
  }

  private receive(message: TileCacheResponse): void {
    if (message.kind === 'dbError') {
      const handle = this.handles.get(message.handleId)
      handle?.emit('error', new Error(message.message))
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.kind === 'progress') {
      pending.onProgress?.(message.done, message.total, message.chunk)
      return
    }
    this.pending.delete(message.id)
    if (message.kind === 'result') {
      pending.resolve(message.value)
    } else {
      pending.reject(toError(message.error))
    }
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = error
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export class TileCache {
  private client: TileCacheClient | undefined

  async start(): Promise<boolean> {
    if (process.env.SK_CHARTS_DISABLE_TILE_WORKER === '1') {
      return false
    }
    try {
      const client = new TileCacheClient()
      await client.ready
      this.client = client
      return true
    } catch (error) {
      console.warn(
        `Signal K Charts: tile cache worker unavailable, using the main thread: ${
          (error as Error).message
        }`
      )
      this.client = undefined
      return false
    }
  }

  get enabled(): boolean {
    return this.client !== undefined
  }

  open(
    providerId: string,
    filePath: string,
    mode: OpenMode,
    info?: OpenInfo
  ): Promise<WorkerMBTilesHandle> {
    if (!this.client) {
      return Promise.reject(new Error('Tile cache worker is not running'))
    }
    return this.client.open(providerId, filePath, mode, info)
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    await client?.close()
  }
}
