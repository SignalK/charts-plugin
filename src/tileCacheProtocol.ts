import type { FeatureCollection } from 'geojson'
import type { MBTilesMetadata } from './types'

export type OpenMode = 'r' | 'rw'

export interface OpenInfo {
  name: string
  format?: string
  minzoom?: number
  maxzoom?: number
}

export type TileCacheRequest =
  | {
      id: number
      method: 'open'
      providerId: string
      path: string
      mode: OpenMode
      info?: OpenInfo
    }
  | {
      id: number
      method: 'getTile'
      handleId: string
      z: number
      x: number
      y: number
    }
  | {
      id: number
      method: 'putTile'
      handleId: string
      z: number
      x: number
      y: number
      data: Uint8Array
    }
  | { id: number; method: 'getInfo'; handleId: string }
  | { id: number; method: 'startWriting'; handleId: string }
  | {
      id: number
      method: 'putInfo'
      handleId: string
      info: MBTilesMetadata
    }
  | { id: number; method: 'close'; handleId: string }
  | {
      id: number
      method: 'deleteTilesInPolygon'
      handleId: string
      geojson: FeatureCollection
      minZoom: number
      maxZoom: number
      chunkSize: number
    }
  | {
      id: number
      method: 'purgeOrphanImages'
      handleId: string
      chunkSize: number
    }
  | { id: number; method: 'vacuum'; handleId: string }
  | { id: number; method: 'checkpoint'; handleId: string }
  | { id: number; method: 'flush'; handleId: string }
  | {
      id: number
      method: 'copyRegion'
      sourceHandleId: string
      destHandleId: string
      geojson: FeatureCollection
      minZoom: number
      maxZoom: number
    }
  | { id: number; method: 'shutdown' }

export interface SerializedError {
  message: string
  name?: string
  code?: string
}

export type TileHeaders = Record<string, string | number | string[]>

export interface TileResult {
  data: Uint8Array
  headers: TileHeaders
}

export interface OpenResult {
  handleId: string
  info?: MBTilesMetadata
}

export type TileCacheResponse =
  | { kind: 'result'; id: number; value?: unknown }
  | { kind: 'error'; id: number; error: SerializedError }
  | {
      kind: 'progress'
      id: number
      done: number
      total?: number
      chunk?: number
    }
  | {
      kind: 'dbError'
      handleId: string
      providerId: string
      message: string
    }
