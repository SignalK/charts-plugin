import path from 'path'
import fs, { FSWatcher } from 'fs'
import * as _ from 'lodash'
import { findCharts } from './charts'
import { apiRoutePrefix } from './constants'
import { composeStatus, ChartPathCount } from './pluginStatus'
import { ChartProvider, MBTilesHandle, OnlineChartProvider } from './types'
import { ChartSeedingManager, Tile } from './chartDownloader'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  serveTileFromCacheOrRemote,
  serveTileFromFilesystem,
  serveTileFromMbtiles,
  validateBBox,
  validateMaxZoom,
  validateTileCoords
} from './tileServer'
import { Request, Response, Application } from 'express'
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
  extends ServerAPI, ResourceProviderRegistry, Application {
  config: {
    ssl: boolean
    configPath: string
    version: string
    getExternalPort: () => number
  }
}

const chartTilesPath = '/signalk/chart-tiles'
// Debounce window used to collapse FSWatcher bursts during rename / atomic-save
// sequences into one reload. Overridable via env var so tests don't have to
// wait the full 5s on every watcher assertion.
const RELOAD_DEBOUNCE_MS =
  Number(process.env.SK_CHARTS_RELOAD_DEBOUNCE_MS) || 5000

type SanitizedProvider = Record<string, unknown>

const createPlugin = (app: ChartProviderApp): Plugin => {
  let chartProviders: { [key: string]: ChartProvider } = {}
  // Pre-computed per-version views of chartProviders, rebuilt on every reload.
  // The HTTP handlers serve directly from here so tile-list requests don't pay
  // a deep clone per provider on the hot path.
  let sanitizedV1: { [key: string]: SanitizedProvider } = {}
  let sanitizedV2: { [key: string]: SanitizedProvider } = {}
  let pluginStarted = false
  let providerRegistered = false
  let props: Config = {
    chartPaths: [],
    cachePath: '',
    onlineChartProviders: []
  }

  let urlBase = ''
  const configBasePath = app.config.configPath
  const defaultChartsPath = path.join(configBasePath, '/charts')
  const serverMajorVersion = app.config.version
    ? parseInt(app.config.version.split('.')[0] ?? '0')
    : 1

  let cachePath = defaultChartsPath

  // Chart-folder watcher state, plugin-scoped so stop()/start() cycles reset cleanly.
  // activeChartPaths / activeOnlineProviders hold the last-known config so a
  // watcher-triggered reload can reuse it without re-running doStartup.
  const watchers: FSWatcher[] = []
  let reloadTimer: NodeJS.Timeout | undefined
  let activeChartPaths: string[] = []
  let activeOnlineProviders: { [key: string]: object } = {}
  // Last scan result, surfaced in the config schema description so the admin
  // UI shows per-path counts when the user reopens the plugin config. Issue #8.
  let lastChartPathCounts: ChartPathCount[] = []

  // Check Node version for schema
  const nodeVersion = process.versions.node
  const nodeMajorVersion = parseInt(nodeVersion.split('.')[0] ?? '0')

  // Builds the `chartPaths` description, appending the latest per-path chart
  // counts when available. The admin UI re-fetches the schema every time the
  // plugin config page opens, so this text refreshes on reload. Issue #8.
  const chartPathsDescription = () => {
    const base = `Add one or more paths to find charts. Defaults to "${defaultChartsPath}"`
    if (lastChartPathCounts.length === 0) return base
    const parts = lastChartPathCounts.map(
      (p) => `${p.chartPath} (${p.count} ${p.count === 1 ? 'chart' : 'charts'})`
    )
    return `${base}. Last scan: ${parts.join(', ')}.`
  }

  // ******** REQUIRED PLUGIN DEFINITION *******
  // Schema is built inside schema() rather than a module-level const, because
  // chartPaths.description depends on the last scan result, which only exists
  // after the plugin has run at least once.
  const buildConfigSchema = () => ({
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
        description: chartPathsDescription(),
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
  })

  const CONFIG_UISCHEMA = {}

  const plugin: Plugin = {
    id: 'charts',
    name: 'Signal K Charts',
    schema: () => buildConfigSchema(),
    uiSchema: () => CONFIG_UISCHEMA,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start: (settings: any) => {
      return doStartup(settings) // return required for tests
    },
    stop: () => {
      // Surface stop() calls so an unexpected Signal K-initiated restart
      // (config reload, server shutdown, error cascade) is visible in logs
      // instead of silently emptying chartProviders.
      console.log(
        `Signal K Charts: stop() called (${
          Object.keys(chartProviders).length
        } provider(s) will be released)`
      )
      stopWatchers()
      // Cancel any running seeding jobs so a disabled plugin doesn't keep
      // pulling tiles from remote providers in the background.
      ChartSeedingManager.cancelAll()
      // Close open SQLite connections so the user can move or delete chart
      // files while the plugin is stopped (Windows blocks deletion on open
      // handles). Restart re-opens fresh via findCharts.
      for (const p of Object.values(chartProviders)) {
        if (p?._mbtilesHandle) closeMbtilesHandle(p._mbtilesHandle)
      }
      chartProviders = {}
      sanitizedV1 = {}
      sanitizedV2 = {}
      app.setPluginStatus('stopped')
    }
  }

  const doStartup = async (config: Config) => {
    // Check Node version
    const nodeVersion = process.versions.node
    const majorVersion = parseInt(nodeVersion.split('.')[0] ?? '0')
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

    activeChartPaths = !props.chartPaths?.length
      ? [defaultChartsPath]
      : resolveUniqueChartPaths(props.chartPaths, configBasePath)
    cachePath = props.cachePath || defaultChartsPath
    // Both paths commonly coincide on a fresh install; ensure they exist once
    // here rather than at plugin construction time, which kept us off the
    // sync-fs path at module load.
    await ensureDirectoryExists(defaultChartsPath)
    if (cachePath !== defaultChartsPath) {
      await ensureDirectoryExists(cachePath)
    }

    activeOnlineProviders = {}
    for (const data of props.onlineChartProviders ?? []) {
      const provider = convertOnlineProviderConfig(data)
      if (activeOnlineProviders[provider.identifier]) {
        app.debug(
          `Duplicate online provider identifier "${provider.identifier}" ` +
            `(from name "${data.name}"); the later entry wins. ` +
            `Rename one of the providers to avoid the collision.`
        )
      }
      activeOnlineProviders[provider.identifier] = provider
    }
    app.debug(
      `Start charts plugin. Chart paths: ${activeChartPaths.join(
        ', '
      )}, online charts: ${Object.keys(activeOnlineProviders).length}`
    )

    // Routes and the v2 provider registration are idempotent — Signal K can
    // call start() again after a config change, but re-registering would
    // either throw or duplicate the handler.
    if (!pluginStarted) registerRoutes()
    pluginStarted = true
    if (serverMajorVersion === 2 && !providerRegistered) {
      app.debug('** Registering v2 API paths **')
      registerAsProvider()
      providerRegistered = true
    }

    app.setPluginStatus('Started')

    startWatchers()
    return loadChartProviders()
  }

  const loadChartProviders = async (): Promise<void> => {
    // Scan configured chart paths in parallel. findCharts already bounds its
    // own per-file concurrency internally, so kicking off multiple roots at
    // once just overlaps their directory reads.
    let results: ({ [key: string]: ChartProvider } | undefined)[]
    // onScanError fires when findCharts hits a non-trivial error (readdir
    // failure, non-ENOENT fs.stat, MBTiles open crash) — i.e. something that
    // could leave chartProviders incomplete. A reload that produces zero
    // charts with errorsDuringScan=true is treated as transient and the
    // last-good set is kept; without errors, zero is trusted as legitimate
    // (user deleted all chart files).
    let errorsDuringScan = false
    try {
      results = await Promise.all(
        activeChartPaths.map((chartPath) =>
          findCharts(chartPath, () => {
            errorsDuringScan = true
          })
        )
      )
    } catch (e) {
      // Keep the last-good chartProviders instead of wiping everything - a
      // transient read error (file locked during copy, EBUSY, etc.) shouldn't
      // blank the service out until the next filesystem event.
      console.error(`Error loading chart providers`, (e as Error).message)
      app.setPluginError(`Error loading chart providers`)
      return
    }

    // Identifier is the source of uniqueness: a deep-merge here would cost
    // O(N²) property copies for identical keys while adding nothing over a
    // plain shallow assignment.
    const newCharts: { [key: string]: ChartProvider } = {}
    const perPath: ChartPathCount[] = []
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const chartPath = activeChartPaths[i] ?? ''
      const pathEntries = r ? Object.entries(r) : []
      perPath.push({ chartPath, count: pathEntries.length })
      for (const [id, chart] of pathEntries) {
        if (newCharts[id]) {
          app.debug(
            `Duplicate chart identifier "${id}" from multiple chart paths; ` +
              `the later one wins.`
          )
        }
        newCharts[id] = chart
      }
    }
    lastChartPathCounts = perPath
    app.debug(
      `Chart plugin: Found ${
        Object.keys(newCharts).length
      } charts from ${activeChartPaths.join(', ')}.`
    )

    // Defensive: if a reload turns up zero local charts AND something went
    // wrong during the scan (errorsDuringScan) AND we previously held charts,
    // treat the empty result as transient and keep the last-good set instead
    // of quietly 404-ing every tile request until the next successful reload.
    // Zero charts WITHOUT errors is trusted (user legitimately removed all
    // charts).
    const previousLocalCount = Object.keys(chartProviders).filter(
      (id) => !activeOnlineProviders[id]
    ).length
    if (
      Object.keys(newCharts).length === 0 &&
      previousLocalCount > 0 &&
      errorsDuringScan
    ) {
      console.warn(
        `Signal K Charts: reload produced 0 charts from [${activeChartPaths.join(
          ', '
        )}] after errors during scan; keeping last-good set of ${previousLocalCount} chart(s).`
      )
      app.setPluginStatus(
        composeStatus(perPath, Object.keys(activeOnlineProviders).length)
      )
      return
    }

    reconcileMbtilesHandles(chartProviders)
    // Shallow assign is enough: newCharts and activeOnlineProviders both
    // have unique ids per entry; the values themselves are used by reference.
    chartProviders = { ...newCharts }
    for (const [id, provider] of Object.entries(activeOnlineProviders)) {
      if (chartProviders[id]) {
        app.debug(
          `Online provider identifier "${id}" collides with a local chart; ` +
            `the online provider wins.`
        )
      }
      chartProviders[id] = provider as ChartProvider
    }
    buildSanitizedCache()
    app.setPluginStatus(
      composeStatus(perPath, Object.keys(activeOnlineProviders).length)
    )
  }

  // Rebuilds the per-version sanitized views. Called once per reload so the
  // HTTP handlers can hand out pre-built dictionaries instead of deep-cloning
  // every provider on every metadata request.
  const buildSanitizedCache = () => {
    sanitizedV1 = {}
    sanitizedV2 = {}
    for (const [id, provider] of Object.entries(chartProviders)) {
      sanitizedV1[id] = sanitizeProvider(provider, 1)
      sanitizedV2[id] = sanitizeProvider(provider, 2)
    }
  }

  // Close every old MBTiles handle after a reload. findCharts opened fresh
  // handles for every file that still exists, so the NEW set reflects current
  // content — including files that were replaced in place (same filename,
  // new content). Reusing the old handle in that case would serve stale tiles
  // from SQLite's cached pages. Close is delayed so an in-flight tile request
  // that captured a reference has time to complete before the handle goes
  // away; 1s is well above realistic tile-serve latency.
  const MBTILES_CLOSE_DELAY_MS = 1000
  const reconcileMbtilesHandles = (oldSet: {
    [key: string]: ChartProvider
  }) => {
    for (const old of Object.values(oldSet)) {
      if (old?._mbtilesHandle) {
        const handle = old._mbtilesHandle
        setTimeout(() => closeMbtilesHandle(handle), MBTILES_CLOSE_DELAY_MS)
      }
    }
  }

  const closeMbtilesHandle = (handle: MBTilesHandle) => {
    if (typeof handle?.close !== 'function') return
    try {
      handle.close((err) => {
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
      `${chartTilesPath}/:identifier/:z/:x/:y`,
      async (
        req: Request<{ identifier: string; z: string; x: string; y: string }>,
        res: Response
      ) => {
        const { identifier, z, x, y } = req.params
        if (!identifier || !z || !x || !y) {
          return res.sendStatus(404)
        }
        const iz = parseInt(z)
        const ix = parseInt(x)
        const iy = parseInt(y)
        const coordError = validateTileCoords(iz, ix, iy)
        if (coordError) {
          return res.status(400).send(coordError)
        }
        const provider = chartProviders[identifier]
        if (!provider) {
          return res.sendStatus(404)
        }
        if (provider.proxy === true) {
          return serveTileFromCacheOrRemote(
            res,
            cachePath,
            provider,
            iz,
            ix,
            iy
          )
        } else {
          switch (provider._fileFormat) {
            case 'directory':
              return serveTileFromFilesystem(res, provider, iz, ix, iy)
            case 'mbtiles':
              return serveTileFromMbtiles(res, provider, iz, ix, iy)
            default:
              app.debug(
                `Unknown chart provider fileformat ${provider._fileFormat}`
              )
              res.status(500).send()
          }
        }
      }
    )

    app.post(
      `${chartTilesPath}/cache/:identifier`,
      async (req: Request<{ identifier: string }>, res: Response) => {
        const { identifier } = req.params
        if (!identifier) {
          return res.sendStatus(404)
        }
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
          return res.status(404).send('Provider not found')
        }
        if (!maxZoom) {
          return res.status(400).send('maxZoom parameter is required')
        }
        if (!regionGUID && !bbox && !tile) {
          return res
            .status(400)
            .send('Request must include regionGUID, bbox, or tile')
        }
        const maxZoomParsed = parseInt(maxZoom)
        const zoomError = validateMaxZoom(maxZoomParsed)
        if (zoomError) {
          return res.status(400).send(zoomError)
        }
        if (bbox) {
          const bboxError = validateBBox(bbox)
          if (bboxError) {
            return res.status(400).send(bboxError)
          }
        }
        if (tile) {
          const tileError = validateTileCoords(tile.z, tile.x, tile.y)
          if (tileError) {
            return res.status(400).send(tileError)
          }
        }
        try {
          const job = await ChartSeedingManager.createJob(
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
          // Job is registered and its tile set is known, but nothing has been
          // downloaded yet — the caller starts it with
          // POST /cache/jobs/:id { action: 'start' }.
          return res.status(202).json(job.info())
        } catch (err) {
          return res
            .status(500)
            .send(`Failed to create seeding job: ${(err as Error).message}`)
        }
      }
    )

    app.get(`${chartTilesPath}/cache/jobs`, (_req: Request, res: Response) => {
      const jobs = Object.values(ChartSeedingManager.ActiveJobs).map((job) => {
        return job.info()
      })
      return res.status(200).json(jobs)
    })

    app.post(
      `${chartTilesPath}/cache/jobs/:id`,
      (req: Request<{ id: string }>, res: Response) => {
        const { id } = req.params
        if (!id) {
          return res.sendStatus(404)
        }
        const { action } = req.body as { action: string }
        const parsedId = parseInt(id)
        if (!Number.isFinite(parsedId)) {
          return res.status(400).send(`Invalid job id: ${id}`)
        }
        const job = ChartSeedingManager.ActiveJobs[parsedId]
        if (!job) {
          return res.status(404).send(`Job ${parsedId} not found`)
        }
        if (!action) {
          return res.status(400).send('action parameter is required')
        }
        if (action === 'start') {
          job.seedCache()
        } else if (action === 'stop') {
          job.cancelJob()
        } else if (action === 'delete') {
          job.deleteCache()
        } else if (action === 'remove') {
          delete ChartSeedingManager.ActiveJobs[parsedId]
        } else {
          return res.status(400).send(`Unknown action: ${action}`)
        }
        return res.status(200).send(`Job ${parsedId} ${action}ed`)
      }
    )

    app.debug('** Registering v1 API paths **')

    app.get(
      apiRoutePrefix[1] + '/charts/:identifier',
      (req: Request<{ identifier: string }>, res: Response) => {
        const { identifier } = req.params
        if (!identifier) {
          return res.sendStatus(404)
        }
        const view = sanitizedV1[identifier]
        if (view) {
          return res.json(view)
        } else {
          return res.status(404).send('Not found')
        }
      }
    )

    app.get(apiRoutePrefix[1] + '/charts', (_req: Request, res: Response) => {
      res.json(sanitizedV1)
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
            return Promise.resolve(sanitizedV2)
          },
          getResource: (id: string) => {
            app.debug(`** getResource() ${id}`)
            const view = sanitizedV2[id]
            if (view) {
              return Promise.resolve(view)
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
      app.setPluginError(
        `Failed to register as charts resource provider: ${
          (error as Error).message
        }`
      )
    }
  }

  return plugin
}

export = createPlugin

const resolveUniqueChartPaths = (
  chartPaths: string[],
  configBasePath: string
) => {
  const paths = chartPaths.map((chartPath) =>
    path.resolve(configBasePath, chartPath)
  )
  return [...new Set(paths)]
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
    minzoom: Math.min(Math.max(MIN_ZOOM, provider.minzoom), MAX_ZOOM),
    maxzoom: Math.min(Math.max(MIN_ZOOM, provider.maxzoom), MAX_ZOOM),
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

// Builds the outward-facing view of a provider for either the v1 or v2 API.
// Copies non-private top-level fields, then overlays the version-specific
// block (v1 has tilemapUrl/chartLayers, v2 has url/layers), rewriting the
// tile-path placeholder. Intentionally a single shallow walk — the previous
// implementation did three deep clones per call and ran per metadata request.
const sanitizeProvider = (
  provider: ChartProvider,
  version: 1 | 2 = 1
): SanitizedProvider => {
  const out: SanitizedProvider = {}
  for (const [key, value] of Object.entries(provider)) {
    if (key.startsWith('_') || key === 'v1' || key === 'v2') continue
    out[key] = value
  }
  const v = version === 1 ? provider.v1 : provider.v2
  if (v) {
    for (const [key, value] of Object.entries(v)) {
      out[key] = value
    }
  }
  if (version === 1 && typeof out.tilemapUrl === 'string') {
    out.tilemapUrl = out.tilemapUrl.replace('~tilePath~', chartTilesPath)
  } else if (version === 2 && typeof out.url === 'string') {
    out.url = out.url.replace('~tilePath~', chartTilesPath)
  } else if (version === 2) {
    out.url = ''
  }
  return out
}

const ensureDirectoryExists = async (p: string) => {
  // mkdir with recursive:true is idempotent and skips the existsSync probe,
  // keeping startup off the sync-fs path.
  await fs.promises.mkdir(p, { recursive: true })
}
