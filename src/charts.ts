import path from 'path'
import * as xml2js from 'xml2js'
import { Dirent, promises as fs } from 'fs'
import * as _ from 'lodash'
import { ChartProvider } from './types'
import { promisify } from 'util'

// Dynamically load MBTiles to prevent module load failure
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let MBTiles: any = null
let mbtilesLoadError: Error | null = null

async function loadMBTiles() {
  if (MBTiles === null && mbtilesLoadError === null) {
    try {
      const module = await import('@signalk/mbtiles')
      MBTiles = module.default || module
    } catch (err) {
      mbtilesLoadError = err as Error
      console.error(
        'Failed to load @signalk/mbtiles module:',
        (err as Error).message
      )
    }
  }
}

// Recursively scans chartBaseDir and any non-chart subdirectories. A directory
// is treated as a chart if it has tilemapresource.xml or metadata.json; anything
// else is descended into so layouts like charts/<region>/<chart> work without
// having to list every subdir in the plugin config. Symlinks are skipped and
// the depth is bounded so a misplaced config entry can't send the scan into
// node_modules or a symlink loop.
const MAX_SCAN_DEPTH = 8

export async function findCharts(
  chartBaseDir: string
): Promise<{ [identifier: string]: ChartProvider }> {
  await loadMBTiles()
  const charts: ChartProvider[] = []
  await scanDir(chartBaseDir, charts, 0)
  return _.reduce(
    charts,
    (result, chart) => {
      result[chart.identifier] = chart
      return result
    },
    {} as { [identifier: string]: ChartProvider }
  )
}

async function scanDir(
  dir: string,
  out: ChartProvider[],
  depth: number
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    console.error(
      `Error reading charts directory ${dir}:${(err as Error).message}`
    )
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const entryPath = path.resolve(dir, entry.name)
    if (entry.name.match(/\.mbtiles$/i)) {
      if (mbtilesLoadError) {
        console.warn(
          `Skipping mbtiles file ${entry.name}: MBTiles module not available`
        )
        continue
      }
      const chart = await openMbtilesFile(entryPath, entry.name)
      if (chart) out.push(chart as ChartProvider)
    } else if (entry.isDirectory()) {
      const chart = await directoryToMapInfo(entryPath, entry.name)
      if (chart) {
        out.push(chart as ChartProvider)
      } else {
        await scanDir(entryPath, out, depth + 1)
      }
    }
  }
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
            tilemapUrl: `~tilePath~/${identifier}/{z}/{x}/{y}`,
            chartLayers: res.metadata.vector_layers
              ? parseVectorLayers(res.metadata.vector_layers)
              : []
          },
          v2: {
            url: `~tilePath~/${identifier}/{z}/{x}/{y}`,
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
        info._fileFormat = 'directory'
        info._filePath = file
        info.v1 = {
          tilemapUrl: `~tilePath~/${identifier}/{z}/{x}/{y}`,
          chartLayers: []
        }
        info.v2 = {
          url: `~tilePath~/${identifier}/{z}/{x}/{y}`,
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
  const parseString = promisify(xml2js.parseString)
  return (
    fs
      .readFile(tilemapResource)
      .then((data) => parseString(data))
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
