import path from 'path'
import fs, { FSWatcher } from 'fs'
import * as _ from 'lodash'
import { findCharts } from './charts'
import { apiRoutePrefix } from './constants'
import { ChartProvider, OnlineChartProvider } from './types'
import { ChartSeedingManager, ChartDownloader, Tile } from './chartDownloader'
import { Request, Response, Application } from 'express'
import { OutgoingHttpHeaders } from 'http'
import {
  Plugin,
  ServerAPI,
  ResourceProviderRegistry
} from '@signalk/server-api'

interface Config {
  chartPaths: string[]
  cachePath: string
  onlineChartProviders: OnlineChartProvider[]
}

interface ChartProviderApp
  extends ServerAPI,
    ResourceProviderRegistry,
    Application {
  config: {
    ssl: boolean
    configPath: string
    version: string
    getExternalPort: () => number
  }
}

const MIN_ZOOM = 1
const MAX_ZOOM = 24
const chartTilesPath = '/signalk/chart-tiles'
// Debounce window used to collapse FSWatcher bursts during rename / atomic-save
// sequences into one reload. Overridable via env var so tests don't have to
// wait the full 5s on every watcher assertion.
const RELOAD_DEBOUNCE_MS =
  Number(process.env.SK_CHARTS_RELOAD_DEBOUNCE_MS) || 5000

module.exports = (app: ChartProviderApp): Plugin => {
  let chartProviders: { [key: string]: ChartProvider } = {}
  let pluginStarted = false
  let props: Config = {
    chartPaths: [],
    cachePath: '',
    onlineChartProviders: []
  }

  let urlBase = ''
  const configBasePath = app.config.configPath
  const defaultChartsPath = path.join(configBasePath, '/charts')
  const serverMajorVersion = app.config.version
    ? parseInt(app.config.version.split('.')[0])
    : '1'
  ensureDirectoryExists(defaultChartsPath)

  let cachePath = defaultChartsPath

  // Chart-folder watcher state, plugin-scoped so stop()/start() cycles reset cleanly.
  // activeChartPaths / activeOnlineProviders hold the last-known config so a
  // watcher-triggered reload can reuse it without re-running doStartup.
  const watchers: FSWatcher[] = []
  let reloadTimer: NodeJS.Timeout | undefined
  let activeChartPaths: string[] = []
  let activeOnlineProviders: { [key: string]: object } = {}

  // Check Node version for schema
  const nodeVersion = process.versions.node
  const nodeMajorVersion = parseInt(nodeVersion.split('.')[0])

  // ******** REQUIRED PLUGIN DEFINITION *******
  const CONFIG_SCHEMA = {
    title: 'Signal K Charts',
    type: 'object',
    properties: {
      ...(nodeMajorVersion < 22 && {
        versionWarning: {
          type: 'string',
          title: 'REQUIRES NODE VERSION >=22',
          description:
            'Starting with version 4 this plugin will not work with Node versions older than 22. You can install an older plugin version from the App store.',
          default: ''
        }
      }),
      chartPaths: {
        type: 'array',
        title: 'Chart paths',
        description: `Add one or more paths to find charts. Defaults to "${defaultChartsPath}"`,
        items: {
          type: 'string',
          title: 'Path',
          description: `Path for chart files, relative to "${configBasePath}"`
        }
      },
      cachePath: {
        type: 'string',
        title: 'Cache path',
        description: `Directory for cached tiles. Defaults to "${defaultChartsPath}"`
      },
      onlineChartProviders: {
        type: 'array',
        title: 'Online chart providers',
        items: {
          type: 'object',
          title: 'Provider',
          required: ['name', 'minzoom', 'maxzoom', 'format', 'url'],
          properties: {
            name: {
              type: 'string',
              title: 'Name'
            },
            description: {
              type: 'string',
              title: 'Description'
            },
            minzoom: {
              type: 'number',
              title: `Minimum zoom level, between [${MIN_ZOOM}, ${MAX_ZOOM}]`,
              maximum: MAX_ZOOM,
              minimum: MIN_ZOOM,
              default: MIN_ZOOM
            },
            maxzoom: {
              type: 'number',
              title: `Maximum zoom level, between [${MIN_ZOOM}, ${MAX_ZOOM}]`,
              maximum: MAX_ZOOM,
              minimum: MIN_ZOOM,
              default: 15
            },
            serverType: {
              type: 'string',
              title: 'Map source / server type',
              default: 'tilelayer',
              enum: [
                'tilelayer',
                'S-57',
                'WMS',
                'WMTS',
                'mapstyleJSON',
                'tileJSON'
              ],
              description:
                'Map data source type served by the supplied url. (Use tilelayer for xyz / tms tile sources.)'
            },
            format: {
              type: 'string',
              title: 'Format',
              default: 'png',
              enum: ['png', 'jpg', 'pbf'],
              description:
                'Format of map tiles: raster (png, jpg, etc.) / vector (pbf).'
            },
            url: {
              type: 'string',
              title: 'URL',
              description:
                'Map URL (for tilelayer include {z}, {x} and {y} parameters, e.g. "http://example.org/{z}/{x}/{y}.png")'
            },
            proxy: {
              type: 'boolean',
              title: 'Proxy through signalk server',
              description:
                'Create a proxy to serve remote tiles and cache fetched tiles from the remote server, to serve them locally on subsequent requests. Use webapp to configure seeding jobs to prefetch tiles to local cache.',
              default: false
            },
            headers: {
              type: 'array',
              title: 'Headers',
              description:
                'List of http headers to be sent to the remote server when requesting map tiles through proxy.',
              items: {
                title: 'Header Name: Value',
                description:
                  'Name and Value of the HTTP header separated by colon',
                type: 'string'
              }
            },
            style: {
              type: 'string',
              title: 'Vector Map Style',
              description:
                'Path to file containing map style definitions for Vector maps (e.g. "http://example.org/styles/mymapstyle.json")'
            },
            layers: {
              type: 'array',
              title: 'Layers',
              description:
                'List of map layer ids to display. (Use with WMS / WMTS types.)',
              items: {
                title: 'Layer Name',
                description: 'Name of layer to display',
                type: 'string'
              }
            }
          }
        }
      }
    }
  }

  const CONFIG_UISCHEMA = {}

  const plugin: Plugin = {
    id: 'charts',
    name: 'Signal K Charts',
    schema: () => CONFIG_SCHEMA,
    uiSchema: () => CONFIG_UISCHEMA,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start: (settings: any) => {
      return doStartup(settings) // return required for tests
    },
    stop: () => {
      stopWatchers()
      // Close open SQLite connections so the user can move or delete chart
      // files while the plugin is stopped (Windows blocks deletion on open
      // handles). Restart re-opens fresh via findCharts.
      for (const p of Object.values(chartProviders)) {
        if (p?._mbtilesHandle) closeMbtilesHandle(p._mbtilesHandle)
      }
      chartProviders = {}
      app.setPluginStatus('stopped')
    }
  }

  const doStartup = (config: Config) => {
    // Check Node version
    const nodeVersion = process.versions.node
    const majorVersion = parseInt(nodeVersion.split('.')[0])
    if (majorVersion < 22) {
      const errorMsg = `Node version ${nodeVersion} is not supported. This plugin requires Node version 22 or higher. Please upgrade Node or install an older plugin version.`
      app.setPluginError(errorMsg)
      app.debug(errorMsg)
      return Promise.reject(new Error(errorMsg))
    }

    app.debug(`** loaded config: ${config}`)
    props = { ...config }

    urlBase = `${app.config.ssl ? 'https' : 'http'}://localhost:${
      'getExternalPort' in app.config ? app.config.getExternalPort() : 3000
    }`
    app.debug(`**urlBase** ${urlBase}`)

    activeChartPaths = _.isEmpty(props.chartPaths)
      ? [defaultChartsPath]
      : resolveUniqueChartPaths(props.chartPaths, configBasePath)
    cachePath = props.cachePath || defaultChartsPath
    ensureDirectoryExists(cachePath)

    activeOnlineProviders = _.reduce(
      props.onlineChartProviders,
      (result: { [key: string]: object }, data) => {
        const provider = convertOnlineProviderConfig(data)
        result[provider.identifier] = provider
        return result
      },
      {}
    )
    app.debug(
      `Start charts plugin. Chart paths: ${activeChartPaths.join(
        ', '
      )}, online charts: ${Object.keys(activeOnlineProviders).length}`
    )

    // Do not register routes if plugin has been started once already
    pluginStarted === false && registerRoutes()
    pluginStarted = true

    // v2 routes - register as Resource Provider, this needs to be always on startup
    if (serverMajorVersion === 2) {
      app.debug('** Registering v2 API paths **')
      registerAsProvider()
    }

    app.setPluginStatus('Started')

    startWatchers()
    return loadChartProviders()
  }

  const loadChartProviders = async (): Promise<void> => {
    let newCharts: { [key: string]: ChartProvider } = {}
    try {
      const list: ({ [key: string]: ChartProvider } | undefined)[] = []
      for (const chartPath of activeChartPaths) {
        list.push(await findCharts(chartPath))
      }
      newCharts = _.reduce(
        list,
        (result, c) => _.merge({}, result, c),
        {} as { [key: string]: ChartProvider }
      )
      app.debug(
        `Chart plugin: Found ${
          _.keys(newCharts).length
        } charts from ${activeChartPaths.join(', ')}.`
      )
    } catch (e) {
      // Keep the last-good chartProviders instead of wiping everything - a
      // transient read error (file locked during copy, EBUSY, etc.) shouldn't
      // blank the service out until the next filesystem event.
      console.error(`Error loading chart providers`, (e as Error).message)
      app.setPluginError(`Error loading chart providers`)
      return
    }

    reconcileMbtilesHandles(chartProviders, newCharts)
    chartProviders = _.merge({}, newCharts, activeOnlineProviders)
    app.setPluginStatus(
      `Started - ${_.keys(chartProviders).length} chart(s) loaded`
    )
  }

  // When a file is still present across a reload, reuse the existing SQLite
  // handle instead of the freshly-opened one from findCharts. Closes handles
  // for files that have gone away. Without this, every reload leaks a SQLite
  // connection per MBTiles file.
  const reconcileMbtilesHandles = (
    oldSet: { [key: string]: ChartProvider },
    newSet: { [key: string]: ChartProvider }
  ) => {
    const newPaths = new Set<string>()
    for (const p of Object.values(newSet)) {
      if (p?._filePath) newPaths.add(p._filePath)
    }
    for (const [id, n] of Object.entries(newSet)) {
      const old = oldSet[id]
      if (
        n?._mbtilesHandle &&
        old?._mbtilesHandle &&
        old._filePath === n._filePath
      ) {
        // Drop the newly-opened handle; reuse the existing one so in-flight
        // requests that captured a reference keep working.
        closeMbtilesHandle(n._mbtilesHandle)
        n._mbtilesHandle = old._mbtilesHandle
      }
    }
    for (const old of Object.values(oldSet)) {
      if (
        old?._mbtilesHandle &&
        old._filePath &&
        !newPaths.has(old._filePath)
      ) {
        closeMbtilesHandle(old._mbtilesHandle)
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closeMbtilesHandle = (handle: any) => {
    if (typeof handle?.close !== 'function') return
    try {
      handle.close((err: Error | null) => {
        if (err) app.debug(`MBTiles close error: ${err.message}`)
      })
    } catch (err) {
      app.debug(`MBTiles close threw: ${(err as Error).message}`)
    }
  }

  // Chart folders are watched so new/renamed/deleted files become visible
  // without a plugin restart. FSWatcher bursts events during rename and
  // atomic-save sequences; the debounce collapses a burst into one reload.
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined
      app.debug('Reloading charts after filesystem change')
      loadChartProviders()
    }, RELOAD_DEBOUNCE_MS)
  }

  const startWatchers = () => {
    stopWatchers()
    for (const p of activeChartPaths) {
      watchers.push(...createWatchers(p))
    }
  }

  // recursive:true is the common path on macOS / Windows / Linux (Node 22+).
  // If the platform or filesystem doesn't support it (some network mounts,
  // older Linux), fall back to a non-recursive watch so at least top-level
  // changes are picked up.
  const createWatchers = (p: string): FSWatcher[] => {
    const handlers: FSWatcher[] = []
    try {
      const watcher = fs.watch(p, { encoding: 'utf8', recursive: true }, () =>
        scheduleReload()
      )
      watcher.on('error', (err) =>
        app.debug(`Watcher error on ${p}: ${err.message}`)
      )
      handlers.push(watcher)
      app.debug(`Watching chart folder recursively: ${p}`)
    } catch (err) {
      app.debug(
        `Recursive watch unavailable for ${p} (${
          (err as Error).message
        }); falling back to top-level watch`
      )
      try {
        const watcher = fs.watch(p, { encoding: 'utf8' }, () =>
          scheduleReload()
        )
        watcher.on('error', (e) =>
          app.debug(`Watcher error on ${p}: ${e.message}`)
        )
        handlers.push(watcher)
      } catch (e) {
        app.debug(`Unable to watch ${p}: ${(e as Error).message}`)
      }
    }
    return handlers
  }

  const stopWatchers = () => {
    if (reloadTimer) {
      clearTimeout(reloadTimer)
      reloadTimer = undefined
    }
    while (watchers.length) {
      watchers.pop()?.close()
    }
  }

  const registerRoutes = () => {
    app.debug('** Registering API paths **')

    app.get(
      `${chartTilesPath}/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)`,
      async (req: Request, res: Response) => {
        const { identifier, z, x, y } = req.params
        const ix = parseInt(x)
        const iy = parseInt(y)
        const iz = parseInt(z)
        const provider = chartProviders[identifier]
        if (!provider) {
          return res.sendStatus(404)
        }
        if (provider.proxy === true) {
          return serveTileFromCacheOrRemote(res, provider, iz, ix, iy)
        } else {
          switch (provider._fileFormat) {
            case 'directory':
              return serveTileFromFilesystem(res, provider, iz, ix, iy)
            case 'mbtiles':
              return serveTileFromMbtiles(res, provider, iz, ix, iy)
            default:
              console.log(
                `Unknown chart provider fileformat ${provider._fileFormat}`
              )
              res.status(500).send()
          }
        }
      }
    )

    app.post(
      `${chartTilesPath}/cache/:identifier`,
      async (req: Request, res: Response) => {
        const { identifier } = req.params
        const { regionGUID, tile, bbox, maxZoom } = req.body as {
          regionGUID?: string
          tile?: Tile // query params come in as strings
          bbox?: {
            minLon: number
            minLat: number
            maxLon: number
            maxLat: number
          }
          maxZoom?: string
        }
        const provider = chartProviders[identifier]
        if (!provider) {
          return res.sendStatus(500).send('Provider not found')
        }
        if (!maxZoom) {
          return res.status(400).send('maxZoom parameter is required')
        }
        const maxZoomParsed = parseInt(maxZoom)
        await ChartSeedingManager.createJob(
          app.resourcesApi,
          cachePath,
          provider,
          maxZoomParsed,
          regionGUID,
          bbox
            ? [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat]
            : undefined,
          tile
        )
        return res.status(200).json({
          state: 'COMPLETED',
          statusCode: 200,
          message: 'OK'
        })
      }
    )

    app.get(`${chartTilesPath}/cache/jobs`, (req: Request, res: Response) => {
      const jobs = Object.values(ChartSeedingManager.ActiveJobs).map((job) => {
        return job.info()
      })
      return res.status(200).json(jobs)
    })

    app.post(
      `${chartTilesPath}/cache/jobs/:id`,
      (req: Request, res: Response) => {
        const { id } = req.params
        const { action } = req.body as { action: string }
        const parsedId = parseInt(id)
        const job = ChartSeedingManager.ActiveJobs[parsedId]
        if (job && action) {
          if (action === 'start') {
            job.seedCache()
          } else if (action === 'stop') {
            job.cancelJob()
          } else if (action === 'delete') {
            job.deleteCache()
          } else if (action === 'remove') {
            delete ChartSeedingManager.ActiveJobs[parsedId]
          } else {
            return res.status(404).send(`Job ${parsedId} not found`)
          }
          return res.status(200).send(`Job ${parsedId} ${action}ed`)
        }
      }
    )

    app.debug('** Registering v1 API paths **')

    app.get(
      apiRoutePrefix[1] + '/charts/:identifier',
      (req: Request, res: Response) => {
        const { identifier } = req.params
        const provider = chartProviders[identifier]
        if (provider) {
          return res.json(sanitizeProvider(provider))
        } else {
          return res.status(404).send('Not found')
        }
      }
    )

    app.get(apiRoutePrefix[1] + '/charts', (req: Request, res: Response) => {
      const sanitized = _.mapValues(chartProviders, (provider) =>
        sanitizeProvider(provider)
      )
      res.json(sanitized)
    })
  }

  // Resources API provider registration
  const registerAsProvider = () => {
    app.debug('** Registering as Resource Provider for `charts` **')
    try {
      app.registerResourceProvider({
        type: 'charts',
        methods: {
          listResources: (params: {
            [key: string]: number | string | object | null
          }) => {
            app.debug(`** listResources() ${params}`)
            return Promise.resolve(
              _.mapValues(chartProviders, (provider) =>
                sanitizeProvider(provider, 2)
              )
            )
          },
          getResource: (id: string) => {
            app.debug(`** getResource() ${id}`)
            const provider = chartProviders[id]
            if (provider) {
              return Promise.resolve(sanitizeProvider(provider, 2))
            } else {
              throw new Error('Chart not found!')
            }
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setResource: (id: string, value: any) => {
            throw new Error(`Not implemented!\n Cannot set ${id} to ${value}`)
          },
          deleteResource: (id: string) => {
            throw new Error(`Not implemented!\n Cannot delete ${id}`)
          }
        }
      })
    } catch (error) {
      app.debug('Failed Provider Registration!')
    }
  }

  const serveTileFromCacheOrRemote = async (
    res: Response,
    provider: ChartProvider,
    z: number,
    x: number,
    y: number
  ) => {
    const buffer = await ChartDownloader.getTileFromCacheOrRemote(
      cachePath,
      provider,
      { x, y, z }
    )
    if (!buffer) {
      res.sendStatus(502)
      return
    }
    res.set('Content-Type', `image/${provider.format}`)
    res.send(buffer)
  }

  return plugin
}

const responseHttpOptions = {
  headers: {
    'Cache-Control': 'public, max-age=7776000' // 90 days
  }
}

// Allowed tile file formats. Add new formats here when supporting them.
const ALLOWED_TILE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'pbf'])

const isAllowedTileFormat = (format: string | undefined): boolean => {
  if (!format) return false
  return ALLOWED_TILE_FORMATS.has(format.toLowerCase())
}

const resolveUniqueChartPaths = (
  chartPaths: string[],
  configBasePath: string
) => {
  const paths = _.map(chartPaths, (chartPath) =>
    path.resolve(configBasePath, chartPath)
  )
  return _.uniq(paths)
}

const convertOnlineProviderConfig = (provider: OnlineChartProvider) => {
  const id = _.kebabCase(_.deburr(provider.name))

  const parseHeaders = (
    arr: string[] | undefined
  ): { [key: string]: string } => {
    if (arr === undefined) {
      return {}
    }
    return arr.reduce<{ [key: string]: string }>((acc, entry) => {
      if (typeof entry == 'string') {
        const idx = entry.indexOf(':')
        const key = entry.slice(0, idx).trim()
        const value = entry.slice(idx + 1).trim()
        if (key && value) {
          acc[key] = value
        }
      }
      return acc
    }, {})
  }

  const data = {
    identifier: id,
    name: provider.name,
    description: provider.description,
    bounds: [-180, -90, 180, 90],
    minzoom: Math.min(Math.max(1, provider.minzoom), 24),
    maxzoom: Math.min(Math.max(1, provider.maxzoom), 24),
    format: provider.format,
    scale: 250000,
    type: provider.serverType ? provider.serverType : 'tilelayer',
    style: provider.style ? provider.style : null,
    v1: {
      tilemapUrl: provider.proxy
        ? `~tilePath~/${id}/{z}/{x}/{y}`
        : provider.url,
      chartLayers: provider.layers ? provider.layers : null
    },
    v2: {
      url: provider.proxy ? `~tilePath~/${id}/{z}/{x}/{y}` : provider.url,
      layers: provider.layers ? provider.layers : null
    },
    proxy: provider.proxy ? provider.proxy : false,
    remoteUrl: provider.proxy ? provider.url : null,
    headers: parseHeaders(provider.headers)
  }
  return data
}

const sanitizeProvider = (provider: ChartProvider, version = 1) => {
  let v
  if (version === 1) {
    v = _.merge({}, provider.v1)
    v.tilemapUrl = v.tilemapUrl.replace('~tilePath~', chartTilesPath)
  } else if (version === 2) {
    v = _.merge({}, provider.v2)
    v.url = v.url ? v.url.replace('~tilePath~', chartTilesPath) : ''
  }
  provider = _.omit(provider, [
    '_filePath',
    '_fileFormat',
    '_mbtilesHandle',
    '_flipY',
    'v1',
    'v2'
  ]) as ChartProvider
  return _.merge(provider, v)
}

const ensureDirectoryExists = (path: string) => {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path)
  }
}

const serveTileFromFilesystem = async (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
) => {
  const { format, _flipY, _filePath } = provider
  const normalizedFormat = format?.toLowerCase() ?? ''
  if (!_filePath || !ALLOWED_TILE_FORMATS.has(normalizedFormat)) {
    res.sendStatus(404)
    return
  }
  const flippedY = Math.pow(2, z) - 1 - y
  const file = path.resolve(
    _filePath,
    `${z}/${x}/${_flipY ? flippedY : y}.${normalizedFormat}`
  )
  try {
    const stats = await fs.promises.stat(file)
    if (!stats.isFile()) {
      res.sendStatus(404)
      return
    }
    await fs.promises.access(file, fs.constants.R_OK)
  } catch {
    res.sendStatus(404)
    return
  }
  res.sendFile(file, responseHttpOptions)
}

const serveTileFromMbtiles = (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
) => {
  if (!isAllowedTileFormat(provider.format)) {
    res.sendStatus(404)
    return
  }
  provider._mbtilesHandle.getTile(
    z,
    x,
    y,
    (err: Error, tile: Buffer, headers: OutgoingHttpHeaders) => {
      if (err && err.message && err.message === 'Tile does not exist') {
        res.sendStatus(404)
      } else if (err) {
        console.error(
          `Error fetching tile ${provider.identifier}/${z}/${x}/${y}:`,
          err
        )
        res.sendStatus(500)
      } else {
        headers['Cache-Control'] = responseHttpOptions.headers['Cache-Control']
        res.writeHead(200, headers)
        res.end(tile)
      }
    }
  )
}
