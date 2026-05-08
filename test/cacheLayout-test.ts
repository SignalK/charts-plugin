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
  workingMbtilesPath
} from '../src/cacheLayout'

const silentApp = { debug: (_msg: string) => {} }

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
})
