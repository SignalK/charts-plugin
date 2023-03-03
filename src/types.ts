import { PMTiles } from 'pmtiles'

export interface ChartProvider {
  _fileFormat?: 'pmtiles' | 'mbtiles' | 'directory'
  _filePath: string
  _pmtilesHandle?: PMTiles
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _mbtilesHandle?: any
  _flipY?: boolean
  identifier: string
  name: string
  description: string
  type: 'tilelayer'
  scale: number
  v1?: {
    tilemapUrl: string
    chartLayers: string[]
  }
  v2?: {
    url: string
    layers: string[]
  }
  bounds?: number[]
  minzoom?: number
  maxzoom?: number
  format?: string
  layers?: string[]
}

export interface OnlineChartProvider {
  name: string
  description: string
  minzoom: number
  maxzoom: number
  serverType: 'tilelayer' | 'WMS' | 'WMTS'
  format: 'png' | 'jpg'
  url: string
  layers: string[]
}
