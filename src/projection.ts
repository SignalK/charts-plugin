import type { BBox } from 'geojson'

// EPSG:3857 half the equator circumference, in meters.
// Used to scale lon/lat into Web Mercator x/y.
export const WEB_MERCATOR_HALF_EXTENT_M = 20037508.34

export function tileToBBox(x: number, y: number, z: number): BBox {
  const n = 2 ** z
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
