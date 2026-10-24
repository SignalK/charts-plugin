import { parentPort } from 'node:worker_threads'
import type { MBTilesHandle, MBTilesMetadata } from './types'
import {
  deleteTilesInChunks,
  getMBTilesForPolygon,
  openOrCreateMbtiles,
  openReadOnlyMbtiles,
  purgeAllOrphanImages,
  vacuumMbtiles
} from './chartDownloaderMBTilesHelpers'
import { getTilesForGeoJSON } from './chartDownloaderTileHelpers'
import type {
  OpenResult,
  SerializedError,
  TileCacheRequest,
  TileCacheResponse,
  TileResult
} from './tileCacheProtocol'

if (!parentPort) {
  throw new Error('Tile cache worker must run in a worker thread')
}

const port = parentPort

interface HandleEntry {
  providerId: string
  handle: MBTilesHandle
}

const handles = new Map<string, HandleEntry>()
let nextHandleId = 1
let queue: Promise<void> = Promise.resolve()

const send = (message: TileCacheResponse): void => {
  port.postMessage(message)
}

const serializeError = (error: unknown): SerializedError => {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      message: error.message,
      name: error.name,
      ...(code ? { code } : {})
    }
  }
  return { message: String(error) }
}

const entryFor = (handleId: string): HandleEntry => {
  const entry = handles.get(handleId)
  if (!entry) {
    throw new Error(`Unknown tile cache handle ${handleId}`)
  }
  return entry
}

const dbFor = (handleId: string) => {
  const { handle } = entryFor(handleId)
  if (!handle._db) {
    throw new Error(`Tile cache handle ${handleId} has no SQLite database`)
  }
  return handle._db
}

const readTile = (
  handle: MBTilesHandle,
  z: number,
  x: number,
  y: number
): Promise<TileResult | null> =>
  new Promise((resolve, reject) => {
    handle.getTile(z, x, y, (err, tile, headers) => {
      if (err) {
        if (err.message?.includes('Tile does not exist')) {
          resolve(null)
          return
        }
        reject(err)
        return
      }
      if (!tile) {
        resolve(null)
        return
      }
      resolve({
        data: new Uint8Array(tile),
        headers: headers as TileResult['headers']
      })
    })
  })

const writeTile = (
  handle: MBTilesHandle,
  z: number,
  x: number,
  y: number,
  data: Uint8Array
): Promise<void> =>
  new Promise((resolve, reject) => {
    handle.putTile(z, x, y, Buffer.from(data), (err) => {
      if (err) reject(err)
      else resolve()
    })
  })

const readInfo = (handle: MBTilesHandle): Promise<MBTilesMetadata> =>
  new Promise((resolve, reject) => {
    handle.getInfo((err, metadata) => {
      if (err) reject(err)
      else resolve(metadata)
    })
  })

const startWriting = (handle: MBTilesHandle): Promise<void> =>
  new Promise((resolve, reject) => {
    handle.startWriting((err) => {
      if (err) reject(err)
      else resolve()
    })
  })

const writeInfo = (
  handle: MBTilesHandle,
  info: MBTilesMetadata
): Promise<void> =>
  new Promise((resolve, reject) => {
    handle.putInfo(info, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })

const closeHandle = (handle: MBTilesHandle): Promise<void> =>
  new Promise((resolve, reject) => {
    handle.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })

const flushHandle = (handle: MBTilesHandle): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!handle._commit) {
      resolve()
      return
    }
    handle._commit((err) => {
      if (err) reject(err)
      else resolve()
    })
  })

const processRequest = async (request: TileCacheRequest): Promise<void> => {
  try {
    switch (request.method) {
      case 'open': {
        const handle =
          request.mode === 'rw'
            ? await openOrCreateMbtiles(
                request.path,
                request.info ?? { name: request.providerId }
              )
            : await openReadOnlyMbtiles(request.path)
        const handleId = `${request.providerId}#${nextHandleId++}`
        handles.set(handleId, { providerId: request.providerId, handle })
        handle.on('error', (error) => {
          send({
            kind: 'dbError',
            handleId,
            providerId: request.providerId,
            message: error.message
          })
        })
        const info = await readInfo(handle).catch(() => undefined)
        const result: OpenResult = {
          handleId,
          ...(info ? { info } : {})
        }
        send({ kind: 'result', id: request.id, value: result })
        return
      }
      case 'getTile': {
        const { handle } = entryFor(request.handleId)
        send({
          kind: 'result',
          id: request.id,
          value: await readTile(handle, request.z, request.x, request.y)
        })
        return
      }
      case 'putTile': {
        const { handle } = entryFor(request.handleId)
        await writeTile(handle, request.z, request.x, request.y, request.data)
        send({ kind: 'result', id: request.id })
        return
      }
      case 'getInfo': {
        const { handle } = entryFor(request.handleId)
        send({
          kind: 'result',
          id: request.id,
          value: await readInfo(handle)
        })
        return
      }
      case 'startWriting': {
        const { handle } = entryFor(request.handleId)
        await startWriting(handle)
        send({ kind: 'result', id: request.id })
        return
      }
      case 'putInfo': {
        const { handle } = entryFor(request.handleId)
        await writeInfo(handle, request.info)
        send({ kind: 'result', id: request.id })
        return
      }
      case 'close': {
        const { handle } = entryFor(request.handleId)
        await flushHandle(handle)
        await closeHandle(handle)
        handles.delete(request.handleId)
        send({ kind: 'result', id: request.id })
        return
      }
      case 'deleteTilesInPolygon': {
        await flushHandle(entryFor(request.handleId).handle)
        const db = dbFor(request.handleId)
        const tiles = getMBTilesForPolygon(
          db,
          request.geojson,
          request.minZoom,
          request.maxZoom
        )
        await deleteTilesInChunks(db, tiles, request.chunkSize, (deleted) => {
          send({ kind: 'progress', id: request.id, done: deleted })
        })
        send({ kind: 'result', id: request.id })
        return
      }
      case 'purgeOrphanImages': {
        await flushHandle(entryFor(request.handleId).handle)
        const db = dbFor(request.handleId)
        const total = await purgeAllOrphanImages(
          db,
          request.chunkSize,
          (deleted, totalDeleted) => {
            send({
              kind: 'progress',
              id: request.id,
              done: totalDeleted,
              chunk: deleted
            })
          }
        )
        send({ kind: 'result', id: request.id, value: total })
        return
      }
      case 'vacuum': {
        await flushHandle(entryFor(request.handleId).handle)
        vacuumMbtiles(dbFor(request.handleId))
        send({ kind: 'result', id: request.id })
        return
      }
      case 'checkpoint': {
        const { handle } = entryFor(request.handleId)
        await flushHandle(handle)
        dbFor(request.handleId).exec('PRAGMA wal_checkpoint(TRUNCATE)')
        send({ kind: 'result', id: request.id })
        return
      }
      case 'flush': {
        const { handle } = entryFor(request.handleId)
        await flushHandle(handle)
        send({ kind: 'result', id: request.id })
        return
      }
      case 'copyRegion': {
        const source = entryFor(request.sourceHandleId).handle
        const dest = entryFor(request.destHandleId).handle
        await flushHandle(source)
        let copied = 0
        for (const tile of getTilesForGeoJSON(
          request.geojson,
          request.minZoom,
          request.maxZoom
        )) {
          const buffer = await readTile(source, tile.z, tile.x, tile.y)
          if (buffer) {
            await writeTile(dest, tile.z, tile.x, tile.y, buffer.data)
            copied++
            if (copied % 100 === 0) {
              send({ kind: 'progress', id: request.id, done: copied })
            }
          }
        }
        await flushHandle(dest)
        send({ kind: 'result', id: request.id, value: copied })
        return
      }
      case 'shutdown': {
        for (const [handleId, { handle }] of handles) {
          try {
            await closeHandle(handle)
          } catch {
            // Closing is best effort during shutdown; the worker is about to
            // terminate and the process is exiting anyway.
          }
          handles.delete(handleId)
        }
        send({ kind: 'result', id: request.id })
        return
      }
    }
  } catch (error) {
    send({
      kind: 'error',
      id: request.id,
      error: serializeError(error)
    })
  }
}

port.on('message', (request: TileCacheRequest) => {
  queue = queue.then(() => processRequest(request))
})
