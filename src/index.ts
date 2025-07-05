import * as bluebird from 'bluebird'
import path from 'path'
import fs, { FSWatcher } from 'fs'
import * as _ from 'lodash'
import { findCharts } from './charts'
import { ChartProvider, OnlineChartProvider } from './types'
import { Request, Response, Application } from 'express'
import { OutgoingHttpHeaders } from 'http'
import {
  Plugin,
  ServerAPI,
  ResourceProviderRegistry
} from '@signalk/server-api'

interface Config {
  chartPaths: string[]
  onlineChartProviders: OnlineChartProvider[]
  accessToken: string
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
let chartPaths: Array<string>
let onlineProviders = {}
let lastWatchEvent: number | undefined
const watchers: Array<FSWatcher> = []

module.exports = (app: ChartProviderApp): Plugin => {
  let _chartProviders: { [key: string]: ChartProvider } = {}
  const configBasePath = app.config.configPath
  const defaultChartsPath = path.join(configBasePath, '/charts')
  const serverMajorVersion = app.config.version
    ? parseInt(app.config.version.split('.')[0])
    : '1'
  ensureDirectoryExists(defaultChartsPath)

  // ******** REQUIRED PLUGIN DEFINITION *******
  const CONFIG_SCHEMA = {
    title: 'Signal K Charts',
    type: 'object',
    properties: {
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
                'mapboxstyle',
                'tilejson'
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
    start: (config: object) => {
      return doStartup(config as Config) // return required for tests
    },
    stop: () => {
      watchers.forEach((w) => w.close())
      app.setPluginStatus('stopped')
    }
  }

  const doStartup = async (config: Config) => {
    app.debug(`** loaded config: ${config}`)

    registerRoutes()
    app.setPluginStatus('Started')

    chartPaths = _.isEmpty(config.chartPaths)
      ? [defaultChartsPath]
      : resolveUniqueChartPaths(config.chartPaths, configBasePath)

    onlineProviders = _.reduce(
      config.onlineChartProviders,
      (result: { [key: string]: object }, data) => {
        const provider = convertOnlineProviderConfig(data)
        result[provider.identifier] = provider
        return result
      },
      {}
    )

    chartPaths.forEach((p) => {
      app.debug(`watching folder.. ${p}`)
      watchers.push(fs.watch(p, 'utf8', () => handleWatchEvent()))
    })

    app.debug(
      `Start charts plugin. Chart paths: ${chartPaths.join(
        ', '
      )}, online charts: ${Object.keys(onlineProviders).length}`
    )

    return loadCharts()
  }

  // Load chart files
  const loadCharts = async () => {
    app.debug(`Loading Charts....`)

    try {
      const plist = await bluebird.mapSeries(chartPaths, (chartPath: string) =>
        findCharts(chartPath)
      )
      const charts = _.reduce(
        plist,
        (result, charts) => _.merge({}, result, charts),
        {}
      )
      app.debug(
        `Chart plugin: Found ${
          _.keys(charts).length
        } charts from ${chartPaths.join(', ')}.`
      )
      _chartProviders = _.merge({}, charts, onlineProviders)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      console.error(`Error loading chart providers`, e.message)
      _chartProviders = {}
      app.setPluginError(`Error loading chart providers`)
    }
  }

  const refreshProviders = async () => {
    const td = Date.now() - (lastWatchEvent as number)
    app.debug(`last watch event time elapsed = ${td}`)
    if (lastWatchEvent && td > 5000) {
      app.debug(`Reloading Charts...`)
      lastWatchEvent = undefined
      await loadCharts()
    }
  }

  const getChartProviders = async (): Promise<{
    [id: string]: ChartProvider
  }> => {
    await refreshProviders()
    return _chartProviders
  }

  const handleWatchEvent = () => {
    lastWatchEvent = Date.now()
  }

  const registerRoutes = () => {
    app.debug('** Registering API paths **')

    app.debug(`** Registering map tile path (${chartTilesPath} **`)
    app.get(
      `${chartTilesPath}/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)`,
      async (req: Request, res: Response) => {
        const { identifier, z, x, y } = req.params
        const providers = await getChartProviders()
        if (!providers[identifier]) {
          return res.sendStatus(404)
        }

        switch (providers[identifier]._fileFormat) {
          case 'directory':
            return serveTileFromFilesystem(
              res,
              providers[identifier],
              parseInt(z),
              parseInt(x),
              parseInt(y)
            )
          case 'mbtiles':
            return serveTileFromMbtiles(
              res,
              providers[identifier],
              parseInt(z),
              parseInt(x),
              parseInt(y)
            )
          default:
            console.log(
              `Unknown chart provider fileformat ${providers[identifier]._fileFormat}`
            )
            res.status(500).send()
        }
      }
    )

    app.debug('** Registering v1 API paths **')

    app.get(
      '/signalk/v1/api/resources/charts/:identifier',
      async (req: Request, res: Response) => {
        const { identifier } = req.params
        const providers = await getChartProviders()
        if (providers[identifier]) {
          return res.json(sanitizeProvider(providers[identifier]))
        } else {
          return res.status(404).send('Not found')
        }
      }
    )

    app.get(
      '/signalk/v1/api/resources/charts',
      async (req: Request, res: Response) => {
        const providers = await getChartProviders()
        const sanitized = _.mapValues(providers, (provider) =>
          sanitizeProvider(provider)
        )
        res.json(sanitized)
      }
    )

    // v2 routes
    if (serverMajorVersion === 2) {
      app.debug('** Registering v2 API paths **')
      registerAsProvider()
    }
  }

  // Resources API provider registration
  const registerAsProvider = () => {
    app.debug('** Registering as Resource Provider for `charts` **')
    try {
      app.registerResourceProvider({
        type: 'charts',
        methods: {
          listResources: async (params: {
            [key: string]: number | string | object | null
          }) => {
            app.debug(`** listResources() ${params}`)
            const providers = await getChartProviders()
            return Promise.resolve(
              _.mapValues(providers, (provider) =>
                sanitizeProvider(provider, 2)
              )
            )
          },
          getResource: async (id: string) => {
            app.debug(`** getResource() ${id}`)
            const providers = await getChartProviders()
            if (providers[id]) {
              return Promise.resolve(sanitizeProvider(providers[id], 2))
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

  return plugin
}

const responseHttpOptions = {
  headers: {
    'Cache-Control': 'public, max-age=7776000' // 90 days
  }
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
  const data = {
    identifier: id,
    name: provider.name,
    description: provider.description,
    bounds: [-180, -90, 180, 90],
    minzoom: Math.min(Math.max(1, provider.minzoom), 19),
    maxzoom: Math.min(Math.max(1, provider.maxzoom), 19),
    format: provider.format,
    scale: 250000,
    type: provider.serverType ? provider.serverType : 'tilelayer',
    style: provider.style ? provider.style : null,
    v1: {
      tilemapUrl: provider.url,
      chartLayers: provider.layers ? provider.layers : null
    },
    v2: {
      url: provider.url,
      layers: provider.layers ? provider.layers : null
    }
  }
  return data
}

const sanitizeProvider = (provider: ChartProvider, version = 1) => {
  let v
  if (version === 1) {
    v = _.merge({}, provider.v1)
    v.tilemapUrl = v.tilemapUrl
      ? v.tilemapUrl.replace('~tilePath~', chartTilesPath)
      : ''
  } else {
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

const serveTileFromFilesystem = (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
) => {
  const { format, _flipY, _filePath } = provider
  const flippedY = Math.pow(2, z) - 1 - y
  const file = _filePath
    ? path.resolve(_filePath, `${z}/${x}/${_flipY ? flippedY : y}.${format}`)
    : ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.sendFile(file, responseHttpOptions, (err: any) => {
    if (err && err.code === 'ENOENT') {
      res.sendStatus(404)
    } else if (err) {
      throw err
    }
  })
}

const serveTileFromMbtiles = (
  res: Response,
  provider: ChartProvider,
  z: number,
  x: number,
  y: number
) => {
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
