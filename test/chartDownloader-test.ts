/**
 * Unit tests for chartDownloader.ts. Focuses on the pure tile-math methods
 * (getTilesForBBox, getSubTiles, getTilesForGeoJSON) that form the foundation
 * of every seed job. The stateful seeding flow is covered end-to-end in
 * plugin-test.ts.
 */

import { expect } from 'chai'
import type { FeatureCollection } from 'geojson'
import { ChartDownloader, Tile } from '../src/chartDownloader'
import { ChartProvider } from '../src/types'
import {
  defaultBiomeOracle,
  BiomeOracle,
  _setSeasLoaderForTesting,
  _restoreSeasLoaderForTesting
} from '../src/seaIndex'
import { tileMatchesBiome, filterTilesByBiome } from '../src/biomeFilter'

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

const makeDownloader = (provider: ChartProvider) => {
  // The resources API and charts path are only touched by seed/init flows,
  // not by the pure tile-math methods under test here.
  return new ChartDownloader(
    {} as unknown as Parameters<
      typeof ChartDownloader.prototype.initializeJobFromRegion
    >[0] extends never
      ? never
      : never,
    '/tmp/unused',
    provider
  )
}

describe('chartDownloader: getTilesForBBox', () => {
  it('returns a single tile for a small bbox at the provider minzoom', () => {
    // A point well inside a single tile at z=3 should yield exactly one tile,
    // not three or thirty — this is a regression guard against the loop ever
    // expanding beyond the bbox.
    const dl = makeDownloader(makeProvider({ minzoom: 3 }))
    const tiles = dl.getTilesForBBox([5, 5, 6, 6], 3)
    expect(tiles.length).to.equal(1)
    expect(tiles[0]!.z).to.equal(3)
  })

  it('respects the provider minzoom (does not emit tiles below it)', () => {
    const dl = makeDownloader(makeProvider({ minzoom: 3 }))
    const tiles = dl.getTilesForBBox([5, 5, 6, 6], 5)
    // z=3, 4, 5 → 3 tiles for a small bbox that fits in one tile per zoom
    expect(tiles.map((t) => t.z).sort()).to.deep.equal([3, 4, 5])
  })

  it('splits an antimeridian-crossing bbox into tiles on both sides', () => {
    // A bbox that straddles the 180° line — expressed with minLon > maxLon
    // per the convention used throughout the code. The split path should
    // emit tiles from both the eastern and western halves of the grid.
    const dl = makeDownloader(makeProvider({ minzoom: 3 }))
    const tiles = dl.getTilesForBBox([170, -5, -170, 5], 3)
    const halfGrid = 2 ** 3 / 2
    const easternSide = tiles.some((t) => t.x >= halfGrid)
    const westernSide = tiles.some((t) => t.x < halfGrid)
    expect(easternSide, 'expected tiles east of the antimeridian').to.equal(
      true
    )
    expect(westernSide, 'expected tiles west of the antimeridian').to.equal(
      true
    )
  })

  it('emits no tiles when maxZoom is below the provider minzoom', () => {
    const dl = makeDownloader(makeProvider({ minzoom: 5 }))
    expect(dl.getTilesForBBox([0, 0, 1, 1], 3)).to.deep.equal([])
  })
})

describe('chartDownloader: getSubTiles', () => {
  const dl = makeDownloader(makeProvider())

  it('returns the input tile when maxZoom equals its zoom', () => {
    const tile: Tile = { x: 2, y: 3, z: 4 }
    expect(dl.getSubTiles(tile, 4)).to.deep.equal([tile])
  })

  it('returns the expected child-tile count at each deeper zoom', () => {
    // At zoom delta=d, a tile spawns 2^d × 2^d children. Plus the original.
    const tile: Tile = { x: 0, y: 0, z: 2 }
    const sub = dl.getSubTiles(tile, 4)
    // z=2 (1) + z=3 (4) + z=4 (16) = 21
    expect(sub.length).to.equal(1 + 4 + 16)
  })

  it('keeps children inside the parent quadrant', () => {
    const parent: Tile = { x: 1, y: 1, z: 1 } // SE quadrant at z=1
    const sub = dl.getSubTiles(parent, 3)
    // z=3 children of (1,1,1) must have x,y in [4,7]
    const atZ3 = sub.filter((t) => t.z === 3)
    expect(atZ3.length).to.be.greaterThan(0)
    for (const t of atZ3) {
      expect(t.x).to.be.within(4, 7)
      expect(t.y).to.be.within(4, 7)
    }
  })
})

describe('chartDownloader: getTilesForGeoJSON', () => {
  const dl = makeDownloader(makeProvider())

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
    const tiles = dl.getTilesForGeoJSON(fc, 3, 3)
    expect(tiles.length).to.be.greaterThan(0)
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
    expect(dl.getTilesForGeoJSON(fc, 3, 3)).to.deep.equal([])
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

describe('chartDownloader: tileMatchesBiome', () => {
  // The filter samples tile bboxes at a 3x3 grid. A fake oracle lets each
  // case pin exactly which samples come back as sea vs land, so the test
  // exercises the filter logic without depending on the geo-maps dataset.
  const fakeOracle = (verdicts: boolean[]): BiomeOracle => {
    let i = 0
    return {
      isPointInSea: () => {
        const v = verdicts[i % verdicts.length]
        i += 1
        return v ?? false
      }
    }
  }
  const ALL_SEA = Array(9).fill(true)
  const ALL_LAND = Array(9).fill(false)
  // 4 sea + 5 land samples — coastline tile that crosses both biomes.
  const COASTAL = [true, true, false, true, false, false, true, false, false]
  const ANY_TILE: Tile = { x: 100, y: 100, z: 8 }

  it("'sea' filter accepts a tile whose samples are all sea", () => {
    expect(tileMatchesBiome(ANY_TILE, 'sea', fakeOracle(ALL_SEA))).to.equal(
      true
    )
  })

  it("'sea' filter rejects a tile whose samples are all land", () => {
    expect(tileMatchesBiome(ANY_TILE, 'sea', fakeOracle(ALL_LAND))).to.equal(
      false
    )
  })

  it("'land' filter accepts a tile whose samples are all land", () => {
    expect(tileMatchesBiome(ANY_TILE, 'land', fakeOracle(ALL_LAND))).to.equal(
      true
    )
  })

  it("'land' filter rejects a tile whose samples are all sea", () => {
    expect(tileMatchesBiome(ANY_TILE, 'land', fakeOracle(ALL_SEA))).to.equal(
      false
    )
  })

  it('coastal tile (mixed samples) is accepted by both filters', () => {
    expect(tileMatchesBiome(ANY_TILE, 'sea', fakeOracle(COASTAL))).to.equal(
      true
    )
    expect(tileMatchesBiome(ANY_TILE, 'land', fakeOracle(COASTAL))).to.equal(
      true
    )
  })

  it('short-circuits at the first decisive sample', () => {
    let calls = 0
    const oracle: BiomeOracle = {
      isPointInSea: () => {
        calls += 1
        return true
      }
    }
    tileMatchesBiome(ANY_TILE, 'sea', oracle)
    expect(calls).to.equal(1)
  })
})

describe('biomeFilter: filterTilesByBiome', () => {
  const seaOracle: BiomeOracle = { isPointInSea: () => true }
  const landOracle: BiomeOracle = { isPointInSea: () => false }
  const tiles: Tile[] = [
    { x: 0, y: 0, z: 4 },
    { x: 1, y: 0, z: 4 },
    { x: 2, y: 0, z: 4 }
  ]

  it("keeps every tile when the oracle agrees with the 'sea' filter", async () => {
    const out = await filterTilesByBiome(tiles, 'sea', seaOracle)
    expect(out).to.deep.equal(tiles)
  })

  it("drops every tile when the oracle disagrees with the 'sea' filter", async () => {
    const out = await filterTilesByBiome(tiles, 'sea', landOracle)
    expect(out).to.deep.equal([])
  })

  it('stops early when the cancellation callback returns true', async () => {
    let classified = 0
    const oracle: BiomeOracle = {
      isPointInSea: () => {
        classified += 1
        return true
      }
    }
    const out = await filterTilesByBiome(tiles, 'sea', oracle, {
      isCancelled: () => classified >= 1 // one tile classified, then bail
    })
    expect(out.length).to.equal(1)
  })
})

describe('chartDownloader: filterTilesByBiome integration', () => {
  // Drives the real seedCache → filterTilesByBiome path through a
  // ChartDownloader instance with a fake oracle, so the per-tile counter
  // updates and progress accounting are exercised end-to-end without
  // touching the network or the 36 MB geo-maps dataset.
  type FetchStub = {
    fn: typeof fetch
    calls: number
  }
  const installFetchStub = (): FetchStub => {
    const stub: FetchStub = {
      calls: 0,
      fn: undefined as unknown as typeof fetch
    }
    stub.fn = (async () => {
      stub.calls += 1
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    }) as unknown as typeof fetch
    globalThis.fetch = stub.fn
    return stub
  }
  let originalFetch: typeof fetch
  before(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const seaOnlyOracle: BiomeOracle = { isPointInSea: () => true }
  const landOnlyOracle: BiomeOracle = { isPointInSea: () => false }

  const seedTwoTiles = async (
    biomeFilter: 'sea' | 'land',
    oracle: BiomeOracle
  ) => {
    const provider = makeProvider({
      remoteUrl: 'https://example.invalid/{z}/{x}/{y}.png',
      biomeFilter
    })
    const downloader = new ChartDownloader(
      {} as never,
      '/tmp/sk-charts-test-' + Math.random().toString(36).slice(2),
      provider,
      oracle
    )
    await downloader.initializeJobFromBBox([0, 0, 1, 1], 4)
    const stub = installFetchStub()
    await downloader.seedCache()
    return { info: downloader.info(), fetchCalls: stub.calls }
  }

  it('skipped tiles increment skippedByFilterTiles, not failedTiles', async () => {
    const { info } = await seedTwoTiles('sea', landOnlyOracle)
    expect(info.failedTiles).to.equal(0)
    expect(info.skippedByFilterTiles).to.be.greaterThan(0)
    expect(info.skippedByFilterTiles).to.equal(info.totalTiles)
  })

  it('progress reaches 1.0 when every tile is filtered out', async () => {
    const { info } = await seedTwoTiles('sea', landOnlyOracle)
    expect(info.progress).to.equal(1)
  })

  it('matching tiles still hit the network', async () => {
    const { info, fetchCalls } = await seedTwoTiles('sea', seaOnlyOracle)
    expect(info.skippedByFilterTiles).to.equal(0)
    expect(fetchCalls).to.be.greaterThan(0)
  })

  it('skips the filter pass entirely when no biomeFilter is set', async () => {
    let oracleCalls = 0
    const trackingOracle: BiomeOracle = {
      isPointInSea: () => {
        oracleCalls += 1
        return true
      }
    }
    const provider = makeProvider({
      remoteUrl: 'https://example.invalid/{z}/{x}/{y}.png'
      // no biomeFilter — pre-pass should not run, oracle never consulted
    })
    const downloader = new ChartDownloader(
      {} as never,
      '/tmp/sk-charts-test-' + Math.random().toString(36).slice(2),
      provider,
      trackingOracle
    )
    await downloader.initializeJobFromBBox([0, 0, 1, 1], 4)
    installFetchStub()
    await downloader.seedCache()
    expect(oracleCalls).to.equal(0)
    expect(downloader.info().skippedByFilterTiles).to.equal(0)
  })

  it('yields the event loop when classification exceeds 50 ms', async function () {
    // Force the filter loop past the FILTER_YIELD_MS threshold by busy-
    // waiting inside the oracle on the first call. The second tile then
    // triggers the setImmediate path. Verifies the filter does not block
    // the loop on long classification runs.
    this.timeout(5_000)
    let firstCall = true
    const slowOracle: BiomeOracle = {
      isPointInSea: () => {
        if (firstCall) {
          firstCall = false
          const start = Date.now()
          while (Date.now() - start < 60) {
            // busy-wait > 50 ms
          }
        }
        return true
      }
    }
    let setImmediateCalls = 0
    const originalSetImmediate = globalThis.setImmediate
    globalThis.setImmediate = ((fn: (...args: unknown[]) => void) => {
      setImmediateCalls += 1
      return originalSetImmediate(fn)
    }) as unknown as typeof setImmediate
    try {
      await seedTwoTiles('sea', slowOracle)
    } finally {
      globalThis.setImmediate = originalSetImmediate
    }
    expect(setImmediateCalls).to.be.greaterThan(0)
  })
})

describe('chartDownloader: fetchTileFromRemote (post-filter-relayer)', () => {
  // The biome filter has been moved out of fetchTileFromRemote into the
  // job-init pre-pass. fetchTileFromRemote no longer consults onlySea/onlyLand
  // so the live tile-serving path (which routes through fetchTileFromRemote)
  // is unaffected by a provider's biomeFilter setting.
  let originalFetch: typeof fetch
  before(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('downloads a tile regardless of biomeFilter', async () => {
    let called = 0
    globalThis.fetch = (async () => {
      called += 1
      return new Response(new Uint8Array([1]), { status: 200 })
    }) as unknown as typeof fetch
    const provider = makeProvider({
      remoteUrl: 'https://example.invalid/{z}/{x}/{y}.png',
      // Even though biomeFilter is set, fetchTileFromRemote ignores it.
      // Filtering happens earlier, in seedCache.
      biomeFilter: 'sea'
    })
    const result = await ChartDownloader.fetchTileFromRemote(provider, {
      x: 0,
      y: 0,
      z: 1
    })
    expect(result).to.be.instanceOf(Buffer)
    expect(called).to.equal(1)
  })
})

describe('seaIndex: defaultBiomeOracle init failure handling', () => {
  // Restore the real loader after each test so subsequent describes can
  // exercise the dataset.
  afterEach(() => {
    _restoreSeasLoaderForTesting()
  })

  it('throws a descriptive error when the dataset is the wrong shape', () => {
    _setSeasLoaderForTesting(
      () =>
        ({
          type: 'GeometryCollection',
          // Wrong inner type: dataset must contain a single MultiPolygon.
          geometries: [{ type: 'Point', coordinates: [0, 0] }]
        }) as never
    )
    expect(() => defaultBiomeOracle.isPointInSea(0, 0)).to.throw(
      /returned Point geometry; expected MultiPolygon/
    )
  })

  it('memoizes the failure so repeated calls do not re-parse', () => {
    let loaderCalls = 0
    _setSeasLoaderForTesting(() => {
      loaderCalls += 1
      return {
        type: 'GeometryCollection',
        geometries: []
      } as never
    })
    expect(() => defaultBiomeOracle.isPointInSea(0, 0)).to.throw()
    expect(() => defaultBiomeOracle.isPointInSea(1, 1)).to.throw()
    expect(() => defaultBiomeOracle.isPointInSea(2, 2)).to.throw()
    // Loader should have run at most once even though three queries failed.
    expect(loaderCalls).to.equal(1)
  })
})

describe('seaIndex: defaultBiomeOracle (real dataset)', function () {
  // The real geo-maps dataset takes ~400 ms to parse + index on first use,
  // so warm it up in a before() hook with extra timeout instead of paying
  // it in the timing budget of any single test.
  this.timeout(10_000)
  before(() => {
    defaultBiomeOracle.isPointInSea(0, 0)
  })

  it('classifies the mid-South-Atlantic as sea', () => {
    expect(defaultBiomeOracle.isPointInSea(-30, -30)).to.equal(true)
  })

  it('classifies the central Sahara as land', () => {
    expect(defaultBiomeOracle.isPointInSea(15, 22)).to.equal(false)
  })

  it('classifies inner Madagascar as land (polygon-hole regression guard)', () => {
    // The geo-maps "all oceans" polygon punches Madagascar out as an inner
    // ring, so a PIP test that ignored holes would mark Madagascar as sea.
    // The 47°E 19°S sample sits well inland.
    expect(defaultBiomeOracle.isPointInSea(47, -19)).to.equal(false)
  })
})
