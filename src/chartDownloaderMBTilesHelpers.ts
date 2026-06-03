import { mkdirSync } from 'fs'
import path from 'path'
import {
  ChartProvider,
  OnlineChartProvider,
  MBTilesHandle,
  MBTilesMetadata
} from './types'
import type { FeatureCollection, Polygon, Feature } from 'geojson'
import { bbox } from '@turf/bbox'
import booleanIntersects from '@turf/boolean-intersects'
import {
  Tile,
  lonLatToTileXY,
  tileToBBox,
  bboxPolygon
} from './chartDownloaderTileHelpers'
import type { DatabaseSync } from 'node:sqlite'

// @signalk/mbtiles is loaded lazily because it `require('node:sqlite')` at its
// own module top level, which throws ERR_UNKNOWN_BUILTIN_MODULE on Node < 22.
// A static import here would run that require the moment index.ts is loaded —
// before the plugin's Node-version guard can show the user a helpful message.
// Deferring it to first use lets the guard run first. charts.ts loads the same
// library the same way for the same reason.
type MBTilesConstructor = new (
  file: string,
  callback: (err: Error | null, mbtiles: MBTilesHandle) => void
) => MBTilesHandle

let MBTiles: MBTilesConstructor | null = null

async function loadMBTiles(): Promise<MBTilesConstructor> {
  if (MBTiles === null) {
    const module = await import('@signalk/mbtiles')
    MBTiles = (module.default || module) as unknown as MBTilesConstructor
  }
  return MBTiles
}

type TileRow = {
  tile_column: number
  tile_row: number
}

export async function openOrCreateMbtiles(
  mbtilesPath: string,
  provider: OnlineChartProvider | ChartProvider
): Promise<MBTilesHandle> {
  mkdirSync(path.dirname(mbtilesPath), { recursive: true })
  const MBTilesCtor = await loadMBTiles()

  return new Promise((resolve, reject) => {
    new MBTilesCtor(
      `${mbtilesPath}?mode=rwc`,
      (err: Error | null, mbtiles: MBTilesHandle) => {
        if (err) {
          return reject(err)
        }
        // MBTiles is an EventEmitter over a raw sqlite handle. Without an
        // 'error' listener a runtime DB error (ENOSPC/EIO on an SD card mid
        // write) is an unhandled 'error' event, which crashes the process.
        // Demote it to a log so a flaky write surface can't take the server
        // down. Attached before startWriting so an error during open is caught.
        mbtiles.on('error', (e: Error) => {
          console.error(
            `MBTiles write handle error (${mbtilesPath}):`,
            e.message
          )
        })
        mbtiles.startWriting((err: Error | null) => {
          if (err) {
            return reject(err)
          }
          mbtiles._db?.exec('PRAGMA journal_mode = WAL')
          mbtiles._db?.exec('PRAGMA synchronous = NORMAL')
          mbtiles._db?.exec('PRAGMA temp_store = MEMORY')
          // NORMAL locking_mode rather than EXCLUSIVE: WAL + single-writer
          // already serialises us, and EXCLUSIVE blocks any second connection
          // attempt — including a plugin reload that races a previous
          // connection's close on the same file (which happens in tests
          // running mocha serially, and in production on a quick disable/
          // enable cycle).
          mbtiles._db?.exec('PRAGMA locking_mode = NORMAL')
          mbtiles._db?.exec('PRAGMA cache_size = -20000') // ~20MB RAM cache
          mbtiles._db?.exec('PRAGMA page_size = 4096')
          mbtiles._db?.exec('PRAGMA mmap_size = 268435456') // 256MB mmap if supported
          mbtiles._db?.exec('PRAGMA auto_vacuum = FULL')

          const entries: [string, string][] = [
            ['name', provider.name],
            ['type', 'tileLayer'],
            ['version', '1.0'],
            ['format', provider.format ? provider.format : 'png'],
            ['minzoom', String(provider.minzoom)],
            ['maxzoom', String(provider.maxzoom)]
            // ['bounds', bbox.map(n => n.toFixed(7)).join(',')]
          ]

          const metadata: MBTilesMetadata = Object.fromEntries(entries)

          mbtiles.putInfo(metadata, (err: Error | null) => {
            if (err) {
              return reject(err)
            }
            resolve(mbtiles)
          })
        })
      }
    )
  })
}

export function* getMBTilesForPolygon(
  db: DatabaseSync,
  geojson: FeatureCollection,
  zoomMin = 1,
  zoomMax = 14
): Generator<Tile, void, undefined> {
  // Prepared statement is identical across the per-feature / per-zoom loops;
  // the bind values change but the SQL text doesn't. Hoisted so we don't
  // pay sqlite's prepare cost once per zoom level (~14× per call before).
  const stmt = db.prepare(`
    SELECT tile_column, tile_row
    FROM map
    WHERE zoom_level = ?
      AND tile_column BETWEEN ? AND ?
      AND tile_row BETWEEN ? AND ?
  `)
  for (const feature of geojson.features) {
    if (
      feature.geometry.type !== 'Polygon' &&
      feature.geometry.type !== 'MultiPolygon'
    ) {
      console.warn('Skipping non-polygon feature')
      continue
    }
    const polygon = feature.geometry as Polygon
    const boundingBox = bbox(polygon)
    for (let z = zoomMin; z <= zoomMax; z++) {
      const [minX, minY] = lonLatToTileXY(boundingBox[0], boundingBox[3], z) // top-left
      const [maxX, maxY] = lonLatToTileXY(boundingBox[2], boundingBox[1], z) // bottom-right

      const tmsMinY = xyzToTmsY(z, maxY)
      const tmsMaxY = xyzToTmsY(z, minY)

      const rows = stmt.all(z, minX, maxX, tmsMinY, tmsMaxY) as TileRow[]

      for (const row of rows) {
        const x = row.tile_column
        const y = tmsToXyzY(z, row.tile_row)
        const tileBbox = tileToBBox(x, y, z)
        const tilePoly = bboxPolygon(tileBbox)

        if (booleanIntersects(feature as Feature, tilePoly)) {
          yield { x, y, z }
        }
      }
    }
  }
}

async function takeChunk<T>(gen: Generator<T>, size: number): Promise<T[]> {
  const chunk: T[] = []

  for (let i = 0; i < size; i++) {
    const { value, done } = await gen.next()
    if (done) break
    chunk.push(value)
  }

  return chunk
}

function xyzToTmsY(z: number, y: number): number {
  return (1 << z) - 1 - y
}

function tmsToXyzY(z: number, y: number): number {
  return (1 << z) - 1 - y
}

export async function deleteTilesInChunks(
  db: DatabaseSync,
  tiles: Generator<Tile>,
  chunkSize = 100,
  onProgress?: (done: number) => void
): Promise<void> {
  let deleted = 0
  // Prepared statement reused across all chunks; SQL text is identical, only
  // bind values change. Was being re-prepared per chunk before.
  const stmt = db.prepare(`
    DELETE FROM map
    WHERE zoom_level = ?
      AND tile_column = ?
      AND tile_row = ?
  `)
  let chunk = await takeChunk(tiles, chunkSize)
  while (chunk.length > 0) {
    db.exec('BEGIN TRANSACTION')
    try {
      for (const { z, x, y } of chunk) {
        stmt.run(z, x, xyzToTmsY(z, y))
      }
      db.exec('COMMIT')
    } catch (err) {
      // Abort the open transaction so SQLite isn't left in an
      // implicit-rollback state holding the write lock for the rest of
      // the run. Rethrow so the caller knows the chunk failed; partial
      // mid-chunk deletes are reverted.
      try {
        db.exec('ROLLBACK')
      } catch {
        // ROLLBACK can race a SQLite-internal abort and throw "no
        // transaction is active". Safe to ignore: the transaction is
        // gone either way, and surfacing this would mask the real err.
      }
      throw err
    }

    deleted += chunk.length
    onProgress?.(deleted)
    // Yield to event loop so UI stays responsive
    await new Promise((r) => setTimeout(r, 0))
    chunk = await takeChunk(tiles, chunkSize)
  }
}

function purgeOrphanImagesChunk(
  db: DatabaseSync,
  limit: number
): number | bigint {
  const stmt = db.prepare(`
    DELETE FROM images
    WHERE tile_id IN (
      SELECT tile_id
      FROM images
      WHERE tile_id NOT IN (SELECT tile_id FROM map)
      LIMIT ?
    )
  `)

  const result = stmt.run(limit)
  return result.changes
}

export async function purgeAllOrphanImages(
  db: DatabaseSync,
  chunkSize = 1000,
  onProgress?: (deleted: number, total: number) => void
) {
  let total = 0

  let deleted: number

  while ((deleted = Number(await purgeOrphanImagesChunk(db, chunkSize))) > 0) {
    total += deleted
    onProgress?.(deleted, total)

    // Yield to event loop → app stays responsive
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return total
}

export function vacuumMbtiles(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=DELETE')
  db.exec('VACUUM')
  db.exec('PRAGMA journal_mode=WAL')
}
