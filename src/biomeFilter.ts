/**
 * Biome (sea/land) filter for chart download jobs.
 *
 * Decides whether a given tile should be downloaded under a given biome
 * filter, by sampling the tile bbox at a small set of points and asking a
 * BiomeOracle whether each point is over sea or land. Kept separate from
 * seaIndex.ts so the "where does the biome come from" question (data-source,
 * caching, R-tree) stays independent from the "how do I filter tiles" one.
 */

import type { Tile } from './chartDownloader'
import type { BiomeFilter } from './types'
import type { BiomeOracle } from './seaIndex'
import { tileToBBox } from './projection'

// Sample the tile bbox at a 3x3 grid (corners + edge midpoints + centre).
// Catches inland water bodies and offshore islands roughly half a tile
// across or larger; smaller features can still slip through the gaps.
const sampleTilePoints = (
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number
): readonly [number, number][] => {
  const midLon = (minLon + maxLon) / 2
  const midLat = (minLat + maxLat) / 2
  return [
    [minLon, minLat],
    [midLon, minLat],
    [maxLon, minLat],
    [minLon, midLat],
    [midLon, midLat],
    [maxLon, midLat],
    [minLon, maxLat],
    [midLon, maxLat],
    [maxLon, maxLat]
  ]
}

// Decide whether a single tile matches the requested biome. Short-circuits
// at the first decisive sample (one sea sample is enough to clear 'sea';
// one land sample is enough to clear 'land'). The geo-maps dataset omits
// inland lakes, so an inland-lake tile reports as land for this filter.
export const tileMatchesBiome = (
  tile: Tile,
  filter: BiomeFilter,
  oracle: BiomeOracle
): boolean => {
  const [minLon, minLat, maxLon, maxLat] = tileToBBox(tile.x, tile.y, tile.z)
  for (const [lon, lat] of sampleTilePoints(minLon, minLat, maxLon, maxLat)) {
    const sampleIsSea = oracle.isPointInSea(lon, lat)
    if (filter === 'sea' && sampleIsSea) return true
    if (filter === 'land' && !sampleIsSea) return true
  }
  return false
}

export interface FilterTilesOptions {
  // Polled between tiles so a long filter pass doesn't outlive a cancelled
  // job. Returning true breaks out of the loop and returns whatever has
  // been classified so far.
  isCancelled?: () => boolean
  // Wall-clock budget in milliseconds before we yield to the event loop
  // via setImmediate. Defaults to 50 ms — long enough for the per-tile
  // overhead to be amortised, short enough that unrelated request handling
  // is not starved during a multi-thousand-tile filter pass.
  yieldMs?: number
}

const DEFAULT_YIELD_MS = 50

// Drop tiles that don't match the requested biome. Pure (no shared state)
// so the same helper drives the seed-job pre-pass, ad-hoc tooling, and
// every test suite. The yield-on-budget keeps the Node event loop
// responsive when a CPU-bound classification pass runs over thousands of
// tiles; setImmediate runs after pending I/O callbacks but before any new
// timers, which matches what we want here.
export const filterTilesByBiome = async (
  tiles: readonly Tile[],
  filter: BiomeFilter,
  oracle: BiomeOracle,
  options: FilterTilesOptions = {}
): Promise<Tile[]> => {
  const yieldMs = options.yieldMs ?? DEFAULT_YIELD_MS
  const isCancelled = options.isCancelled
  const out: Tile[] = []
  let lastYield = Date.now()
  for (const tile of tiles) {
    if (isCancelled?.()) break
    if (Date.now() - lastYield >= yieldMs) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      lastYield = Date.now()
    }
    if (tileMatchesBiome(tile, filter, oracle)) out.push(tile)
  }
  return out
}
