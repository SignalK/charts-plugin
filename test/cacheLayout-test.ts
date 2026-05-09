/**
 * Unit tests for the cache directory layout helpers.
 *
 * Covers:
 * - workingMbtilesPath / exportMbtilesPath path composition
 * - migrateLegacyCacheLayout moves pre-restructure files to new locations
 * - migrate is idempotent (re-running after success is a no-op)
 * - failure on one file doesn't take down the rest
 * - empty / missing cachePath is a clean no-op
 */

import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  EXPORTS_DIR,
  WORKING_DIR,
  exportMbtilesPath,
  migrateLegacyCacheLayout,
  migrateLegacyTileCache,
  workingMbtilesPath
} from '../src/cacheLayout'
import type { MBTilesHandle } from '../src/types'

const silentApp = { debug: (_msg: string) => {} }

// In-memory fake of the @signalk/mbtiles handle that captures putTile calls.
// Just enough surface for migrateLegacyTileCache; full MBTilesHandle has
// other methods we don't need to exercise here.
const makeFakeHandle = () => {
  const tiles: Array<{ z: number; x: number; y: number; size: number }> = []
  let putTileFailureSpec: { x: number; y: number; z: number } | null = null
  const handle = {
    tiles,
    failNextPutTileMatching(spec: { x: number; y: number; z: number }) {
      putTileFailureSpec = spec
    },
    putTile(
      z: number,
      x: number,
      y: number,
      buffer: Buffer,
      cb: (err: Error | null) => void
    ) {
      if (
        putTileFailureSpec &&
        putTileFailureSpec.x === x &&
        putTileFailureSpec.y === y &&
        putTileFailureSpec.z === z
      ) {
        putTileFailureSpec = null
        return cb(new Error('simulated putTile failure'))
      }
      tiles.push({ z, x, y, size: buffer.length })
      cb(null)
    }
  }
  return handle as unknown as MBTilesHandle & {
    tiles: typeof tiles
    failNextPutTileMatching: (spec: { x: number; y: number; z: number }) => void
  }
}

const writeTile = (
  root: string,
  z: number,
  x: number,
  y: number,
  ext = 'png'
) => {
  const dir = path.join(root, String(z), String(x))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${y}.${ext}`)
  fs.writeFileSync(file, Buffer.from(`tile-${z}-${x}-${y}`))
  return file
}

const mkTmp = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'charts-cache-layout-'))

describe('cacheLayout: path helpers', () => {
  it('workingMbtilesPath puts files under .working/<id>/cache.mbtiles', () => {
    const p = workingMbtilesPath('/srv/cache', 'osm')
    expect(p).to.equal(
      path.join('/srv/cache', WORKING_DIR, 'osm', 'cache.mbtiles')
    )
  })

  it('exportMbtilesPath puts files under exports/<name>_<id>.mbtiles', () => {
    const p = exportMbtilesPath('/srv/cache', 'baltic', 'osm')
    expect(p).to.equal(
      path.join('/srv/cache', EXPORTS_DIR, 'baltic_osm.mbtiles')
    )
  })
})

describe('cacheLayout: migrateLegacyCacheLayout', () => {
  it('is a clean no-op when cachePath does not exist', async () => {
    // Just don't crash on a missing dir; the plugin may run before any
    // cache state has been written.
    await migrateLegacyCacheLayout(
      path.join(os.tmpdir(), 'charts-no-such-dir-xyz123'),
      silentApp
    )
  })

  it('moves <id>.mbtiles_ to .working/<id>/cache.mbtiles', async () => {
    const tmp = mkTmp()
    try {
      const src = path.join(tmp, 'osm.mbtiles_')
      fs.writeFileSync(src, 'fake-sqlite-bytes')

      await migrateLegacyCacheLayout(tmp, silentApp)

      const dst = workingMbtilesPath(tmp, 'osm')
      expect(fs.existsSync(src), 'old file should be gone').to.equal(false)
      expect(fs.existsSync(dst), 'new file should exist').to.equal(true)
      expect(fs.readFileSync(dst, 'utf8')).to.equal('fake-sqlite-bytes')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('moves cachePath/mbtiles/<name>_<id>.mbtiles to exports/', async () => {
    const tmp = mkTmp()
    try {
      const oldDir = path.join(tmp, 'mbtiles')
      fs.mkdirSync(oldDir)
      const src = path.join(oldDir, 'baltic_osm.mbtiles')
      fs.writeFileSync(src, 'export-bytes')

      await migrateLegacyCacheLayout(tmp, silentApp)

      const dst = path.join(tmp, EXPORTS_DIR, 'baltic_osm.mbtiles')
      expect(fs.existsSync(src), 'old file should be gone').to.equal(false)
      expect(fs.existsSync(dst), 'new file should exist').to.equal(true)
      // Empty legacy dir should also be removed.
      expect(fs.existsSync(oldDir), 'old dir should be gone').to.equal(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('is idempotent: re-running after success does nothing', async () => {
    const tmp = mkTmp()
    try {
      const src = path.join(tmp, 'osm.mbtiles_')
      fs.writeFileSync(src, 'data')

      await migrateLegacyCacheLayout(tmp, silentApp)
      await migrateLegacyCacheLayout(tmp, silentApp)

      const dst = workingMbtilesPath(tmp, 'osm')
      expect(fs.existsSync(dst)).to.equal(true)
      expect(fs.readFileSync(dst, 'utf8')).to.equal('data')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('skips non-matching files at the cache root', async () => {
    const tmp = mkTmp()
    try {
      // Files that should NOT be migrated:
      //  - regular .mbtiles file (a user chart, lives where user put it)
      //  - random file (keep as-is, don't touch)
      const userChart = path.join(tmp, 'user-chart.mbtiles')
      const randomFile = path.join(tmp, 'README.txt')
      fs.writeFileSync(userChart, 'user')
      fs.writeFileSync(randomFile, 'readme')

      await migrateLegacyCacheLayout(tmp, silentApp)

      expect(fs.existsSync(userChart)).to.equal(true)
      expect(fs.existsSync(randomFile)).to.equal(true)
      // .working should not have been created since there was nothing to migrate.
      expect(fs.existsSync(path.join(tmp, WORKING_DIR))).to.equal(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('continues after a per-file failure', async () => {
    const tmp = mkTmp()
    try {
      // Create destination directory as a *file* so the rename of one entry
      // fails. A second legacy file should still migrate successfully.
      const a = path.join(tmp, 'a.mbtiles_')
      const b = path.join(tmp, 'b.mbtiles_')
      fs.writeFileSync(a, 'A')
      fs.writeFileSync(b, 'B')
      // Create .working as a regular file so mkdir(recursive) on
      // .working/a/ will fail with ENOTDIR.
      fs.writeFileSync(path.join(tmp, WORKING_DIR), 'block')

      await migrateLegacyCacheLayout(tmp, silentApp)

      // Both should remain in place because the .working dir is blocked.
      // The check here is that the call didn't throw — partial-failure
      // tolerance is the contract.
      expect(fs.existsSync(a)).to.equal(true)
      expect(fs.existsSync(b)).to.equal(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('export-side: continues when one rename fails and migrates the rest', async () => {
    // TEST-009: paired test for the export-migration block. The proxy
    // block has a per-file failure test above; the export block had no
    // coverage. Pre-create exports/<name> as a directory so renaming a
    // file onto that path errors with EISDIR/EEXIST, while the second
    // file migrates cleanly.
    const tmp = mkTmp()
    try {
      const oldDir = path.join(tmp, 'mbtiles')
      fs.mkdirSync(oldDir)
      const a = path.join(oldDir, 'first.mbtiles')
      const b = path.join(oldDir, 'second.mbtiles')
      fs.writeFileSync(a, 'A')
      fs.writeFileSync(b, 'B')
      // Block the rename of first.mbtiles by pre-creating its destination
      // path as a directory.
      const blocked = path.join(tmp, EXPORTS_DIR, 'first.mbtiles')
      fs.mkdirSync(blocked, { recursive: true })

      await migrateLegacyCacheLayout(tmp, silentApp)

      // first.mbtiles couldn't move; should still be in the old location.
      expect(fs.existsSync(a)).to.equal(true)
      // second.mbtiles must have moved despite the first one's failure.
      expect(fs.existsSync(b)).to.equal(false)
      expect(
        fs.existsSync(path.join(tmp, EXPORTS_DIR, 'second.mbtiles'))
      ).to.equal(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('cacheLayout: migrateLegacyTileCache', () => {
  it('returns zeros when the legacy dir does not exist', async () => {
    const tmp = mkTmp()
    try {
      const handle = makeFakeHandle()
      const counts = await migrateLegacyTileCache(
        path.join(tmp, 'nope'),
        handle
      )
      expect(counts).to.deep.equal({ migrated: 0, skipped: 0, failed: 0 })
      expect(handle.tiles).to.have.lengthOf(0)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('inserts each tile into mbtiles via putTile', async () => {
    const tmp = mkTmp()
    try {
      const root = path.join(tmp, 'OpenSeaMap')
      writeTile(root, 5, 10, 20)
      writeTile(root, 5, 10, 21)
      writeTile(root, 6, 21, 42)

      const handle = makeFakeHandle()
      const counts = await migrateLegacyTileCache(root, handle)

      expect(counts.migrated).to.equal(3)
      expect(counts.failed).to.equal(0)
      expect(handle.tiles).to.have.deep.members([
        { z: 5, x: 10, y: 20, size: Buffer.from('tile-5-10-20').length },
        { z: 5, x: 10, y: 21, size: Buffer.from('tile-5-10-21').length },
        { z: 6, x: 21, y: 42, size: Buffer.from('tile-6-21-42').length }
      ])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('counts non-matching files as skipped, not failed', async () => {
    const tmp = mkTmp()
    try {
      const root = path.join(tmp, 'osm')
      writeTile(root, 5, 10, 20)
      // Stray non-numeric subdir at z-level
      fs.mkdirSync(path.join(root, 'README'))
      // Stray non-tile file at y-level
      fs.mkdirSync(path.join(root, '5', 'a'), { recursive: true })
      fs.writeFileSync(path.join(root, '5', 'a', 'note.txt'), 'hi')

      const handle = makeFakeHandle()
      const counts = await migrateLegacyTileCache(root, handle)

      expect(counts.migrated).to.equal(1)
      expect(counts.skipped).to.be.greaterThan(0)
      expect(counts.failed).to.equal(0)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('deleteSource removes successfully migrated files', async () => {
    const tmp = mkTmp()
    try {
      const root = path.join(tmp, 'osm')
      const f1 = writeTile(root, 5, 10, 20)
      const f2 = writeTile(root, 5, 10, 21)

      const handle = makeFakeHandle()
      const counts = await migrateLegacyTileCache(root, handle, {
        deleteSource: true
      })
      expect(counts.migrated).to.equal(2)
      expect(fs.existsSync(f1)).to.equal(false)
      expect(fs.existsSync(f2)).to.equal(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('counts a putTile failure as failed and continues with the rest', async () => {
    const tmp = mkTmp()
    try {
      const root = path.join(tmp, 'osm')
      writeTile(root, 5, 10, 20)
      writeTile(root, 5, 10, 21)
      writeTile(root, 5, 10, 22)

      const handle = makeFakeHandle()
      handle.failNextPutTileMatching({ z: 5, x: 10, y: 21 })
      const counts = await migrateLegacyTileCache(root, handle, {
        deleteSource: true
      })
      expect(counts.migrated).to.equal(2)
      expect(counts.failed).to.equal(1)
      // The failed file's source must NOT be deleted (deleteSource only
      // applies after a successful putTile). Otherwise we'd lose data the
      // mbtiles never accepted.
      expect(fs.existsSync(path.join(root, '5', '10', '21.png'))).to.equal(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('accepts jpg / jpeg / webp / pbf / mvt extensions', async () => {
    const tmp = mkTmp()
    try {
      const root = path.join(tmp, 'osm')
      writeTile(root, 5, 0, 0, 'png')
      writeTile(root, 5, 0, 1, 'jpg')
      writeTile(root, 5, 0, 2, 'jpeg')
      writeTile(root, 5, 0, 3, 'webp')
      writeTile(root, 5, 0, 4, 'pbf')
      writeTile(root, 5, 0, 5, 'mvt')

      const handle = makeFakeHandle()
      const counts = await migrateLegacyTileCache(root, handle)
      expect(counts.migrated).to.equal(6)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
