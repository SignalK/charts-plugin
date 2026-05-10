/**
 * Unit tests for chartDownloader.ts. Focuses on the pure tile-math methods
 * (getTilesForBBox, getSubTiles, getTilesForGeoJSON) that form the foundation
 * of every seed job. The stateful seeding flow is covered end-to-end in
 * plugin-test.ts.
 */

import { expect } from 'chai'
import type { FeatureCollection } from 'geojson'
import { ChartDownloader } from '../src/chartDownloader'
import {
  getTilesForGeoJSON,
  countTiles
} from '../src/chartDownloaderTileHelpers'
import { ChartProvider } from '../src/types'

// Minimal provider scaffold; only the fields the tile-math methods read must
// be populated (minzoom, name, format). Using an as-cast rather than a full
// mock to keep the intent obvious.
const makeProvider = (overrides: Partial<ChartProvider> = {}): ChartProvider =>
  ({
    identifier: 'unit',
    name: 'unit',
    description: '',
    type: 'tilelayer',
    scale: 250000,
    format: 'png',
    minzoom: 1,
    maxzoom: 10,
    _filePath: '',
    ...overrides
  }) as ChartProvider

// const makeDownloader = (provider: ChartProvider) => {
//   // The resources API and charts path are only touched by seed/init flows,
//   // not by the pure tile-math methods under test here.
//   return new ChartDownloader(
//     {} as unknown as Parameters<
//       typeof ChartDownloader.prototype.initializeJobFromRegion
//     >[0] extends never
//       ? never
//       : never,
//     '/tmp/unused',
//     provider
//   )
// }

// These tests are deprecated since it is easier to convert the bbox to a region and process it as a region. I will remove these after this notice is seen by msallin

// describe('chartDownloader: getTilesForBBox', () => {
//   it('returns a single tile for a small bbox at the provider minzoom', () => {
//     // A point well inside a single tile at z=3 should yield exactly one tile,
//     // not three or thirty — this is a regression guard against the loop ever
//     // expanding beyond the bbox.
//     const dl = makeDownloader(makeProvider({ minzoom: 3 }))
//     const geojson = convertBboxToGeoJSON([5, 5, 6, 6])
//     const tiles = getTilesForGeoJSON(geojson, 3, 3)

//     expect(tiles.length).to.equal(1)
//     expect(tiles[0]!.z).to.equal(3)
//   })

//   it('respects the provider minzoom (does not emit tiles below it)', () => {
//     const dl = makeDownloader(makeProvider({ minzoom: 3 }))
//     const tiles = dl.getTilesForBBox([5, 5, 6, 6], 5)
//     // z=3, 4, 5 → 3 tiles for a small bbox that fits in one tile per zoom
//     expect(tiles.map((t) => t.z).sort()).to.deep.equal([3, 4, 5])
//   })

//   it('splits an antimeridian-crossing bbox into tiles on both sides', () => {
//     // A bbox that straddles the 180° line — expressed with minLon > maxLon
//     // per the convention used throughout the code. The split path should
//     // emit tiles from both the eastern and western halves of the grid.
//     const dl = makeDownloader(makeProvider({ minzoom: 3 }))
//     const tiles = dl.getTilesForBBox([170, -5, -170, 5], 3)
//     const halfGrid = 2 ** 3 / 2
//     const easternSide = tiles.some((t) => t.x >= halfGrid)
//     const westernSide = tiles.some((t) => t.x < halfGrid)
//     expect(easternSide, 'expected tiles east of the antimeridian').to.equal(
//       true
//     )
//     expect(westernSide, 'expected tiles west of the antimeridian').to.equal(
//       true
//     )
//   })

//   it('emits no tiles when maxZoom is below the provider minzoom', () => {
//     const dl = makeDownloader(makeProvider({ minzoom: 5 }))
//     expect(dl.getTilesForBBox([0, 0, 1, 1], 3)).to.deep.equal([])
//   })
// })

// describe('chartDownloader: getSubTiles', () => {
//   const dl = makeDownloader(makeProvider())

//   it('returns the input tile when maxZoom equals its zoom', () => {
//     const tile: Tile = { x: 2, y: 3, z: 4 }
//     expect(dl.getSubTiles(tile, 4)).to.deep.equal([tile])
//   })

//   it('returns the expected child-tile count at each deeper zoom', () => {
//     // At zoom delta=d, a tile spawns 2^d × 2^d children. Plus the original.
//     const tile: Tile = { x: 0, y: 0, z: 2 }
//     const sub = dl.getSubTiles(tile, 4)
//     // z=2 (1) + z=3 (4) + z=4 (16) = 21
//     expect(sub.length).to.equal(1 + 4 + 16)
//   })

//   it('keeps children inside the parent quadrant', () => {
//     const parent: Tile = { x: 1, y: 1, z: 1 } // SE quadrant at z=1
//     const sub = dl.getSubTiles(parent, 3)
//     // z=3 children of (1,1,1) must have x,y in [4,7]
//     const atZ3 = sub.filter((t) => t.z === 3)
//     expect(atZ3.length).to.be.greaterThan(0)
//     for (const t of atZ3) {
//       expect(t.x).to.be.within(4, 7)
//       expect(t.y).to.be.within(4, 7)
//     }
//   })
// })

describe('chartDownloader: getTilesForGeoJSON', () => {
  it('returns tiles that intersect a simple polygon', () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [5, 0],
                [5, 5],
                [0, 5],
                [0, 0]
              ]
            ]
          }
        }
      ]
    }
    const tilesFactory = () => getTilesForGeoJSON(fc, 3, 3)
    const tiles = Array.from(tilesFactory())
    expect(countTiles(tilesFactory)).to.be.greaterThan(0)
    expect(tiles.every((t) => t.z === 3)).to.equal(true)
  })

  it('skips non-polygon features without failing', () => {
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
    const tilesFactory = () => getTilesForGeoJSON(fc, 3, 3)
    const tiles = Array.from(tilesFactory())
    expect(tiles).to.deep.equal([])
  })
})

describe('chartDownloader: fetchTileFromRemote', () => {
  it('returns null when the provider has no remoteUrl', async () => {
    // Non-proxy providers still pass through this path from the seed job;
    // a null return is the well-defined signal, not a throw.
    const provider = makeProvider({ remoteUrl: undefined })
    const result = await ChartDownloader.fetchTileFromRemote(provider, {
      x: 0,
      y: 0,
      z: 1
    })
    expect(result).to.equal(null)
  })
})
