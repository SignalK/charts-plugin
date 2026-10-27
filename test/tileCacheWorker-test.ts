import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'chai'
import type { FeatureCollection } from 'geojson'
import { TileCache } from '../src/tileCacheClient'
import type { MBTilesHandle, TileStoreHandle } from '../src/types'
import { convertBboxToGeoJSON } from '../src/chartDownloaderTileHelpers'

const WORLD: FeatureCollection = convertBboxToGeoJSON([-30, -30, 30, 30])

const getTile = (
  handle: MBTilesHandle,
  z: number,
  x: number,
  y: number
): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    handle.getTile(z, x, y, (err, tile) => {
      if (err) {
        if (err.message.includes('Tile does not exist')) return resolve(null)
        return reject(err)
      }
      resolve(tile)
    })
  })

const putTile = (
  handle: MBTilesHandle,
  z: number,
  x: number,
  y: number,
  data: string
): Promise<void> =>
  new Promise((resolve, reject) => {
    handle.putTile(z, x, y, Buffer.from(data), (err) => {
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

describe('tileCache worker', () => {
  let cache: TileCache
  let tmpDir: string

  before(async () => {
    cache = new TileCache()
    expect(await cache.start()).to.equal(true)
  })

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charts-tile-cache-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  after(async () => {
    await cache.close()
  })

  it('round-trips a tile through a writable cache', async () => {
    const file = path.join(tmpDir, 'cache.mbtiles')
    const handle = await cache.open('p1', file, 'rw', {
      name: 'p1',
      format: 'png',
      minzoom: 0,
      maxzoom: 4
    })
    await putTile(handle, 1, 0, 0, 'tile-one')
    await handle.flush!()
    expect(await getTile(handle, 1, 0, 0)).to.deep.equal(
      Buffer.from('tile-one')
    )
    expect(await getTile(handle, 1, 0, 1)).to.equal(null)
    await closeHandle(handle)
  })

  it('serves a writable cache through a read-only handle', async () => {
    const file = path.join(tmpDir, 'cache.mbtiles')
    const writable = await cache.open('p2', file, 'rw', {
      name: 'p2',
      format: 'png'
    })
    await putTile(writable, 2, 1, 1, 'tile-two')
    await closeHandle(writable)

    const readable = await cache.open('p2-read', file, 'r')
    expect(await getTile(readable, 2, 1, 1)).to.deep.equal(
      Buffer.from('tile-two')
    )
    const info = await new Promise<Record<string, unknown>>((resolve, reject) =>
      readable.getInfo((err, metadata) => {
        if (err) reject(err)
        else resolve(metadata as Record<string, unknown>)
      })
    )
    expect(info.name).to.equal('p2')
    await closeHandle(readable)
  })

  it('deletes tiles in a polygon, purges orphans, and vacuums', async () => {
    const file = path.join(tmpDir, 'cache.mbtiles')
    const handle: TileStoreHandle = await cache.open('p3', file, 'rw', {
      name: 'p3',
      format: 'png'
    })
    for (let x = 0; x < 2; x++) {
      await putTile(handle, 1, x, 0, `tile-${x}`)
    }
    const progress: number[] = []
    await handle.deleteTilesInPolygon!(WORLD, 0, 2, 1, (deleted) => {
      progress.push(deleted)
    })
    expect(await getTile(handle, 1, 0, 0)).to.equal(null)
    expect(await getTile(handle, 1, 1, 0)).to.equal(null)
    expect(progress.length).to.be.greaterThan(0)

    const purged = await handle.purgeOrphanImages!(1)
    expect(purged).to.be.greaterThan(0)
    await handle.vacuum!()
    await handle.checkpoint!()
    await closeHandle(handle)
  })

  it('copies a region into a sibling cache', async () => {
    const sourceFile = path.join(tmpDir, 'source.mbtiles')
    const destFile = path.join(tmpDir, 'dest.mbtiles')
    const source: TileStoreHandle = await cache.open('p4', sourceFile, 'rw', {
      name: 'p4',
      format: 'png'
    })
    await putTile(source, 1, 0, 0, 'copied')
    const dest = await source.openSibling!(destFile, {
      name: 'p4-export',
      format: 'png'
    })
    const copied = await source.copyRegion!(dest, WORLD, 0, 1)
    expect(copied).to.be.greaterThan(0)
    expect(await getTile(dest, 1, 0, 0)).to.deep.equal(Buffer.from('copied'))
    await dest.checkpoint!()
    await closeHandle(dest)
    await closeHandle(source)
  })
})
