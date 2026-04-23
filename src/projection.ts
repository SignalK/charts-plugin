import type { BBox } from 'geojson'

// EPSG:3857 half the equator circumference, in meters.
// Used to scale lon/lat into Web Mercator x/y.
export const WEB_MERCATOR_HALF_EXTENT_M = 20037508.34

// Web Mercator is undefined at the poles. This is the symmetric latitude
// where the projection maps to ±WEB_MERCATOR_HALF_EXTENT_M, also the clamp
// limit used by OSM / Google / MapBox tile schemes.
export const WEB_MERCATOR_MAX_LAT = 85.0511287798

// Web Mercator tile → WGS84 bounding box.
// Input  (x=1, y=1, z=2): tile (1,1) at zoom 2 — one of sixteen.
// Output: [minLon, minLat, maxLon, maxLat] for that tile in degrees.
// x and y must be inside the grid ([0, 2^z)); out-of-range inputs produced
// nonsense coordinates that silently fed downstream bbox math. Fail fast.
export function tileToBBox(x: number, y: number, z: number): BBox {
  if (!Number.isInteger(z) || z < 0) {
    throw new RangeError(`tileToBBox: invalid zoom ${z}`)
  }
  const n = 2 ** z
  if (!Number.isInteger(x) || x < 0 || x >= n) {
    throw new RangeError(`tileToBBox: x=${x} out of range at z=${z}`)
  }
  if (!Number.isInteger(y) || y < 0 || y >= n) {
    throw new RangeError(`tileToBBox: y=${y} out of range at z=${z}`)
  }
  const lon1 = (x / n) * 360 - 180
  const lat1 =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  const lon2 = ((x + 1) / n) * 360 - 180
  const lat2 =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
  return [lon1, lat2, lon2, lat1]
}

export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon * WEB_MERCATOR_HALF_EXTENT_M) / 180
  const yDeg =
    Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)
  return [x, (yDeg * WEB_MERCATOR_HALF_EXTENT_M) / 180]
}

// Converts lon/lat to an XYZ tile coordinate at the given zoom. Latitude is
// clamped to WEB_MERCATOR_MAX_LAT: without that clamp, tan(π/2) at ±90 blows
// up to Infinity and floor(NaN) leaks NaN into the tile list.
export function lonLatToTile(
  lon: number,
  lat: number,
  zoom: number
): [number, number] {
  const n = 2 ** zoom
  const clampedLat = Math.max(
    -WEB_MERCATOR_MAX_LAT,
    Math.min(WEB_MERCATOR_MAX_LAT, lat)
  )
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(
    ((1 -
      Math.log(
        Math.tan((clampedLat * Math.PI) / 180) +
          1 / Math.cos((clampedLat * Math.PI) / 180)
      ) /
        Math.PI) /
      2) *
      n
  )
  return [x, y]
}
