import path from 'path'
import { XMLParser } from 'fast-xml-parser'
import { Dirent, promises as fs } from 'fs'
import pLimit from 'p-limit'
import { ChartProvider, MBTilesHandle, MBTilesMetadata } from './types'

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

type MBTilesConstructor = new (
  file: string,
  callback: (err: Error | null, mbtiles: MBTilesHandle) => void
) => MBTilesHandle

// Dynamically load MBTiles to prevent module load failure when the native
// SQLite dependency is unavailable (e.g. bare test environments).
let MBTiles: MBTilesConstructor | null = null
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

// onScanError is invoked when a scan step hits something that could leave
// the result set incomplete (readdir failure, non-ENOENT fs.stat, MBTiles
// open crash). The caller uses it to distinguish "legitimately zero charts"
// from "transient failure that should fall back to the last-good set".
export async function findCharts(
  chartBaseDir: string,
  onScanError?: () => void
): Promise<{ [identifier: string]: ChartProvider }> {
  await loadMBTiles()
  const charts: ChartProvider[] = []
  const limit = pLimit(PARSE_CONCURRENCY)
  await scanDir(chartBaseDir, charts, 0, limit, onScanError)
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
  limit: ReturnType<typeof pLimit>,
  onScanError?: () => void
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    // ENOENT on a configured-but-missing chart path is not a transient
    // failure — it's a user misconfiguration and we shouldn't preserve a
    // stale set because of it. Any other code (EACCES, EBUSY, EIO, EMFILE,
    // ...) is treated as transient.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && onScanError) onScanError()
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
            openMbtilesFile(entryPath, entry.name, onScanError)
          )
          if (chart) out.push(chart as ChartProvider)
        })()
      )
    } else if (entry.isDirectory()) {
      tasks.push(
        (async () => {
          const chart = await limit(() =>
            directoryToMapInfo(entryPath, entry.name, onScanError)
          )
          if (chart) {
            out.push(chart as ChartProvider)
          } else {
            await scanDir(entryPath, out, depth + 1, limit, onScanError)
          }
        })()
      )
    }
  }
  await Promise.all(tasks)
}

interface LoadedMbtiles {
  mbtiles: MBTilesHandle
  metadata: MBTilesMetadata
}

function openMbtilesFile(
  file: string,
  filename: string,
  onScanError?: () => void
): Promise<ChartProvider | null> {
  return new Promise<LoadedMbtiles>((resolve, reject) => {
    if (!MBTiles) {
      reject(mbtilesLoadError ?? new Error('MBTiles module not loaded'))
      return
    }
    // mode=ro: open read-only. Without this the library defaults to rwc,
    // which needs the containing directory writable so SQLite can create its
    // rollback journal. That breaks read-only mounts (Docker volumes, NFS,
    // SMB) with SQLITE_CANTOPEN even though the plugin never writes.
    const instance = new MBTiles(`${file}?mode=ro`, (err, mbtiles) => {
      if (err) return reject(err)
      mbtiles.getInfo((infoErr, metadata) => {
        if (infoErr) return reject(infoErr)
        resolve({ mbtiles, metadata })
      })
    })
    // MBTiles extends EventEmitter; an unhandled 'error' event crashes the
    // node process. Reject is idempotent after the promise settles, so this
    // also swallows any stray runtime error on this handle.
    instance.on('error', reject)
  })
    .then(({ mbtiles, metadata }) => {
      if (
        !metadata ||
        Object.keys(metadata).length === 0 ||
        metadata.bounds === undefined
      ) {
        return null
      }
      const identifier = filename.replace(/\.mbtiles$/i, '')
      const boundsArray = parseBoundsFromMetadata(metadata.bounds)
      const data: ChartProvider = {
        _fileFormat: 'mbtiles',
        _filePath: file,
        _mbtilesHandle: mbtiles,
        _flipY: false,
        identifier,
        name: metadata.name || metadata.id || identifier,
        description: metadata.description ?? '',
        bounds: boundsArray,
        minzoom: metadata.minzoom,
        maxzoom: metadata.maxzoom,
        format: metadata.format,
        type: 'tilelayer',
        scale: parseInt(metadata.scale ?? '') || 250000,
        v1: {
          tilemapUrl: `~tilePath~/${identifier}/{z}/{x}/{y}`,
          chartLayers: metadata.vector_layers
            ? parseVectorLayers(metadata.vector_layers)
            : []
        },
        v2: {
          url: `~tilePath~/${identifier}/{z}/{x}/{y}`,
          layers: metadata.vector_layers
            ? parseVectorLayers(metadata.vector_layers)
            : []
        }
      }
      return data
    })
    .catch((e: Error) => {
      console.error(`Error loading chart ${file}`, e.message)
      if (onScanError) onScanError()
      return null
    })
}

// MBTiles spec stores bounds as "minLon,minLat,maxLon,maxLat"; some writers
// normalise it to an array already. Accept both.
function parseBoundsFromMetadata(
  bounds: number[] | string | undefined
): number[] | undefined {
  if (bounds === undefined) return undefined
  if (Array.isArray(bounds)) return bounds
  if (typeof bounds === 'string') {
    const parts = bounds.split(',').map((b) => parseFloat(b.trim()))
    return parts.length === 4 && parts.every(Number.isFinite)
      ? parts
      : undefined
  }
  return undefined
}

function parseVectorLayers(layers: Array<{ id: string }>) {
  return layers.map((l) => l.id)
}

function directoryToMapInfo(
  file: string,
  identifier: string,
  onScanError?: () => void
) {
  async function loadInfo() {
    const tilemapResource = path.join(file, 'tilemapresource.xml')
    const metadataJson = path.join(file, 'metadata.json')
    // ENOENT means "file not present", which is normal — this dir just isn't
    // a chart and the caller will recurse into it. Any other fs.stat error
    // (EACCES, EBUSY, EIO, EMFILE, ...) is transient or configuration-level
    // and should flag the scan so the caller can preserve the last-good set.
    try {
      await fs.stat(tilemapResource)
      return parseTilemapResource(tilemapResource)
    } catch (e1) {
      const code1 = (e1 as NodeJS.ErrnoException).code
      if (code1 && code1 !== 'ENOENT') {
        console.warn(
          `Signal K Charts: fs.stat ${tilemapResource} failed: ${
            (e1 as Error).message
          }`
        )
        if (onScanError) onScanError()
      }
      try {
        await fs.stat(metadataJson)
        return parseMetadataJson(metadataJson)
      } catch (e2) {
        const code2 = (e2 as NodeJS.ErrnoException).code
        if (code2 && code2 !== 'ENOENT') {
          console.warn(
            `Signal K Charts: fs.stat ${metadataJson} failed: ${
              (e2 as Error).message
            }`
          )
          if (onScanError) onScanError()
        }
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
      if (onScanError) onScanError()
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
