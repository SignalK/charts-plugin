# Changelog

This file tracks user-visible changes between released versions. For the
full commit history, see the [git log](https://github.com/SignalK/charts-plugin/commits/master)
or the [GitHub releases](https://github.com/SignalK/charts-plugin/releases).

## v3.7.0 (unreleased)

The big change in 3.7 is the `ChartDownloader` rewrite (PR #84) plus the
follow-on architectural cleanup. Highlights:

### Added

- **Tile cache moved to mbtiles SQLite.** Per-provider working files at
  `<cachePath>/.working/<id>/cache.mbtiles` replace the per-tile PNG layout
  used in 3.6 and earlier. Faster on slow storage (Pi SD cards), survives
  filesystem hiccups better, no inode pressure.
- **Region snapshot exports** with `options.mbtiles: true` on a seeding
  job. Output lands in `<cachePath>/exports/<region>_<provider-id>.mbtiles`
  and is excluded from the chart scanner so it can be safely copied to
  another Signal K server (e.g. via USB).
- **Leaflet-based webapp** with live region drawing, multi-region seeding,
  refresh-all-tiles and vacuum options, persistent regions storage, and
  mobile-friendly layout. Replaces the earlier form-based UI.
- **Declarative token providers** (`tokenProviders` config) for chart
  sources that need a rotating bearer token fetched from a separate URL
  (Navionics-via-Garmin, ArcGIS key rotation, OAuth client_credentials).
  Token fetched on demand, cached for `ttlSeconds`, templated into the
  tile URL and headers via `{token.<field>}` placeholders. Replaces the
  early-iteration `.js` chart-provider auto-loader (dropped for security).
  See README for the schema.
- **Legacy PNG → mbtiles migration tool** at
  `POST /signalk/chart-tiles/cache/<id>/migrate`. Walks an existing
  pre-3.7 per-file cache and inserts each tile into the new mbtiles.
  Idempotent, fire-and-forget, with status polling at the same URL via
  GET. Solves the upgrade-and-lose-cache regression.
- **New endpoints**: `GET /cache/stats` (per-provider hit/miss/failure
  counters), `GET/POST /cache/regions` (persistent region storage for
  the webapp), `GET /cache/<id>/migrate` (migration status).
- **CHANGELOG.md** (this file).

### Changed

- Chart-folder scanner excludes `.working/`, `exports/`, and any
  dot-prefixed entry at depth 0. User charts at any other path are
  scanned as before.
- Scanned mbtiles files are opened read-only (already in 3.6 via
  `e7eb431`); 3.7 pairs that with the working/exports directory split
  so the proxy and the scanner never compete for write access on the
  same file.
- Tile lists during seeding are generators rather than
  pre-materialised arrays. Bounds memory on large bboxes; fixes the
  OOM seen at high zoom levels (#48).
- Disk-space safety check moved into the worker hot path (every 1000
  tiles). When space frees up, caching resumes — the previous
  one-way `CachingDisabled` latch is gone.
- `POST /signalk/chart-tiles/cache/jobs/<id>` with `action='start'`
  rejects non-Idle jobs with `409 Conflict`. The webapp already hid
  the button; the endpoint is now consistent with that. Remove and
  recreate the job to seed again.
- Token fetches are coalesced: concurrent tile requests share one
  in-flight token fetch instead of N parallel ones. An upstream
  401/403 invalidates the cached token so the next request refetches.

### Migration / upgrade notes

- On first start after upgrade, the plugin moves any pre-3.7
  `<cachePath>/<id>.mbtiles_` and `<cachePath>/mbtiles/` files into
  the new `.working/` and `exports/` layout. The migration is
  idempotent, no admin action required.
- Existing per-file PNG caches are NOT automatically imported. To
  preserve them, run `POST /signalk/chart-tiles/cache/<id>/migrate`
  per provider after upgrading. See README.
- The `.js` chart-provider auto-loader from early PR #84 iterations
  was removed. Replace any such modules with a `tokenProviders`
  config entry.

### Internal

- `ChartDownloader` split across `src/chartDownloader.ts`,
  `src/chartDownloaderTileHelpers.ts`, and
  `src/chartDownloaderMBTilesHelpers.ts` for testability.
- ~200 unit + HTTP integration tests added covering tile-coordinate
  math, the SQLite helpers, token-provider TTL/template/401 paths,
  cache-layout migration, and the new HTTP endpoints.
