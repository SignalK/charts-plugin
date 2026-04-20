import path from 'path'
import { XMLParser } from 'fast-xml-parser'
import { Dirent, promises as fs } from 'fs'
import pLimit from 'p-limit'
import { ChartProvider } from './types'

// Parses tilemapresource.xml into a plain object. ignoreAttributes=false and
// attributeNamePrefix='' drop the default '@_' prefix so XML attributes show
// up as normal keys. isArray forces TileSet to always be an array even when
// the XML contains only one, so the zoom-level extraction below doesn't have
// to special-case the single-element shape.
// Input  (simplified): <TileMap><Title>Foo</Title>
//                        <TileFormat extension="png"/>
//                        <BoundingBox minx="0" miny="0" maxx="1" maxy="1"/>
//                        <TileSets><TileSet href="4"/><TileSet href="5"/></TileSets>
//                      </TileMap>
// Parsed: { TileMap: {
//            Title: 'Foo',
//            TileFormat: { extension: 'png' },
//            BoundingBox: { minx: '0', miny: '0', maxx: '1', maxy: '1' },
//            TileSets: { TileSet: [ { href: '4' }, { href: '5' } ] }
//          } }
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'TileSet',
  // Keep tag text as strings (e.g. "1234" stays "1234", not 1234) so
  // ChartProvider fields like name/format/scale have stable types regardless
  // of content.
  parseTagValue: false,
  parseAttributeValue: false
})

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
// node_modules or a symlink loop. File parsing (openMbtilesFile /
// directoryToMapInfo) runs concurrently under a global limiter — 500 MBTiles
// opened serially on a Pi SD card was a 5-30s startup stall.
const MAX_SCAN_DEPTH = 8
const PARSE_CONCURRENCY = 12

export async function findCharts(
  chartBaseDir: string
): Promise<{ [identifier: string]: ChartProvider }> {
  await loadMBTiles()
  const charts: ChartProvider[] = []
  const limit = pLimit(PARSE_CONCURRENCY)
  await scanDir(chartBaseDir, charts, 0, limit)
  const result: { [identifier: string]: ChartProvider } = {}
  for (const chart of charts) {
    result[chart.identifier] = chart
  }
  return result
}

async function scanDir(
  dir: string,
  out: ChartProvider[],
  depth: number,
  limit: ReturnType<typeof pLimit>
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
  // Directory recursion runs outside the limiter to avoid deadlock: a parent
  // holding a slot while waiting for children to take their own slots would
  // starve when the limit is reached. Only the leaf file-parsing work
  // (openMbtilesFile / directoryToMapInfo) is rate-limited.
  const tasks: Promise<void>[] = []
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
      tasks.push(
        (async () => {
          const chart = await limit(() =>
            openMbtilesFile(entryPath, entry.name)
          )
          if (chart) out.push(chart as ChartProvider)
        })()
      )
    } else if (entry.isDirectory()) {
      tasks.push(
        (async () => {
          const chart = await limit(() =>
            directoryToMapInfo(entryPath, entry.name)
          )
          if (chart) {
            out.push(chart as ChartProvider)
          } else {
            await scanDir(entryPath, out, depth + 1, limit)
          }
        })()
      )
    }
  }
  await Promise.all(tasks)
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
        if (
          !res.metadata ||
          Object.keys(res.metadata).length === 0 ||
          res.metadata.bounds === undefined
        ) {
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
      return null
    })
}

function parseTilemapResource(tilemapResource: string) {
  return fs.readFile(tilemapResource, 'utf8').then((data) => {
    const parsed = xmlParser.parse(data)
    const result = parsed.TileMap
    const name = result?.Title
    const format = result?.TileFormat?.extension
    const scale = result?.Metadata?.scale
    const bbox = result?.BoundingBox
    const zoomLevels: number[] = (result?.TileSets?.TileSet || []).map(
      (set: { href?: string }) => parseInt(set?.href ?? '')
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
      minzoom: zoomLevels.length ? Math.min(...zoomLevels) : undefined,
      maxzoom: zoomLevels.length ? Math.max(...zoomLevels) : undefined,
      format,
      type: 'tilelayer',
      scale: parseInt(scale) || 250000,
      identifier: '',
      _filePath: ''
    }
    return res
  })
}

function parseMetadataJson(metadataJson: string) {
  return fs
    .readFile(metadataJson, { encoding: 'utf8' })
    .then((txt) => {
      return JSON.parse(txt)
    })
    .then((metadata) => {
      function parseBounds(bounds: number[] | string) {
        if (typeof bounds === 'string') {
          return bounds.split(',').map((bound) => parseFloat(bound.trim()))
        } else if (Array.isArray(bounds) && bounds.length === 4) {
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
  return Number.isFinite(parsed) ? parsed : undefined
}
