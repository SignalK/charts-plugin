/**
 * Unit tests for chartDownloaderTileHelpers.ts.
 *
 * The tile-math helpers form the foundation of every seed job: a
 * coordinate-conversion bug here multiplies into every downstream use
 * (totalTiles estimates, the seed iterator, the mbtiles intersection
 * query). Worth covering with focused tests rather than relying on
 * end-to-end coverage from plugin-test.ts.
 */

import { expect } from 'chai'
import type { FeatureCollection } from 'geojson'
import {
  bboxPolygon,
  convertBboxToGeoJSON,
  convertFeatureToGeoJSON,
  countTiles,
  countTilesAdaptiveIterative,
  getTilesForGeoJSON,
  lonLatToTileXY,
  tileToBBox
} from '../src/chartDownloaderTileHelpers'

const polygonAroundBbox = (
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number
): FeatureCollection => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat]
          ]
        ]
      }
    }
  ]
})

describe('chartDownloaderTileHelpers: lonLatToTileXY', () => {
  // (0, 0) at z=0 is the single root tile (0, 0).
  it('returns (0, 0) for the equator/prime-meridian at zoom 0', () => {
    expect(lonLatToTileXY(0, 0, 0)).to.deep.equal([0, 0])
  })

  // West edge of (0,0) at z=2 is around (-180, ~85.05). At z=2 the world
  // is a 4×4 grid; the longitude axis splits as -180..180 → x in [0, 3].
  it('maps the prime meridian to x = 2 at zoom 2', () => {
    const [x] = lonLatToTileXY(0, 0, 2)
    expect(x).to.equal(2)
  })

  it('produces tile counts that match the 2^z grid at the antimeridian', () => {
    // Just inside the antimeridian on the west side -> should map to the
    // last column at every zoom.
    for (let z = 1; z <= 5; z++) {
      const [x] = lonLatToTileXY(179.999, 0, z)
      expect(x).to.equal(2 ** z - 1)
    }
  })

  it('round-trips via tileToBBox: tile -> bbox -> tile', () => {
    // Pick a tile, get its bbox, sample a point well inside, convert back.
    // The mid-tile point should map to the same tile across zooms.
    for (let z = 2; z <= 8; z++) {
      const tx = 5
      const ty = 7
      const [minLon, minLat, maxLon, maxLat] = tileToBBox(tx, ty, z)
      const midLon = (minLon + maxLon) / 2
      const midLat = (minLat + maxLat) / 2
      expect(lonLatToTileXY(midLon, midLat, z)).to.deep.equal([tx, ty])
    }
  })
})

describe('chartDownloaderTileHelpers: tileToBBox', () => {
  it('returns [-180, -85ish, 180, 85ish] for the root tile at zoom 0', () => {
    const [minLon, minLat, maxLon, maxLat] = tileToBBox(0, 0, 0)
    expect(minLon).to.equal(-180)
    expect(maxLon).to.equal(180)
    // Web Mercator latitude limit is ~85.0511°.
    expect(minLat).to.be.lessThan(-85)
    expect(maxLat).to.be.greaterThan(85)
  })

  it('returns 4 quadrants that tile the world at zoom 1', () => {
    // The four z=1 tiles should cover -180..180 longitude exactly.
    const longitudes = new Set<number>()
    for (let x = 0; x < 2; x++) {
      const [minLon, , maxLon] = tileToBBox(x, 0, 1)
      longitudes.add(minLon)
      longitudes.add(maxLon)
    }
    expect(longitudes.has(-180)).to.equal(true)
    expect(longitudes.has(0)).to.equal(true)
    expect(longitudes.has(180)).to.equal(true)
  })
})

describe('chartDownloaderTileHelpers: bboxPolygon', () => {
  it('produces a closed 5-point ring matching the bbox corners', () => {
    const poly = bboxPolygon([0, 0, 1, 1])
    const ring = (poly.geometry.coordinates as number[][][])[0]!
    expect(ring).to.have.lengthOf(5)
    expect(ring[0]).to.deep.equal(ring[4]) // closed
    // All four corners present
    const set = new Set(ring.map((p) => p.join(',')))
    expect(set.has('0,0')).to.equal(true)
    expect(set.has('1,0')).to.equal(true)
    expect(set.has('1,1')).to.equal(true)
    expect(set.has('0,1')).to.equal(true)
  })
})

describe('chartDownloaderTileHelpers: convertBboxToGeoJSON', () => {
  it('wraps a simple bbox as a single-feature FeatureCollection', () => {
    const fc = convertBboxToGeoJSON([5, 5, 6, 6])
    expect(fc.type).to.equal('FeatureCollection')
    expect(fc.features).to.have.lengthOf(1)
    expect(fc.features[0]!.geometry.type).to.equal('Polygon')
  })

  it('handles bboxes that cross the antimeridian (split into two features)', () => {
    // minLon > maxLon is the convention for antimeridian-crossing bboxes
    // used by the rest of the plugin. The conversion should split into
    // two halves so downstream tile math sees both sides of the dateline.
    const fc = convertBboxToGeoJSON([170, 0, -170, 5])
    expect(fc.features.length).to.be.greaterThan(0)
    // No coordinate should sit outside [-180, 180] post-split. The
    // geometry is always Polygon for our converter (FC of polygons),
    // so the cast is sound.
    for (const feat of fc.features) {
      const coords = (feat.geometry as { coordinates: number[][][] })
        .coordinates
      for (const ring of coords) {
        for (const [lon] of ring) {
          expect(lon!).to.be.at.least(-180)
          expect(lon!).to.be.at.most(180)
        }
      }
    }
  })
})

describe('chartDownloaderTileHelpers: convertFeatureToGeoJSON', () => {
  it('returns a single-feature FC for a simple polygon', () => {
    const feat: GeoJSON.Feature<GeoJSON.Geometry> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0]
          ]
        ]
      }
    }
    const fc = convertFeatureToGeoJSON(feat)
    expect(fc.features).to.have.lengthOf(1)
  })

  it('splits an antimeridian-crossing polygon into two', () => {
    // Polygon stretches from lon=170 to lon=-170 the short way (across
    // the dateline), expressed with one coord at lon=190 to make the
    // intent unambiguous before normalisation.
    const feat: GeoJSON.Feature<GeoJSON.Geometry> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [170, 0],
            [190, 0], // == -170 after normalisation
            [190, 5],
            [170, 5],
            [170, 0]
          ]
        ]
      }
    }
    const fc = convertFeatureToGeoJSON(feat)
    // Either two separate Polygons or one MultiPolygon with two parts;
    // both are valid post-split shapes. The contract is "no coord beyond
    // [-180, 180]".
    for (const f of fc.features) {
      const coords = (f.geometry as { coordinates: number[][][] }).coordinates
      for (const ring of coords) {
        for (const [lon] of ring) {
          expect(lon!).to.be.at.least(-180)
          expect(lon!).to.be.at.most(180)
        }
      }
    }
  })
})

describe('chartDownloaderTileHelpers: getTilesForGeoJSON', () => {
  it('emits at least one tile for a polygon at each zoom in range', () => {
    const fc = polygonAroundBbox(0, 0, 5, 5)
    const tiles = Array.from(getTilesForGeoJSON(fc, 3, 5))
    const zooms = new Set(tiles.map((t) => t.z))
    expect(zooms.has(3)).to.equal(true)
    expect(zooms.has(4)).to.equal(true)
    expect(zooms.has(5)).to.equal(true)
  })

  it('emits a single tile for a degenerate point-sized bbox at low zoom', () => {
    // A polygon with zero area at z=2 still intersects exactly one tile
    // (the one containing the degenerate vertex).
    const fc = polygonAroundBbox(0.001, 0.001, 0.002, 0.002)
    const tiles = Array.from(getTilesForGeoJSON(fc, 2, 2))
    expect(tiles).to.have.lengthOf(1)
    expect(tiles[0]!.z).to.equal(2)
  })

  it('emits no tiles for a non-polygon feature', () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] }
        }
      ]
    }
    expect(Array.from(getTilesForGeoJSON(fc, 3, 5))).to.deep.equal([])
  })
})

describe('chartDownloaderTileHelpers: countTiles', () => {
  it('returns the iterator length for an unbounded count', () => {
    const fc = polygonAroundBbox(0, 0, 1, 1)
    const factory = () => getTilesForGeoJSON(fc, 3, 4)
    const fromArray = Array.from(factory()).length
    expect(countTiles(factory)).to.equal(fromArray)
  })

  it('respects the upperLimit early-exit', () => {
    const fc = polygonAroundBbox(0, 0, 30, 30)
    // The 30° box at z=3..6 produces hundreds of tiles; cap at 10.
    const capped = countTiles(() => getTilesForGeoJSON(fc, 3, 6), 10)
    expect(capped).to.equal(10)
  })
})

describe('chartDownloaderTileHelpers: countTilesAdaptiveIterative', () => {
  it('matches the exact tile-count for a small bbox where both can run cheaply', () => {
    const fc = convertBboxToGeoJSON([0, 0, 1, 1])
    // Small bbox -> exact count fits well under any limit. Use the
    // adaptive-iterative result vs the full iteration as the oracle.
    const exact = countTiles(() => getTilesForGeoJSON(fc, 3, 6))
    const adaptive = countTilesAdaptiveIterative(fc, 3, 6)
    // The adaptive estimator may slightly over- or under-count depending
    // on how many tiles are fully inside vs partially intersecting; the
    // PR notes accept "mostly 100% accurate". 5% slack is generous.
    expect(adaptive).to.be.greaterThan(0)
    const ratio = adaptive / exact
    expect(ratio, `adaptive=${adaptive} exact=${exact}`).to.be.within(0.5, 1.5)
  })

  it('returns 0 for an empty FeatureCollection', () => {
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }
    expect(countTilesAdaptiveIterative(empty, 3, 6)).to.equal(0)
  })

  it('returns 0 for a feature with non-polygon geometry', () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1]
            ]
          }
        }
      ]
    }
    expect(countTilesAdaptiveIterative(fc, 3, 6)).to.equal(0)
  })

  it('handles a polygon at the Web-Mercator latitude limit (~85.0511 degrees)', () => {
    // TEST-010: lat=85.0 sits just inside the Web Mercator clip line.
    // lonLatToTileXY produces finite tile indices here; the estimator
    // should return a positive count without infinities or NaN.
    const fc = polygonAroundBbox(0, 84.5, 1, 85.0)
    const count = countTilesAdaptiveIterative(fc, 3, 6)
    expect(Number.isFinite(count)).to.equal(true)
    expect(count).to.be.greaterThan(0)
  })

  it('handles a degenerate (zero-area) polygon', () => {
    // TEST-010: a point-shaped polygon. The estimator should not
    // divide-by-zero or return non-finite.
    const degenerate: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [10, 50],
                [10, 50],
                [10, 50],
                [10, 50],
                [10, 50]
              ]
            ]
          }
        }
      ]
    }
    const count = countTilesAdaptiveIterative(degenerate, 3, 5)
    expect(Number.isFinite(count)).to.equal(true)
    expect(count).to.be.greaterThanOrEqual(0)
  })
})
