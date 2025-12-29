import type {
  BBox,
  FeatureCollection,
  Polygon,
  MultiPolygon,
  Feature,
  Position
} from 'geojson'
import splitGeoJSON from 'geojson-antimeridian-cut'
import booleanIntersects from '@turf/boolean-intersects'
import { bbox } from '@turf/bbox'
import { polygon } from '@turf/helpers'

export interface Tile {
  x: number
  y: number
  z: number
}

export type TileGeneratorFactory = () => Generator<Tile, void, undefined>

type Point = [number, number]

/**
 * Get all tiles that intersect a bounding box up to a maximum zoom level.
 * bbox = [minLon, minLat, maxLon, maxLat]
 */
export function* getTilesForBBox(
  bbox: BBox,
  minZoom: number,
  maxZoom: number
): Generator<Tile, void, undefined> {
  const [minLon, minLat, maxLon, maxLat] = bbox

  const crossesAntiMeridian = minLon > maxLon

  // Helper to process a lon/lat box normally
  function* processBBox(lo1: number, la1: number, lo2: number, la2: number) {
    for (let z = 0; z <= maxZoom; z++) {
      const [minX, maxY] = lonLatToTileXY(lo1, la1, z)
      const [maxX, minY] = lonLatToTileXY(lo2, la2, z)

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          yield { x, y, z }
        }
      }
    }
  }

  if (!crossesAntiMeridian) {
    yield* processBBox(minLon, minLat, maxLon, maxLat)
  } else {
    yield* processBBox(minLon, minLat, 180, maxLat)
    yield* processBBox(-180, minLat, maxLon, maxLat)
  }
}

/**
 * Get tiles intersecting features in a GeoJSON FeatureCollection.
 */
export function* getTilesForGeoJSON(
  geojson: FeatureCollection,
  zoomMin = 1,
  zoomMax = 14
): Generator<Tile, void, undefined> {
  // Fix all the polygons received from leaflet to be between -180 and 180

  for (const feature of geojson.features) {
    if (
      feature.geometry.type !== 'Polygon' &&
      feature.geometry.type !== 'MultiPolygon'
    ) {
      console.warn('Skipping non-polygon feature')
      continue
    }

    const boundingBox = bbox(feature.geometry as Polygon) // [minX, minY, maxX, maxY]
    for (let z = zoomMin; z <= zoomMax; z++) {
      const [minX, minY] = lonLatToTileXY(boundingBox[0], boundingBox[3], z) // top-left
      const [maxX, maxY] = lonLatToTileXY(boundingBox[2], boundingBox[1], z) // bottom-right

      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          const tileBbox = tileToBBox(x, y, z)
          const tilePoly = bboxPolygon(tileBbox)

          if (booleanIntersects(feature as Feature, tilePoly)) {
            yield { x, y, z }
          }
        }
      }
    }
  }
}

export function countTiles(
  tiles: TileGeneratorFactory,
  upperLimit: number
): number {
  let count = 0
  const tileIterator = tiles()
  for (let r = tileIterator.next(); !r.done; r = tileIterator.next()) {
    count++
    if (count >= upperLimit) {
      break
    }
  }

  return count
}

/**
 * Convert a region object (with a .feature) into a FeatureCollection of Polygons.
 * Note: requires external splitGeoJSON helper.
 */
export function convertFeatureToGeoJSON(
  feature: GeoJSON.Feature<GeoJSON.Geometry>
): FeatureCollection {
  const normalizedFeature = normalizeGeoJSONLongitudes(feature)
  const splitGeoFeature = splitGeoJSON(normalizedFeature)
  const features: Feature<Polygon>[] = []

  const pushFeaturePolygon = (
    orig: Feature,
    coords: Position[][],
    idx?: number
  ) => {
    const poly: Feature<Polygon> = {
      type: 'Feature',
      id: idx != null && orig.id ? `${orig.id}-${idx}` : orig.id,
      geometry: {
        type: 'Polygon',
        coordinates: coords
      },
      properties: orig.properties || {}
    }
    features.push(poly)
  }

  const f = splitGeoFeature as Feature
  if (f.geometry && f.geometry.type === 'MultiPolygon') {
    for (let i = 0; i < (f.geometry as MultiPolygon).coordinates.length; i++) {
      pushFeaturePolygon(f, (f.geometry as MultiPolygon).coordinates[i], i)
    }
  } else if (f.geometry && f.geometry.type === 'Polygon') {
    features.push(f as Feature<Polygon>)
  }

  return {
    type: 'FeatureCollection' as const,
    features
  }
}

/**
 * Convert a bounding box to a GeoJSON Polygon Feature.
 *
 * @param bbox - [minLon, minLat, maxLon, maxLat]
 * @param properties - Optional properties to attach to the feature
 * @returns GeoJSON Polygon Feature
 */
// export function convertBboxToGeoJSON(
//   bbox: BBox,
//   properties: Record<string, any> = {}
// ): FeatureCollection {
//   const [minLon, minLat, maxLon, maxLat] = bbox

//   // Polygon coordinates must be an array of linear rings
//   // First (and only) ring is the outer boundary
//   const coordinates: number[][][] = [[
//     [minLon, minLat], // bottom-left
//     [minLon, maxLat], // top-left
//     [maxLon, maxLat], // top-right
//     [maxLon, minLat], // bottom-right
//     [minLon, minLat]  // close the ring
//   ]]

//   const geojson =  {
//     type: 'Feature',
//     geometry: {
//       type: 'Polygon',
//       coordinates
//     },
//     properties
//   }

//   return convertFeatureToGeoJSON(geojson)

// }

function normalizeGeoJSONLongitudes(
  feature: GeoJSON.Feature<GeoJSON.Geometry>
) {
  const geom = feature.geometry

  switch (geom.type) {
    case 'Polygon':
      normalizePolygon(geom.coordinates)
      break

    case 'MultiPolygon':
      for (const polygon of geom.coordinates) {
        normalizePolygon(polygon)
      }
      break
    default:
      break
  }
  // }

  return feature
}

function normalizePolygon(rings: number[][][]) {
  for (const ring of rings) {
    for (const coord of ring) {
      coord[0] = normalizeLon(coord[0])
    }
  }
}

function normalizeLon(lon: number): number {
  if (lon < -180) return lon + 360
  if (lon > 180) return lon - 360
  return lon
}

/* Coordinate / tile conversions kept as standalone functions */

export function lonLatToTileXY(
  lon: number,
  lat: number,
  zoom: number
): [number, number] {
  const n = 2 ** zoom
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(
    ((1 -
      Math.log(
        Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)
      ) /
        Math.PI) /
      2) *
      n
  )
  return [x, y]
}

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

export function bboxPolygon(boundingBox: BBox) {
  const [minLon, minLat, maxLon, maxLat] = boundingBox
  return polygon([
    [
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat],
      [minLon, minLat]
    ]
  ])
}

function pointInRing(pt: Point, ring: Point[]): boolean {
  const [x, y] = pt
  let inside = false

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]

    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi

    if (intersect) inside = !inside
  }

  return inside
}

function pointInPolygonFeature(pt: Point, feature: Polygon): boolean {
  const geom = feature

  if (geom.type === 'Polygon') {
    const [outer, ...holes] = geom.coordinates

    if (!pointInRing(pt, outer as Point[])) return false

    for (const hole of holes) {
      if (pointInRing(pt, hole as Point[])) return false
    }

    return true
  }

  return false
}

// Estimate number of tiles using the sample method

export function estimateTilesByBBox(bbox: BBox, zoom: number): number {
  const [minLon, minLat, maxLon, maxLat] = bbox

  const [minX, minY] = lonLatToTileXY(minLon, maxLat, zoom)
  const [maxX, maxY] = lonLatToTileXY(maxLon, minLat, zoom)

  const countX = Math.max(0, maxX - minX + 1)
  const countY = Math.max(0, maxY - minY + 1)

  return countX * countY
}

export function estimateTilesBySamplingFeature(
  feature: Polygon,
  bbox: BBox,
  zoom: number,
  samplesPerSide = 64
): number {
  const bboxTileCount = estimateTilesByBBox(bbox, zoom)
  if (bboxTileCount === 0) return 0

  const [minLon, minLat, maxLon, maxLat] = bbox

  const dx = (maxLon - minLon) / samplesPerSide
  const dy = (maxLat - minLat) / samplesPerSide

  let inside = 0
  let total = 0

  for (let i = 0; i < samplesPerSide; i++) {
    const lon = minLon + (i + 0.5) * dx

    for (let j = 0; j < samplesPerSide; j++) {
      const lat = minLat + (j + 0.5) * dy
      total++

      if (pointInPolygonFeature([lon, lat], feature)) {
        inside++
      }
    }
  }

  const fraction = inside / total
  return Math.round(bboxTileCount * fraction)
}

export function estimateTilesSamplingRangeFeature(
  feature: Polygon,
  bbox: BBox,
  zoomMin: number,
  zoomMax: number,
  samplesPerSide = 64
): number {
  let total = 0

  for (let z = zoomMin; z <= zoomMax; z++) {
    total += estimateTilesBySamplingFeature(feature, bbox, z, samplesPerSide)
  }

  return total
}

export function estimateTilesForGeoJSON(
  geojson: FeatureCollection,
  zoomMin = 1,
  zoomMax = 14
): number {
  let estimatedTileCount = 0
  for (const feature of geojson.features) {
    if (
      feature.geometry.type !== 'Polygon' &&
      feature.geometry.type !== 'MultiPolygon'
    ) {
      console.warn('Skipping non-polygon feature')
      continue
    }

    estimatedTileCount += estimateTilesSamplingRangeFeature(
      feature.geometry as Polygon,
      bbox(feature.geometry as Polygon),
      zoomMin,
      zoomMax
    )
  }

  return estimatedTileCount
}

// Multi threaded tile processor
