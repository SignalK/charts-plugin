import * as bluebird from 'bluebird'
import path from 'path'
import MBTiles from '@mapbox/mbtiles'
import * as xml2js from 'xml2js'
import { Dirent, promises as fs } from 'fs'
import * as _ from 'lodash'
import { ChartProvider } from './types'

export function findCharts(chartBaseDir: string) {
  return fs
    .readdir(chartBaseDir, { withFileTypes: true })
    .then((files) => {
      return bluebird.mapSeries(files, (file: Dirent) => {
        const isMbtilesFile = file.name.match(/\.mbtiles$/i)
        const filePath = path.resolve(chartBaseDir, file.name)
        const isDirectory = file.isDirectory()
        const isMbstylesFile = file.name.match(/\.json$/i)
        if (isMbtilesFile) {
          return openMbtilesFile(filePath, file.name)
        } else if (isDirectory) {
          return directoryToMapInfo(filePath, file.name)
        } else if (isMbstylesFile) {
          return openMbstylesFile(filePath, file.name)
        } else {
          return Promise.resolve(null)
        }
      })
    })
    .then((result: ChartProvider) => _.filter(result, _.identity))
    .then((charts: ChartProvider[]) =>
      _.reduce(
        charts,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result: any, chart: ChartProvider) => {
          result[chart.identifier] = chart
          return result
        },
        {}
      )
    )
    .catch((err: Error) => {
      console.error(
        `Error reading charts directory ${chartBaseDir}:${err.message}`
      )
    })
}

function openMbtilesFile(file: string, filename: string) {
  return (
    new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new MBTiles(file, (err: Error, mbtiles: any) => {
        if (err) {
          return reject(err)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mbtiles.getInfo((err: Error, metadata: any) => {
          if (err) {
            return reject(err)
          }
          return resolve({ mbtiles, metadata })
        })
      })
    })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => {
        if (_.isEmpty(res.metadata) || res.metadata.bounds === undefined) {
          return null
        }
        const identifier = filename.replace(/\.mbtiles$/i, '')
        const data: ChartProvider = {
          _fileFormat: 'mbtiles',
          _filePath: file,
          _mbtilesHandle: res.mbtiles,
          _flipY: false,
          identifier,
          name: res.metadata.name || res.metadata.id,
          description: res.metadata.description,
          bounds: res.metadata.bounds,
          minzoom: res.metadata.minzoom,
          maxzoom: res.metadata.maxzoom,
          format: res.metadata.format,
          type: 'tilelayer',
          scale: parseInt(res.metadata.scale) || 250000,
          v1: {
            tilemapUrl: `~basePath~/~tilePath~/${identifier}/{z}/{x}/{y}`,
            chartLayers: res.metadata.vector_layers
              ? parseVectorLayers(res.metadata.vector_layers)
              : []
          },
          v2: {
            url: `~basePath~/~tilePath~/${identifier}/{z}/{x}/{y}`,
            layers: res.metadata.vector_layers
              ? parseVectorLayers(res.metadata.vector_layers)
              : []
          }
        }
        return data
      })
      .catch((e: Error) => {
        console.error(`Error loading chart ${file}`, e.message)
        return null
      })
  )
}

export function encStyleToId(filename: string) {
  return filename.replace('.json', '').replaceAll(' ', '-').toLocaleLowerCase()
}

async function openMbstylesFile(file: string, filename: string) {
  const json = JSON.parse(await fs.readFile(file, 'utf8'))
  const identifier = encStyleToId(filename)
  return {
    _flipY: false,
    name: json.name,
    description: '',
    identifier,
    bounds: undefined,
    minzoom: undefined,
    maxzoom: undefined,
    format: undefined,
    type: 'mapstyleJSON',
    scale: 250000,
    _filePath: file,
    v1: {
      tilemapUrl: `~basePath~/~stylePath~/${filename}`,
      chartLayers: undefined
    },
    v2: {
      url: `~basePath~/~stylePath~/${filename}`,
      layers: undefined
    }
  }
}

function parseVectorLayers(layers: Array<{ id: string }>) {
  return layers.map((l) => l.id)
}

function directoryToMapInfo(file: string, identifier: string) {
  async function loadInfo() {
    const tilemapResource = path.join(file, 'tilemapresource.xml')
    const metadataJson = path.join(file, 'metadata.json')
    try {
      await fs.stat(tilemapResource)
      return parseTilemapResource(tilemapResource)
    } catch {
      try {
        await fs.stat(metadataJson)
        return parseMetadataJson(metadataJson)
      } catch {
        return null
      }
    }
  }

  return loadInfo()
    .then((info: ChartProvider | null) => {
      if (info) {
        if (!info.format) {
          console.error(`Missing format metadata for chart ${identifier}`)
          return null
        }
        info.identifier = identifier
        ;(info._fileFormat = 'directory'),
          (info._filePath = file),
          (info.v1 = {
            tilemapUrl: `~basePath~/~tilePath~/${identifier}/{z}/{x}/{y}`,
            chartLayers: []
          })
        info.v2 = {
          url: `~basePath~/~tilePath~/${identifier}/{z}/{x}/{y}`,
          layers: []
        }

        return info
      }
      return null
    })
    .catch((e) => {
      console.error(`Error getting charts from ${file}`, e.message)
      return undefined
    })
}

function parseTilemapResource(tilemapResource: string) {
  return (
    fs
      .readFile(tilemapResource)
      .then(bluebird.promisify(xml2js.parseString))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((parsed: any) => {
        const result = parsed.TileMap
        const name = _.get(result, 'Title.0')
        const format = _.get(result, 'TileFormat.0.$.extension')
        const scale = _.get(result, 'Metadata.0.$.scale')
        const bbox = _.get(result, 'BoundingBox.0.$')
        const zoomLevels = _.map(
          _.get(result, 'TileSets.0.TileSet') || [],
          (set) => parseInt(_.get(set, '$.href'))
        )
        const res: ChartProvider = {
          _flipY: true,
          name,
          description: name,
          bounds: bbox
            ? [
                parseFloat(bbox.minx),
                parseFloat(bbox.miny),
                parseFloat(bbox.maxx),
                parseFloat(bbox.maxy)
              ]
            : undefined,
          minzoom: !_.isEmpty(zoomLevels) ? _.min(zoomLevels) : undefined,
          maxzoom: !_.isEmpty(zoomLevels) ? _.max(zoomLevels) : undefined,
          format,
          type: 'tilelayer',
          scale: parseInt(scale) || 250000,
          identifier: '',
          _filePath: ''
        }
        return res
      })
  )
}

function parseMetadataJson(metadataJson: string) {
  return fs
    .readFile(metadataJson, { encoding: 'utf8' })
    .then((txt) => {
      return JSON.parse(txt)
    })
    .then((metadata) => {
      function parseBounds(bounds: number[] | string) {
        if (_.isString(bounds)) {
          return _.map(bounds.split(','), (bound) => parseFloat(_.trim(bound)))
        } else if (_.isArray(bounds) && bounds.length === 4) {
          return bounds
        } else {
          return undefined
        }
      }
      const res: ChartProvider = {
        _flipY: false,
        name: metadata.name || metadata.id,
        description: metadata.description || '',
        bounds: parseBounds(metadata.bounds),
        minzoom: parseIntIfNotUndefined(metadata.minzoom),
        maxzoom: parseIntIfNotUndefined(metadata.maxzoom),
        format: metadata.format,
        type: metadata.type,
        scale: parseInt(metadata.scale) || 250000,
        identifier: '',
        _filePath: ''
      }
      return res
    })
}

function parseIntIfNotUndefined(val: string) {
  const parsed = parseInt(val)
  return _.isFinite(parsed) ? parsed : undefined
}
