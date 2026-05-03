import type { OutgoingHttpHeaders } from 'http'
import type { DatabaseSync } from 'node:sqlite'

export type MapSourceType =
  | 'tilelayer'
  | 'S-57'
  | 'WMS'
  | 'WMTS'
  | 'mapstyleJSON'
  | 'tileJSON'

// Shape of the @signalk/mbtiles handle as the plugin uses it. The library is
// CJS and untyped, so we describe the call sites rather than re-declaring the
// full module surface.
export interface MBTilesHandle {
  putTile: (
    z: number,
    x: number,
    y: number,
    tile: Buffer,
    callback: (err: Error | null) => void
  ) => void
  startWriting: (callback: (err: Error | null) => void) => void
  putInfo: (
    info: MBTilesMetadata,
    callback: (err: Error | null) => void
  ) => void

  getTile: (
    z: number,
    x: number,
    y: number,
    callback: (
      err: Error | null,
      tile: Buffer,
      headers: OutgoingHttpHeaders
    ) => void
  ) => void
  getInfo: (
    callback: (err: Error | null, metadata: MBTilesMetadata) => void
  ) => void
  close: (callback: (err: Error | null) => void) => void
  // MBTiles inherits from EventEmitter. We only need 'error' so an unhandled
  // event doesn't bring down the node process.
  on: (event: 'error', listener: (err: Error) => void) => MBTilesHandle

  // Internal node:sqlite database handle exposed by @signalk/mbtiles for
  // advanced operations (tile cache writes, vacuum, bulk delete).
  _db?: DatabaseSync
}

// MBTiles metadata rows relevant to the plugin. `bounds` is commonly a
// comma-separated string in the spec but some writers emit an array; both
// are tolerated at parse time.
export interface MBTilesMetadata {
  name?: string
  id?: string
  description?: string
  bounds?: number[] | string
  minzoom?: number
  maxzoom?: number
  format?: string
  scale?: string
  vector_layers?: Array<{ id: string }>
}

export interface ChartProvider {
  _fileFormat?: 'mbtiles' | 'directory'
  _filePath: string
  _mbtilesHandle?: MBTilesHandle
  _flipY?: boolean
  // Optional handle for token-based providers that fetch a token from a
  // separate endpoint and template it into the tile URL / headers per
  // request. When present, the proxy-tile path must call ensureFreshToken()
  // before reading remoteUrl / headers (the values are getters resolved
  // against the cached token). TokenProvider is structurally typed here
  // to avoid a cycle between this module and src/tokenProvider.ts.
  _tokenProvider?: {
    ensureFreshToken: () => Promise<void>
  }
  identifier: string
  name: string
  description: string
  type: MapSourceType
  scale: number
  v1?: {
    tilemapUrl: string
    chartLayers?: string[]
  }
  v2?: {
    url: string
    layers?: string[]
  }
  bounds?: number[]
  minzoom?: number
  maxzoom?: number
  format?: string
  style?: string
  layers?: string[]
  proxy?: boolean
  remoteUrl?: string
  headers?: { [key: string]: string }
}

export interface OnlineChartProvider {
  name: string
  description: string
  minzoom: number
  maxzoom: number
  serverType: MapSourceType
  format: 'png' | 'jpg'
  url: string
  proxy: boolean
  headers?: string[]
  style: string
  layers: string[]
}

// Declarative token-provider config. Replaces the auto-imported `.js`
// provider modules from earlier iterations: instead of executing arbitrary
// Node code, the plugin fetches a token from a configured endpoint, caches
// it for `ttlSeconds`, and templates the result into the tile URL and
// headers per request. Covers the common case (rotating bearer tokens for
// providers like Navionics) without code-execution risk.
export interface TokenProviderConfig {
  identifier: string
  name: string
  description?: string
  type?: MapSourceType
  format?: string
  scale?: number
  minzoom?: number
  maxzoom?: number
  bounds?: number[]
  // Endpoint that returns a JSON object whose string-valued fields become
  // available as `{token.<field>}` placeholders in tile.url / tile.headers.
  // ttlSeconds bounds how long a token is reused before re-fetching.
  tokenEndpoint: {
    url: string
    method?: 'GET' | 'POST'
    headers?: { [key: string]: string }
    body?: string
    ttlSeconds: number
  }
  // Tile request template. `{z} {x} {y} {-y} {z-2}` are substituted by the
  // existing fetchTileFromRemote logic. `{token.<field>}` is substituted
  // here using the cached token. `{<a>-<b>}` picks a random integer in
  // [a, b] inclusive (used for sharded tile hostnames like tile{1-5}.host).
  tile: {
    url: string
    headers?: { [key: string]: string }
  }
}
