type MapSourceType =
  | 'tilelayer'
  | 'S-57'
  | 'WMS'
  | 'WMTS'
  | 'mapboxstyle'
  | 'tileJSON'

export interface ChartProvider {
  _fileFormat?: 'mbtiles' | 'directory'
  _filePath: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _mbtilesHandle?: any
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
}

export interface OnlineChartProvider {
  name: string
  description: string
  minzoom: number
  maxzoom: number
  serverType: MapSourceType
  format: 'png' | 'jpg'
  url: string
  style: string
  layers: string[]
}
