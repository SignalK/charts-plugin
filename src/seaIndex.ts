/**
 * Sea/land classification used by the chart-downloader's biome filter.
 *
 * The geo-maps package ships a single ~36 MB GeometryCollection containing
 * one MultiPolygon that covers every connected ocean and major sea at 10 m
 * resolution. Loading and indexing it on first use rather than at module
 * init keeps the cost off callers that never seed (the v1 charts route or
 * unit tests that stub the oracle).
 */

import RBush from 'rbush'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { polygon } from '@turf/helpers'
import getSeasMap from '@geo-maps/earth-seas-10m'
import type { Feature, Polygon } from 'geojson'

export interface BiomeOracle {
  isPointInSea(lon: number, lat: number): boolean
}

type SeaIndexEntry = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  feature: Feature<Polygon>
}

// Build the rbush of polygon-bbox entries from the geo-maps dataset. The
// full polygon (outer ring + holes) is stored on each entry: the dataset's
// largest polygon spans every connected ocean and uses tens of thousands
// of holes to punch out the continents and islands it encloses, so a
// point-in-polygon query against the outer ring alone would classify
// every continent as sea.
// The loader is overridable so tests can drive the malformed-dataset error
// path without monkey-patching require.cache. Production callers never
// override it.
type SeasLoader = () => ReturnType<typeof getSeasMap>
let seasLoader: SeasLoader = getSeasMap
export const _setSeasLoaderForTesting = (loader: SeasLoader): void => {
  seasLoader = loader
  cached = null
}
export const _restoreSeasLoaderForTesting = (): void => {
  seasLoader = getSeasMap
  cached = null
}

const buildSeaIndex = (): RBush<SeaIndexEntry> => {
  const collection = seasLoader()
  const geometry = collection.geometries[0]
  if (!geometry || geometry.type !== 'MultiPolygon') {
    throw new Error(
      `@geo-maps/earth-seas-10m returned ${
        geometry?.type ?? 'undefined'
      } geometry; expected MultiPolygon`
    )
  }
  const tree = new RBush<SeaIndexEntry>()
  const items = geometry.coordinates.map((coords): SeaIndexEntry => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    // Bbox is taken from the outer ring (index 0). Holes are by GeoJSON
    // construction strictly inside the outer ring, so they cannot extend it.
    const outer = coords[0]!
    for (const [x, y] of outer) {
      if (x! < minX) minX = x!
      if (y! < minY) minY = y!
      if (x! > maxX) maxX = x!
      if (y! > maxY) maxY = y!
    }
    return { minX, minY, maxX, maxY, feature: polygon(coords) }
  })
  tree.load(items)
  return tree
}

// Three states: not yet built, built successfully, or built and failed.
// The failure is memoized so a malformed dataset does not re-parse 36 MB
// of JSON on every retry — once it has failed, every subsequent call
// re-throws the cached error.
type CacheEntry =
  | { kind: 'ok'; tree: RBush<SeaIndexEntry> }
  | { kind: 'err'; error: Error }
let cached: CacheEntry | null = null

const ensureIndex = (): RBush<SeaIndexEntry> => {
  if (cached === null) {
    try {
      cached = { kind: 'ok', tree: buildSeaIndex() }
    } catch (e) {
      cached = {
        kind: 'err',
        error: e instanceof Error ? e : new Error(String(e))
      }
    }
  }
  if (cached.kind === 'err') throw cached.error
  return cached.tree
}

// Default biome oracle backed by the geo-maps dataset. Lazy: the first call
// builds the index. After that, queries are O(log n) bbox lookup followed
// by booleanPointInPolygon on the (small) candidate set.
export const defaultBiomeOracle: BiomeOracle = {
  isPointInSea(lon: number, lat: number): boolean {
    const candidates = ensureIndex().search({
      minX: lon,
      minY: lat,
      maxX: lon,
      maxY: lat
    })
    for (const candidate of candidates) {
      if (booleanPointInPolygon([lon, lat], candidate.feature)) {
        return true
      }
    }
    return false
  }
}
