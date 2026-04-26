import type {
  BBox,
  FeatureCollection,
  Polygon,
  MultiPolygon,
  Feature,
  Position,
  Geometry,
  GeoJsonProperties
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
  upperLimit: number = Number.POSITIVE_INFINITY
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
    const coords = (f.geometry as MultiPolygon).coordinates
    for (let i = 0; i < coords.length; i++) {
      pushFeaturePolygon(f, coords[i]!, i)
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
export function convertBboxToGeoJSON(
  bbox: BBox,
  properties: Record<string, any> = {}
): FeatureCollection {
  const [minLon, minLat, maxLon, maxLat] = bbox

  // Polygon coordinates must be an array of linear rings
  // First (and only) ring is the outer boundary
  const coordinates: number[][][] = [
    [
      [minLon, minLat], // bottom-left
      [maxLon, minLat], // bottom-right
      [maxLon, maxLat], // top-right
      [minLon, maxLat], // top-left
      [minLon, minLat] // close ring
    ]
  ]

  const geojson: Feature<Polygon> = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates
    },
    properties
  }

  return convertFeatureToGeoJSON(geojson)
}

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
      coord[0] = normalizeLon(coord[0]!)
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
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!

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

function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}

function isTileFullyInside(tileBBox: BBox, feature: Polygon): boolean {
  const [minLon, minLat, maxLon, maxLat] = tileBBox

  return (
    pointInPolygonFeature([minLon, minLat], feature) &&
    pointInPolygonFeature([minLon, maxLat], feature) &&
    pointInPolygonFeature([maxLon, minLat], feature) &&
    pointInPolygonFeature([maxLon, maxLat], feature)
  )
}

function subdivide(tile: Tile): Tile[] {
  const { x, y, z } = tile
  const z2 = z + 1

  return [
    { x: x * 2, y: y * 2, z: z2 },
    { x: x * 2 + 1, y: y * 2, z: z2 },
    { x: x * 2, y: y * 2 + 1, z: z2 },
    { x: x * 2 + 1, y: y * 2 + 1, z: z2 }
  ]
}

export function countTilesAdaptiveIterative(
  geojson: FeatureCollection,
  minZoom: number,
  maxZoom: number
): number {
  let count = 0
  for (const feature of geojson.features) {
    if (
      feature.geometry.type !== 'Polygon' &&
      feature.geometry.type !== 'MultiPolygon'
    ) {
      console.warn('Skipping non-polygon feature')
      continue
    }
    const polygonBBox = bbox(feature.geometry) as BBox
    const stack: Tile[] = []

    const minTile = lonLatToTileXY(polygonBBox[0], polygonBBox[3], minZoom)
    const maxTile = lonLatToTileXY(polygonBBox[2], polygonBBox[1], minZoom)

    for (let x = minTile[0]; x <= maxTile[0]; x++) {
      for (let y = minTile[1]; y <= maxTile[1]; y++) {
        stack.push({ x, y, z: minZoom })
      }
    }

    while (stack.length > 0) {
      const tile = stack.pop()!
      const tileBBox = tileToBBox(tile.x, tile.y, tile.z)

      // Fast bbox reject
      if (!bboxIntersects(tileBBox, polygonBBox)) {
        continue
      }

      // This assumes that if all for corners of a tile is inside the polygon, then the whole tile is inside. This is not always true (e.g. a C shaped polygon), but should be good enough for estimation.
      if (isTileFullyInside(tileBBox, feature.geometry as Polygon)) {
        const levels = maxZoom - tile.z
        count += (Math.pow(4, levels + 1) - 1) / 3
        continue
      }
      const tilePoly = bboxPolygon(tileBBox)
      if (!booleanIntersects(feature as Feature, tilePoly)) {
        continue
      }
      count++
      if (tile.z < maxZoom) {
        const children = subdivide(tile)

        for (let i = children.length - 1; i >= 0; i--) {
          stack.push(children[i])
        }
      }
    }
  }

  return count
}
