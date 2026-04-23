import { mkdirSync } from 'fs'
import path from 'path'
import MBTiles from '@signalk/mbtiles'
import { ChartProvider, OnlineChartProvider } from './types'
import type { FeatureCollection, Polygon, Feature } from 'geojson'
import { bbox } from '@turf/bbox'
import booleanIntersects from '@turf/boolean-intersects'
import {
  Tile,
  lonLatToTileXY,
  tileToBBox,
  bboxPolygon
} from './chartDownloaderTileHelpers'
import { DatabaseSync } from 'node:sqlite'

type TileRow = {
  tile_column: number
  tile_row: number
}

export function openOrCreateMbtiles(
  mbtilesPath: string,
  provider: OnlineChartProvider | ChartProvider
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  mkdirSync(path.dirname(mbtilesPath), { recursive: true })

  return new Promise((resolve, reject) => {
    new MBTiles(
      `${mbtilesPath}?mode=rwc`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: Error | null, mbtiles: any) => {
        if (err) {
          return reject(err)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mbtiles.startWriting((err: any) => {
          if (err) {
            return reject(err)
          }
          mbtiles._db.exec('PRAGMA journal_mode = WAL')
          mbtiles._db.exec('PRAGMA synchronous = NORMAL')
          mbtiles._db.exec('PRAGMA temp_store = MEMORY')
          mbtiles._db.exec('PRAGMA locking_mode = EXCLUSIVE')
          mbtiles._db.exec('PRAGMA cache_size = -20000') // ~20MB RAM cache
          mbtiles._db.exec('PRAGMA page_size = 4096')
          mbtiles._db.exec('PRAGMA mmap_size = 268435456') // 256MB mmap if supported
          mbtiles._db.exec('PRAGMA auto_vacuum = FULL')

          const entries: [string, string][] = [
            ['name', provider.name],
            ['type', 'tileLayer'],
            ['version', '1.0'],
            ['format', provider.format ? provider.format : 'png'],
            ['minzoom', String(provider.minzoom)],
            ['maxzoom', String(provider.maxzoom)]
            // ['bounds', bbox.map(n => n.toFixed(7)).join(',')]
          ]
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mbtiles.putInfo(Object.fromEntries(entries), (err: any) => {
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

      const stmt = db.prepare(`
        SELECT tile_column, tile_row
        FROM map
        WHERE zoom_level = ?
          AND tile_column BETWEEN ? AND ?
          AND tile_row BETWEEN ? AND ?
      `)

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
  // const db = _mbtiles._db
  let deleted = 0
  let chunk = await takeChunk(tiles, chunkSize)
  while (chunk.length > 0) {
    db.exec('BEGIN TRANSACTION')
    const stmt = db.prepare(`
        DELETE FROM map
        WHERE zoom_level = ?
          AND tile_column = ?
          AND tile_row = ?
      `)
    for (const { z, x, y } of chunk) {
      stmt.run(z, x, xyzToTmsY(z, y))
    }
    db.exec('COMMIT')

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
