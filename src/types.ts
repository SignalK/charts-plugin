import type { OutgoingHttpHeaders } from 'http'

type MapSourceType =
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
