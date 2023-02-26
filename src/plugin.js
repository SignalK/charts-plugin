const Promise = require('bluebird')
const _ = require('lodash')
const path = require('path')
const fs = require('fs')
const Charts = require('./charts')
const {apiRoutePrefix} = require('./constants')
const pmtiles = require('./pmtiles')

const MIN_ZOOM = 1
const MAX_ZOOM = 24

module.exports = function(app) {
  let chartProviders = []
  let pluginStarted = false
  let props = {}
  const configBasePath = app.config.configPath
  const defaultChartsPath = path.join(configBasePath, "/charts")
  const serverMajorVersion = parseInt(app.config.version.split('.')[0])
  ensureDirectoryExists(defaultChartsPath)

  function start(config) {
    app.debug('** loaded config: ', config)
    props = {...config}

    const chartPaths = _.isEmpty(props.chartPaths)
      ? [defaultChartsPath]
      : resolveUniqueChartPaths(props.chartPaths, configBasePath)

    const onlineProviders = _.reduce(props.onlineChartProviders, (result, data) => {
      const provider = convertOnlineProviderConfig(data)
      result[provider.identifier] = provider
      return result
    }, {})
    app.debug(`Start charts plugin. Chart paths: ${chartPaths.join(', ')}, online charts: ${Object.keys(onlineProviders).length}`)

    // Do not register routes if plugin has been started once already
    pluginStarted === false && registerRoutes()
    pluginStarted = true
    const hostPort = app.config.getExternalPort() || 3000

    const loadProviders = Promise.mapSeries(chartPaths, chartPath => Charts.findCharts(chartPath, hostPort))
    .then(list => _.reduce(list, (result, charts) => _.merge({}, result, charts), {}))

    return loadProviders.then(charts => {
      app.debug(`Chart plugin: Found ${_.keys(charts).length} charts from ${chartPaths.join(', ')}`)
      chartProviders = _.merge({}, charts, onlineProviders)
      // populate PMTiles metadata (requires router paths to be active)
      pmtiles.getMetadata(chartProviders)
    }).catch(e => {
      console.error(`Error loading chart providers`, e.message)
      chartProviders = {}
    })
  }

  function stop() {
  }


  async function getMapTiles(params, response) {
    const { identifier, z, x, y } = params
    const provider = chartProviders[identifier]
    if (!provider) {
      return response.sendStatus(404)
    }
    switch (provider._fileFormat) {
      case 'directory':
        return serveTileFromFilesystem(response, provider, z, x, y)
      case 'mbtiles':
        return serveTileFromMbtiles(response, provider, z, x, y)
      default:
        throw new Error(`Unknown chart provider fileformat ${provider._fileFormat}`)
    }
  }

  function registerRoutes() {

    app.debug('** Registering routes **')

    app.get(
      `${apiRoutePrefix[1]}/charts/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)`, 
      async (req, res) => {
        try {
          const r = await getMapTiles(req.params, res)
          return r
        } catch (err) {
          res.status(500).send()
        }
      }
    )

    app.get(`${apiRoutePrefix[2]}/charts/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)`, 
      async (req, res) => {
        try {
          const r = await getMapTiles(req.params, res)
          return r
        } catch (err) {
          res.status(500).send()
        }
      }
    )

    app.debug('** Registering v1 API paths **')

    app.get(apiRoutePrefix[1] + "/charts/:identifier", (req, res) => {
      const { identifier } = req.params
      const provider = chartProviders[identifier]
      if (provider) {
        return res.json(sanitizeProvider(provider))
      } else {
        return res.status(404).send('Not found')
      }
    })

    app.get(apiRoutePrefix[1] + "/charts", (req, res) => {
      const sanitized = _.mapValues(chartProviders, (provider) => sanitizeProvider(provider))
      res.json(sanitized)
    })

    // v2 routes
    if (serverMajorVersion === 2) {
      app.debug('** Registering v2 API paths **')
      registerAsProvider()
    }
  }

  // plugin service endpoints
  function initPluginApi(router) {

    app.debug('** Registering Plugin api endpoints **')

    // get PMTiles file contents
    router.get(`/pmtiles/:identifier`, (req, res) => {
      app.debug(`GET /pmtiles/${req.params.identifier}`)
      const { identifier } = req.params
      const provider = chartProviders[identifier]
      if (provider) {
        res.sendFile(provider._filePath)
      } else {
        res.status(404).send('Not found')
      }
    })
  }

  // Resources API provider registration
  function registerAsProvider() {
    app.debug('** Registering as Resource Provider for `charts` **')
    try {
      app.registerResourceProvider({
        type: "charts",
        methods: {
          listResources: (params) => {
            app.debug(`** listResources()`, params)
            return Promise.resolve(
               _.mapValues(chartProviders, (provider) => sanitizeProvider(provider, 2))
            )
          },
          getResource: (id) => {
            app.debug(`** getResource()`, id)
            const provider = chartProviders[id]
            if (provider) {
              return Promise.resolve(sanitizeProvider(provider, 2))
            } else {
              throw new Error('Chart not found!')
            }
          },
          setResource: (id, value) => {
            throw new Error('Not implemented!')
          },
          deleteResource: (id) => {
            throw new Error('Not implemented!')
          }
        }
      })
    } catch (error) {
      app.debug('Failed Provider Registration!')
    }
  }

  return {
    id: 'charts',
    name: 'Signal K Charts',
    description: 'Singal K Charts resource',
    schema: {
      title: 'Signal K Charts',
      type: 'object',
      properties: {
        chartPaths: {
          type: 'array',
          title: 'Chart paths',
          description: `Add one or more paths to find charts. Defaults to "${defaultChartsPath}"`,
          items: {
            type: 'string',
            title: "Path",
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
                default: MIN_ZOOM,
              },
              maxzoom: {
                type: 'number',
                title: `Maximum zoom level, between [${MIN_ZOOM}, ${MAX_ZOOM}]`,
                maximum: MAX_ZOOM,
                minimum: MIN_ZOOM,
                default: 15,
              },
              serverType: {
                type: 'string',
                title: 'Map source / server type',
                default: 'tilelayer',
                enum: ['tilelayer', 'tileJSON', 'WMS', 'WMTS'],
                description: 'Map data source type served by the supplied url. (Use tilelayer for xyz / tms tile sources.)'
              },
              format: {
                type: 'string',
                title: 'Format',
                default: 'png',
                enum: ['png', 'jpg', 'pbf'],
                description: 'Format of map tiles: raster (png, jpg, etc.) / vector (pbf).'
              },
              url: {
                type: 'string',
                title: 'URL',
                description: 'Map URL (for tilelayer include {z}, {x} and {y} parameters, e.g. "http://example.org/{z}/{x}/{y}.png")'
              },
              layers: {
                type: 'array',
                title: 'Layers',
                description: 'List of map layer ids to display. (Use with WMS / WMTS types.)',
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
    },
    start,
    stop,
    registerWithRouter: (router) => {
      return initPluginApi(router);
    }
  }
}


const responseHttpOptions = {
  headers: {
    'Cache-Control': 'public, max-age=7776000' // 90 days
  }
}

function resolveUniqueChartPaths(chartPaths, configBasePath) {
  const paths = _.map(chartPaths, chartPath => path.resolve(configBasePath, chartPath))
  return _.uniq(paths)
}

function convertOnlineProviderConfig(provider) {
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
    type: (provider.serverType) ? provider.serverType : 'tilelayer',
    v1: {
      tilemapUrl: provider.url,
      chartLayers: (provider.layers) ? provider.layers : null
    },
    v2: {
      url: provider.url,
      layers: (provider.layers) ? provider.layers : null
    }
  }
  return data
}

function sanitizeProvider(provider, version = 1) {
  let v
  if (version === 1) {
    v =_.merge( {}, provider.v1)
    v.tilemapUrl = v.tilemapUrl.replace('~basePath~', apiRoutePrefix[1])
  } else if (version === 2) {
    v =_.merge( {}, provider.v2)
    v.url =v.url.replace('~basePath~', apiRoutePrefix[2])
  }
  provider = _.omit(provider, ['_filePath', '_fileFormat', '_mbtilesHandle', '_flipY', '_pmtilesHandle', 'v1', 'v2'])
  return _.merge( provider, v)
}

function ensureDirectoryExists (path) {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path)
  }
}

function serveTileFromFilesystem(res, provider, z, x, y) {
  const {identifier, format, _flipY, _filePath} = provider
  const flippedY = Math.pow(2, z) - 1 - y
  const file = path.resolve(_filePath, `${z}/${x}/${_flipY ? flippedY : y}.${format}`)
  res.sendFile(file, responseHttpOptions, (err) => {
    if (err && err.code === 'ENOENT') {
      res.sendStatus(404)
    } else if (err) {
      throw err
    }
  })
}

function serveTileFromMbtiles(res, provider, z, x, y) {
  provider._mbtilesHandle.getTile(z, x, y, (err, tile, headers) => {
    if (err && err.message && err.message === 'Tile does not exist') {
      res.sendStatus(404)
    } else if (err) {
      console.error(`Error fetching tile ${provider.identifier}/${z}/${x}/${y}:`, err)
      res.sendStatus(500)
    } else {
      headers['Cache-Control'] = responseHttpOptions.headers['Cache-Control']
      res.writeHead(200, headers)
      res.end(tile)
    }
  })
}
