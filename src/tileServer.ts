import path from 'path'
import { Response } from 'express'
import { OutgoingHttpHeaders } from 'http'
import { ChartProvider } from './types'
import { ChartDownloader } from './chartDownloader'

/**
 * Tile-serving HTTP helpers for the charts plugin. Each helper terminates
 * the Express response itself; callers only pick the branch based on the
 * provider's storage format.
 */

// Provider-config zoom range: what we allow users to configure in the plugin
// settings for a chart's minzoom/maxzoom.
export const MIN_ZOOM = 1
export const MAX_ZOOM = 24

// Tile-coordinate range accepted on the HTTP tile route. Starts at zero
// because Leaflet's default minZoom is 0 — clients legitimately ask for
// the world tile when framing the initial view, even if no configured
// provider covers that level (they just get a 404 per-tile).
export const MIN_TILE_Z = 0

export const responseHttpOptions = {
  headers: {
    'Cache-Control': 'public, max-age=7776000' // 90 days
  },
  // Charts commonly live under dot-prefixed paths (e.g. ~/.signalk/charts);
  // express 5's send defaults to 'ignore', which 404s any path containing
  // a dot segment.
  dotfiles: 'allow' as const
}

// Tile file extensions recognised on the filesystem path. Add new entries
// here when a new raster or vector format is supported.
const ALLOWED_TILE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'pbf'])

export const isAllowedTileFormat = (format: string | undefined): boolean => {
  if (!format) return false
  return ALLOWED_TILE_FORMATS.has(format.toLowerCase())
}

// Validates tile coordinates submitted by callers. Zoom is constrained to
// the range the plugin advertises; x/y must fit the zoom grid.
// Returns an error message if invalid, or undefined if OK.
export const validateTileCoords = (
  z: number,
  x: number,
  y: number
): string | undefined => {
  if (!Number.isInteger(z) || z < MIN_TILE_Z || z > MAX_ZOOM) {
    return `Invalid zoom ${z} (must be an integer in [${MIN_TILE_Z}, ${MAX_ZOOM}])`
  }
  const n = 2 ** z
  if (!Number.isInteger(x) || x < 0 || x >= n) {
    return `Invalid x ${x} at zoom ${z} (must be an integer in [0, ${n}))`
  }
  if (!Number.isInteger(y) || y < 0 || y >= n) {
    return `Invalid y ${y} at zoom ${z} (must be an integer in [0, ${n}))`
  }
  return undefined
}

export const validateMaxZoom = (maxZoom: number): string | undefined => {
  if (!Number.isFinite(maxZoom) || maxZoom < MIN_ZOOM || maxZoom > MAX_ZOOM) {
    return `Invalid maxZoom ${maxZoom} (must be in [${MIN_ZOOM}, ${MAX_ZOOM}])`
  }
  return undefined
}

// Validates a caller-supplied bounding box. Lat/Lon must be finite numbers in
// the real-world range; minLat must be below maxLat so downstream tile math
// doesn't silently iterate an empty or inverted span. minLon > maxLon is
// allowed — that's how antimeridian-crossing boxes are expressed.
export const validateBBox = (bbox: {
  minLon: unknown
  minLat: unknown
  maxLon: unknown
  maxLat: unknown
}): string | undefined => {
  const { minLon, minLat, maxLon, maxLat } = bbox
  const finite = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v)
  if (
    !finite(minLon) ||
    !finite(minLat) ||
    !finite(maxLon) ||
    !finite(maxLat)
  ) {
    return 'bbox must contain finite numbers for minLon, minLat, maxLon, maxLat'
  }
  if (minLon < -180 || minLon > 180 || maxLon < -180 || maxLon > 180) {
    return 'bbox longitude must be in [-180, 180]'
  }
  if (minLat < -90 || minLat > 90 || maxLat < -90 || maxLat > 90) {
    return 'bbox latitude must be in [-90, 90]'
  }
  if (minLat >= maxLat) {
    return 'bbox minLat must be less than maxLat'
  }
  return undefined
}

export const serveTileFromFilesystem = (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
) => {
  const { format, _flipY, _filePath } = provider
  const normalizedFormat = format?.toLowerCase() ?? ''
  if (!_filePath || !ALLOWED_TILE_FORMATS.has(normalizedFormat)) {
    res.sendStatus(404)
    return
  }
  const flippedY = Math.pow(2, z) - 1 - y
  const file = path.resolve(
    _filePath,
    `${z}/${x}/${_flipY ? flippedY : y}.${normalizedFormat}`
  )
  // sendFile already performs the stat and handles the error; the previous
  // stat+access probe duplicated that work on every tile request. Its
  // callback fires once per request with an err only when something went
  // wrong (missing file, permission denied, header-already-sent aborts).
  res.sendFile(file, responseHttpOptions, (err) => {
    if (!err) return
    const code = (err as NodeJS.ErrnoException).code
    // express 5's send raises a NotFoundError (no `code`) when the file is
    // missing, instead of the bare ENOENT it surfaced under express 4.
    if (
      code === 'ENOENT' ||
      code === 'EACCES' ||
      code === 'EISDIR' ||
      err.name === 'NotFoundError'
    ) {
      if (!res.headersSent) res.sendStatus(404)
    } else if (!res.headersSent) {
      res.sendStatus(500)
    }
  })
}

export const serveTileFromMbtiles = (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
) => {
  if (!isAllowedTileFormat(provider.format)) {
    res.sendStatus(404)
    return
  }
  // Guard against a provider whose MBTiles handle is missing: openMbtilesFile
  // may have failed post-reconcile, or the handle was closed while a request
  // was in flight. Without this check, .getTile throws synchronously and
  // Express never answers the client.
  if (!provider._mbtilesHandle) {
    res.sendStatus(500)
    return
  }
  provider._mbtilesHandle.getTile(
    z,
    x,
    y,
    (err: Error | null, tile: Buffer, headers: OutgoingHttpHeaders) => {
      if (err && isMbtilesTileMissing(err)) {
        res.sendStatus(404)
      } else if (err) {
        console.error(
          `Error fetching tile ${provider.identifier}/${z}/${x}/${y}:`,
          err
        )
        res.sendStatus(500)
      } else {
        headers['Cache-Control'] = responseHttpOptions.headers['Cache-Control']
        res.writeHead(200, headers)
        res.end(tile)
      }
    }
  )
}

// @signalk/mbtiles currently throws `Error('Tile does not exist')` for a
// missing tile; some forks expose an ENOENT-style code instead. Centralise
// the check so a future library change only requires an edit here.
export const isMbtilesTileMissing = (err: Error): boolean => {
  if (err.message === 'Tile does not exist') return true
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT'
}

export const serveTileFromCacheOrRemote = async (
  res: Response,
  cachePath: string,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
) => {
  const buffer = await ChartDownloader.getTileFromCacheOrRemote(
    cachePath,
    provider,
    { x, y, z }
  )
  if (!buffer) {
    res.sendStatus(502)
    return
  }
  res.set('Content-Type', `image/${provider.format}`)
  res.send(buffer)
}
