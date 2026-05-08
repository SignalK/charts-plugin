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
