/**
 * Unit tests for chartDownloader.ts. Focuses on the pure tile-math methods
 * (getTilesForBBox, getSubTiles, getTilesForGeoJSON) that form the foundation
 * of every seed job. The stateful seeding flow is covered end-to-end in
 * plugin-test.ts.
 */

import os from 'os'
import path from 'path'
import { expect } from 'chai'
import type { FeatureCollection } from 'geojson'
import {
  ChartDownloader,
  DEFAULT_USER_AGENT,
  withDefaultUserAgent
} from '../src/chartDownloader'
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
  it('emits redacted, decoded request and response URLs through the debug logger', async () => {
    const messages: string[] = []
    const original = globalThis.fetch
    ChartDownloader.setDebugLogger((message) => messages.push(message))
    globalThis.fetch = (async () =>
      new Response(Buffer.from('TILE'), { status: 200 })) as typeof fetch
    try {
      const provider = makeProvider({
        remoteUrl: 'https://user:pw@example.com/a%20b/{z}/{x}/{y}?key=SECRET'
      })
      const buffer = await ChartDownloader.fetchTileFromRemote(provider, {
        x: 1,
        y: 2,
        z: 3
      })
      expect(buffer).to.be.instanceOf(Buffer)
      expect(messages).to.have.length(2)
      expect(messages[0]).to.contain('upstream tile request provider=unit')
      expect(messages[0]).to.contain('url=https://example.com/a b/3/1/2')
      expect(messages[1]).to.contain('status=200')
      // Query strings and userinfo carry API keys and tokens.
      for (const message of messages) {
        expect(message).to.not.contain('SECRET')
        expect(message).to.not.contain('pw@')
      }
    } finally {
      globalThis.fetch = original
      ChartDownloader.setDebugLogger(() => {})
    }
  })

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

describe('chartDownloader: hasDiskSpace', () => {
  beforeEach(() => {
    ChartDownloader.resetForTests()
    // Clear the seeded result so a passing test proves a real disk check ran.
    ;(
      ChartDownloader as unknown as { lastDiskSpaceResult: boolean }
    ).lastDiskSpaceResult = false
  })

  // Real-world case: the tile cache and exports directories on a normal disk.
  it('reports space for an existing directory', async () => {
    expect(await ChartDownloader.hasDiskSpace(os.tmpdir())).to.equal(true)
  })

  // The charts path may not exist yet before the first tile is cached.
  it('falls back to the nearest existing parent of a missing path', async () => {
    const missing = path.join(os.tmpdir(), 'charts-plugin-missing', 'cache')
    expect(await ChartDownloader.hasDiskSpace(missing)).to.equal(true)
  })
})

describe('chartDownloader: upstream User-Agent', () => {
  type Call = { url: string; init: RequestInit | undefined }
  let calls: Call[]
  let original: typeof fetch
  beforeEach(() => {
    calls = []
    original = globalThis.fetch
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      calls.push({ url: String(input), init })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = original
  })
  const sentHeaders = () => calls[0]!.init!.headers as { [k: string]: string }

  // OSM's tile servers block Node's default "node" agent with a 200 "Access
  // blocked" PNG, so a provider without headers must still identify itself.
  it('sends the plugin User-Agent when the provider sets none', async () => {
    const provider = makeProvider({
      remoteUrl: 'https://tile.example.org/{z}/{x}/{y}.png'
    })
    await ChartDownloader.fetchTileFromRemote(provider, { x: 1, y: 2, z: 3 })
    expect(sentHeaders()['User-Agent']).to.equal(DEFAULT_USER_AGENT)
    expect(DEFAULT_USER_AGENT).to.match(
      /^signalk-charts-plugin\/\d+\.\d+\.\d+ /
    )
  })

  it('keeps a configured User-Agent in any case and adds no second one', async () => {
    const provider = makeProvider({
      remoteUrl: 'https://tile.example.org/{z}/{x}/{y}.png',
      headers: { 'user-agent': 'MyBoat/1.0', 'X-Key': 'k' }
    })
    await ChartDownloader.fetchTileFromRemote(provider, { x: 1, y: 2, z: 3 })
    expect(sentHeaders()).to.deep.equal({
      'user-agent': 'MyBoat/1.0',
      'X-Key': 'k'
    })
  })

  it('does not mutate the provider headers', () => {
    const headers = { 'X-Key': 'k' }
    withDefaultUserAgent(headers)
    expect(headers).to.deep.equal({ 'X-Key': 'k' })
  })
})
