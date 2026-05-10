/**
 * Unit tests for chartDownloaderMBTilesHelpers.ts.
 *
 * Uses the standard mbtiles schema directly via node:sqlite so we can
 * exercise getMBTilesForPolygon, deleteTilesInChunks, purgeAllOrphanImages,
 * and vacuumMbtiles without spinning up the full @signalk/mbtiles loader.
 * The mbtiles spec defines:
 *   tiles  view: zoom_level, tile_column, tile_row, tile_data
 *   map    table: zoom_level, tile_column, tile_row, tile_id  (XYZ in row=TMS)
 *   images table: tile_id, tile_data
 * Real @signalk/mbtiles uses (map, images) under the hood; the helpers
 * write directly to those tables, so an in-memory copy of that schema
 * is enough.
 */

import { expect } from 'chai'
import { DatabaseSync } from 'node:sqlite'
import {
  deleteTilesInChunks,
  getMBTilesForPolygon,
  purgeAllOrphanImages,
  vacuumMbtiles
} from '../src/chartDownloaderMBTilesHelpers'
import { convertBboxToGeoJSON } from '../src/chartDownloaderTileHelpers'

// Build an in-memory SQLite db with the mbtiles tables the helpers touch.
const newDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE map (
      zoom_level INTEGER NOT NULL,
      tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL,
      tile_id TEXT NOT NULL,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
    CREATE TABLE images (
      tile_id TEXT PRIMARY KEY,
      tile_data BLOB
    );
  `)
  return db
}

// XYZ y -> TMS row (matches the helper's xyzToTmsY).
const tmsRow = (z: number, y: number) => (1 << z) - 1 - y

// Insert a tile referenced from map -> images. Caller passes XYZ y; the
// row is stored as TMS to match what the rest of the plugin writes.
const insertTile = (
  db: DatabaseSync,
  z: number,
  x: number,
  y: number,
  tileId: string,
  data: Buffer | null = Buffer.from(`tile-${z}-${x}-${y}`)
) => {
  db.prepare(
    `INSERT OR REPLACE INTO map (zoom_level, tile_column, tile_row, tile_id) VALUES (?, ?, ?, ?)`
  ).run(z, x, tmsRow(z, y), tileId)
  if (data !== null) {
    db.prepare(
      `INSERT OR REPLACE INTO images (tile_id, tile_data) VALUES (?, ?)`
    ).run(tileId, data)
  }
}

const countMap = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM map').get() as { c: number }).c

const countImages = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number }).c

describe('chartDownloaderMBTilesHelpers: getMBTilesForPolygon', () => {
  it('yields tiles whose XYZ coords fall inside the polygon', () => {
    const db = newDb()
    // Insert a 3-tile column at z=4 along x=8 across y in {7, 8, 9}.
    insertTile(db, 4, 8, 7, 'a')
    insertTile(db, 4, 8, 8, 'b')
    insertTile(db, 4, 8, 9, 'c')

    // Polygon covering a wide enough area to capture all three.
    const fc = convertBboxToGeoJSON([-30, -30, 30, 30])
    const yielded = Array.from(getMBTilesForPolygon(db, fc, 4, 4))
    // Must yield at least the three we put in (may yield more if the
    // bbox covers other tiles in DB; we only inserted 3 so it should be
    // exactly 3).
    expect(yielded).to.have.lengthOf(3)
    const ys = yielded.map((t) => t.y).sort()
    expect(ys).to.deep.equal([7, 8, 9])
  })

  it('returns an empty generator when the polygon does not overlap any tile', () => {
    const db = newDb()
    insertTile(db, 4, 8, 8, 'a')
    // Polygon over a region that's nowhere near (8, 8) at z=4.
    const fc = convertBboxToGeoJSON([170, -85, 175, -80])
    expect(Array.from(getMBTilesForPolygon(db, fc, 4, 4))).to.deep.equal([])
  })

  it('hoists the prepared SELECT once across zoom levels', () => {
    // Regression guard for the per-zoom prepare. The behaviour-level check:
    // results should be identical when the same call is made twice; if the
    // prepare were leaking somehow, repeated runs would diverge. (We can't
    // easily count the prepare calls, but we can pin the contract.)
    const db = newDb()
    insertTile(db, 3, 4, 4, 'a')
    insertTile(db, 4, 8, 8, 'b')
    const fc = convertBboxToGeoJSON([-30, -30, 30, 30])
    const a = Array.from(getMBTilesForPolygon(db, fc, 3, 4))
    const b = Array.from(getMBTilesForPolygon(db, fc, 3, 4))
    expect(a).to.deep.equal(b)
  })
})

describe('chartDownloaderMBTilesHelpers: deleteTilesInChunks', () => {
  it('deletes the listed tiles from map (in-place)', async () => {
    const db = newDb()
    for (let y = 0; y < 5; y++) insertTile(db, 4, 8, y, `id-${y}`)
    expect(countMap(db)).to.equal(5)

    function* tiles() {
      for (let y = 0; y < 5; y++) yield { z: 4, x: 8, y }
    }
    await deleteTilesInChunks(db, tiles(), 2)
    expect(countMap(db)).to.equal(0)
  })

  it('reports progress per chunk', async () => {
    const db = newDb()
    for (let y = 0; y < 7; y++) insertTile(db, 4, 8, y, `id-${y}`)
    function* tiles() {
      for (let y = 0; y < 7; y++) yield { z: 4, x: 8, y }
    }
    const progress: number[] = []
    await deleteTilesInChunks(db, tiles(), 3, (n) => progress.push(n))
    // chunkSize 3 over 7 tiles -> chunks of 3, 3, 1 -> progress 3, 6, 7.
    expect(progress).to.deep.equal([3, 6, 7])
  })

  it('rolls back on a chunk failure and rethrows', async () => {
    const db = newDb()
    for (let y = 0; y < 6; y++) insertTile(db, 4, 8, y, `id-${y}`)

    // Wrap db.prepare so the second prepared-run inside the loop throws.
    // The first chunk (size 2 → 2 deletes) commits cleanly; the second
    // chunk's run on the third tile throws, and deleteTilesInChunks must
    // ROLLBACK + rethrow, leaving the second chunk's mid-progress writes
    // reverted.
    const realPrepare = db.prepare.bind(db)
    let runCalls = 0
    const failOnRunCall = 3 // 0,1 succeed in chunk 1; call 2 starts chunk 2; call 3 throws
    db.prepare = (sql: string) => {
      const stmt = realPrepare(sql)
      const realRun = stmt.run.bind(stmt)
      stmt.run = ((...args: unknown[]) => {
        runCalls++
        if (runCalls === failOnRunCall) {
          throw new Error('simulated SQLITE_FULL')
        }
        return realRun(...(args as Parameters<typeof realRun>))
      }) as typeof stmt.run
      return stmt
    }

    function* tiles() {
      for (let y = 0; y < 6; y++) yield { z: 4, x: 8, y }
    }
    let caught: Error | null = null
    try {
      await deleteTilesInChunks(db, tiles(), 2)
    } catch (err) {
      caught = err as Error
    }
    expect(caught, 'expected rethrow').to.not.equal(null)
    expect(caught!.message).to.match(/SQLITE_FULL/)

    // First chunk (y=0,1) committed → 2 fewer rows. Second chunk (y=2,3)
    // started and threw on the first run; ROLLBACK reverts that chunk so
    // the count is 6 - 2 = 4 (not 6 - 3).
    expect(countMap(db), 'rollback should revert mid-chunk').to.equal(4)

    // Restore prepare so the post-rollback INSERT works without throwing.
    db.prepare = realPrepare
    db.exec(
      "INSERT INTO map (zoom_level, tile_column, tile_row, tile_id) VALUES (5, 0, 0, 'post')"
    )
    expect(countMap(db)).to.equal(5)
  })
})

describe('chartDownloaderMBTilesHelpers: purgeAllOrphanImages', () => {
  it('deletes images whose tile_id is no longer referenced by map', async () => {
    const db = newDb()
    insertTile(db, 4, 8, 0, 'live') // referenced
    // Insert an orphan image directly.
    db.prepare(
      `INSERT INTO images (tile_id, tile_data) VALUES ('orphan', X'01')`
    ).run()
    expect(countImages(db)).to.equal(2)

    const total = await purgeAllOrphanImages(db, 100)
    expect(total).to.equal(1)
    expect(countImages(db)).to.equal(1)
    // The remaining image must be the referenced one.
    const row = db.prepare('SELECT tile_id FROM images').get() as {
      tile_id: string
    }
    expect(row.tile_id).to.equal('live')
  })

  it('returns 0 when there are no orphans', async () => {
    const db = newDb()
    insertTile(db, 4, 8, 0, 'a')
    insertTile(db, 4, 8, 1, 'b')
    const total = await purgeAllOrphanImages(db, 100)
    expect(total).to.equal(0)
  })

  it('chunks the delete and reports progress', async () => {
    const db = newDb()
    // 25 orphans, no map entries.
    for (let i = 0; i < 25; i++) {
      db.prepare(
        `INSERT INTO images (tile_id, tile_data) VALUES (?, X'01')`
      ).run(`orphan-${i}`)
    }
    const chunks: number[] = []
    const total = await purgeAllOrphanImages(db, 10, (deleted) =>
      chunks.push(deleted)
    )
    expect(total).to.equal(25)
    // 10, 10, 5
    expect(chunks).to.deep.equal([10, 10, 5])
    expect(countImages(db)).to.equal(0)
  })
})

describe('chartDownloaderMBTilesHelpers: vacuumMbtiles', () => {
  it('runs without throwing on an empty db', () => {
    const db = newDb()
    // vacuumMbtiles toggles journal_mode; on :memory: WAL isn't supported
    // but DELETE mode is. The call should still complete; the function's
    // contract is "best-effort defrag".
    expect(() => vacuumMbtiles(db)).to.not.throw()
  })

  it('runs after a populated/deleted cycle', async () => {
    const db = newDb()
    for (let y = 0; y < 100; y++) insertTile(db, 5, 16, y, `id-${y}`)
    function* tiles() {
      for (let y = 0; y < 50; y++) yield { z: 5, x: 16, y }
    }
    await deleteTilesInChunks(db, tiles(), 25)
    expect(() => vacuumMbtiles(db)).to.not.throw()
    expect(countMap(db)).to.equal(50)
  })
})
