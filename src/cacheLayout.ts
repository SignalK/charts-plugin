/**
 * Cache directory layout.
 *
 * Three roles inside `cachePath`, kept as separate subdirectories so the
 * scanner can tell them apart from user-installed charts:
 *
 *   ${cachePath}/
 *     .working/<provider-id>/cache.mbtiles   - proxy working cache (RW), not scanned
 *     exports/<name>_<provider-id>.mbtiles   - region snapshots for offline transfer, not scanned
 *
 * The scanner (src/charts.ts) excludes `.working` and `exports` by name at
 * depth 0, plus any dot-prefixed entry. Anything else under `cachePath` is
 * treated as a user chart and read-opened.
 *
 * Pre-restructure proxy files lived at `${cachePath}/${id}.mbtiles_` (the
 * trailing underscore evaded the scanner's `\.mbtiles$` regex). Pre-restructure
 * region snapshots lived at `${cachePath}/mbtiles/${name}_${id}.mbtiles` and
 * were caught by the scanner, locking them open and breaking re-seeding.
 * `migrateLegacyCacheLayout()` moves both into the new layout on startup.
 */

import path from 'path'
import { promises as fs } from 'fs'
import type { MBTilesHandle } from './types'

export const WORKING_DIR = '.working'
export const EXPORTS_DIR = 'exports'

/** Absolute path to a proxy provider's working mbtiles cache. */
export function workingMbtilesPath(
  cachePath: string,
  providerIdentifier: string
): string {
  return path.join(cachePath, WORKING_DIR, providerIdentifier, 'cache.mbtiles')
}

/** Absolute path to a region-snapshot export file. */
export function exportMbtilesPath(
  cachePath: string,
  regionName: string,
  providerIdentifier: string
): string {
  return path.join(
    cachePath,
    EXPORTS_DIR,
    `${regionName}_${providerIdentifier}.mbtiles`
  )
}

/**
 * One-time migration of pre-restructure layouts to the new directory shape.
 * Idempotent: re-running after success is a no-op. Failures on individual
 * files are logged and skipped so a partial migration doesn't take the plugin
 * out — the next startup will retry.
 *
 * Migrates:
 *   ${cachePath}/${id}.mbtiles_                       -> .working/${id}/cache.mbtiles
 *   ${cachePath}/mbtiles/${name}_${id}.mbtiles        -> exports/${name}_${id}.mbtiles
 */
export async function migrateLegacyCacheLayout(
  cachePath: string,
  app: { debug: (msg: string) => void }
): Promise<void> {
  // Pre-restructure proxy files (.mbtiles_ trailing underscore).
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(cachePath, { withFileTypes: true })
  } catch {
    // Cache path doesn't exist yet — nothing to migrate.
    return
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const m = entry.name.match(/^(.+)\.mbtiles_$/)
    if (!m) continue
    const id = m[1]!
    const src = path.join(cachePath, entry.name)
    const dst = workingMbtilesPath(cachePath, id)
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.rename(src, dst)
      app.debug(`Migrated proxy cache ${src} -> ${dst}`)
    } catch (err) {
      app.debug(`Could not migrate ${src} -> ${dst}: ${(err as Error).message}`)
    }
  }

  // Pre-restructure region-snapshot directory (cachePath/mbtiles/).
  const oldExportDir = path.join(cachePath, 'mbtiles')
  let oldExports: import('fs').Dirent[] = []
  try {
    oldExports = await fs.readdir(oldExportDir, { withFileTypes: true })
  } catch {
    // No legacy export directory; nothing to do.
    return
  }
  for (const entry of oldExports) {
    if (!entry.isFile() || !entry.name.match(/\.mbtiles$/i)) continue
    const src = path.join(oldExportDir, entry.name)
    const dst = path.join(cachePath, EXPORTS_DIR, entry.name)
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.rename(src, dst)
      app.debug(`Migrated export ${src} -> ${dst}`)
    } catch (err) {
      app.debug(`Could not migrate ${src} -> ${dst}: ${(err as Error).message}`)
    }
  }
  // Best-effort cleanup of the now-empty legacy export dir; ignore failure
  // (e.g. user dropped a non-mbtiles file in there manually).
  try {
    await fs.rmdir(oldExportDir)
  } catch {
    // leave it; harmless
  }
}

/**
 * Counts returned by migrateLegacyTileCache. `migrated` is tiles inserted
 * into mbtiles; `skipped` is non-matching files (subdirs / extensions we
 * don't recognise / a stray README); `failed` is files we tried to migrate
 * and couldn't (read or putTile errored). Distinguishing skip from fail
 * matters when the admin reads the response: a high `failed` count is a
 * real problem, a high `skipped` count usually isn't.
 */
export interface LegacyMigrationCounts {
  migrated: number
  skipped: number
  failed: number
}

const TILE_EXTENSION = /\.(png|jpe?g|webp|pbf|mvt)$/i

/**
 * Walk a pre-restructure flat-file tile cache (the master-branch layout
 * before this PR), `<root>/<z>/<x>/<y>.<ext>`, and insert each tile into
 * the provider's working mbtiles via the standard putTile callback API.
 *
 * Idempotent: re-running after partial failure picks up where the last
 * run left off (mbtiles' INSERT OR IGNORE-style write makes duplicate
 * inserts cheap). `deleteSource: true` removes successfully migrated
 * files so the legacy directory drains over time; the directory itself
 * is left in place even when empty (admin tooling can rmdir later).
 *
 * Failures on individual tiles are counted and the walk continues:
 * one corrupt PNG shouldn't block 49,999 healthy ones.
 */
export async function migrateLegacyTileCache(
  legacyDir: string,
  mbtilesHandle: MBTilesHandle,
  opts: {
    deleteSource?: boolean
    onProgress?: (counts: LegacyMigrationCounts) => void
  } = {}
): Promise<LegacyMigrationCounts> {
  const counts: LegacyMigrationCounts = {
    migrated: 0,
    skipped: 0,
    failed: 0
  }

  let zEntries: import('fs').Dirent[]
  try {
    zEntries = await fs.readdir(legacyDir, { withFileTypes: true })
  } catch (err) {
    // Missing legacyDir is the same as "nothing to migrate" — return zeros.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return counts
    throw err
  }

  for (const zEntry of zEntries) {
    if (!zEntry.isDirectory()) {
      counts.skipped++
      continue
    }
    const z = parseInt(zEntry.name, 10)
    if (!Number.isFinite(z)) {
      counts.skipped++
      continue
    }
    const zDir = path.join(legacyDir, zEntry.name)
    let xEntries: import('fs').Dirent[]
    try {
      xEntries = await fs.readdir(zDir, { withFileTypes: true })
    } catch {
      counts.failed++
      continue
    }
    for (const xEntry of xEntries) {
      if (!xEntry.isDirectory()) {
        counts.skipped++
        continue
      }
      const x = parseInt(xEntry.name, 10)
      if (!Number.isFinite(x)) {
        counts.skipped++
        continue
      }
      const xDir = path.join(zDir, xEntry.name)
      let yEntries: import('fs').Dirent[]
      try {
        yEntries = await fs.readdir(xDir, { withFileTypes: true })
      } catch {
        counts.failed++
        continue
      }
      for (const yEntry of yEntries) {
        if (!yEntry.isFile() || !TILE_EXTENSION.test(yEntry.name)) {
          counts.skipped++
          continue
        }
        const yBase = yEntry.name.replace(TILE_EXTENSION, '')
        const y = parseInt(yBase, 10)
        if (!Number.isFinite(y)) {
          counts.skipped++
          continue
        }
        const tilePath = path.join(xDir, yEntry.name)
        try {
          const buffer = await fs.readFile(tilePath)
          await new Promise<void>((resolve, reject) => {
            mbtilesHandle.putTile(z, x, y, buffer, (err) => {
              if (err) reject(err)
              else resolve()
            })
          })
          counts.migrated++
          if (opts.deleteSource) {
            try {
              await fs.unlink(tilePath)
            } catch {
              // Source delete is best-effort; mbtiles already has the tile.
            }
          }
        } catch {
          counts.failed++
        }
        // Periodic progress signal (every 500 processed) so a long-running
        // migration can surface progress to the caller without flooding.
        const total = counts.migrated + counts.skipped + counts.failed
        if (opts.onProgress && total % 500 === 0) opts.onProgress(counts)
      }
    }
  }
  opts.onProgress?.(counts)
  return counts
}
