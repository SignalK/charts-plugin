const Promise = require('bluebird')
const _ = require('lodash')
const path = require('path')
const fs = require('fs')
const Charts = require('./charts')
const {apiRoutePrefix} = require('./constants')

const MIN_ZOOM = 1
const MAX_ZOOM = 24

module.exports = function(app) {
  let apiPath = apiRoutePrefix[1]
  let apiPath = apiRoutePrefix[1]
  let chartProviders = []
  let pluginStarted = false
  let props = {}
  let props = {}
  const configBasePath = app.config.configPath
  const defaultChartsPath = path.join(configBasePath, "/charts")
  ensureDirectoryExists(defaultChartsPath)

  function start(config) {
    app.debug('** loaded config: ', config)
    if (typeof config.api === 'undefined') {
      config.api = 0
    }
    // use server major version to set apiVersion used when auto is selected.
    const serverMajorVersion = app.config.version.split('.')[0]
    if ( config.api === 0) {
      config.api = serverMajorVersion
    }
    props = {...config}
    apiPath = typeof apiRoutePrefix[props.api] !== 'undefined' 
      ? apiRoutePrefix[props.api]
      : apiPath
    app.debug('** applied config:', props)
    app.debug('** apiPath:', apiPath)

    const chartPaths = _.isEmpty(props.chartPaths)
      ? [defaultChartsPath]
      : resolveUniqueChartPaths(props.chartPaths, configBasePath)

    const onlineProviders = _.reduce(props.onlineChartProviders, (result, data) => {
      const provider = convertOnlineProviderConfig(data, props.api)
      result[provider.identifier] = provider
      return result
    }, {})
    app.debug(`Start charts plugin. Chart paths: ${chartPaths.join(', ')}, online charts: ${onlineProviders.length}`)

    const loadProviders = Promise.mapSeries(chartPaths, chartPath => Charts.findCharts(chartPath, apiPath, props.api))
      .then(list => _.reduce(list, (result, charts) => _.merge({}, result, charts), {}))
    return loadProviders.then(charts => {
      app.debug(`Chart plugin: Found ${_.keys(charts).length} charts from ${chartPaths.join(', ')}`)
      chartProviders = _.merge({}, charts, onlineProviders)
      // Do not register routes if plugin has been started once already
      pluginStarted === false && registerRoutes()
      pluginStarted = true
    }).catch(e => {
      console.error(`Error loading chart providers`, e.message)
      chartProviders = {}
    })
  }

  function stop() {
  }

  function registerRoutes() {

    app.get(apiPath + '/charts/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)', (req, res) => {
      const { identifier, z, x, y } = req.params
      const provider = chartProviders[identifier]
      if (!provider) {
        res.sendStatus(404)
        return
      }
      switch (provider._fileFormat) {
        case 'directory':
          return serveTileFromFilesystem(res, provider, z, x, y)
        case 'mbtiles':
          return serveTileFromMbtiles(res, provider, z, x, y)
        default:
          console.error(`Unknown chart provider fileformat ${provider._fileFormat}`)
          res.status(500).send()
      }
    })

    if (typeof props.api === 'undefined' || props.api === 1) {
      app.debug('** Registering v1 API paths **')
      app.get(apiPath + "/charts/:identifier", (req, res) => {
        const { identifier } = req.params
        const provider = chartProviders[identifier]
        if (provider) {
          return res.json(sanitizeProvider(provider))
        } else {
          return res.status(404).send('Not found')
        }
      })

      app.get(apiPath + "/charts", (req, res) => {
        const sanitized = _.mapValues(chartProviders, sanitizeProvider)
        res.json(sanitized)
      })
    } else {
      registerAsProvider()
    }

  }

  function registerAsProvider() {
    app.debug('** Registering as Resource Provider for `charts` **')
    try {
      app.registerResourceProvider({
        type: "charts",
        methods: {
          listResources: (params) => {
            app.debug(`** listResources()`, params)
            return Promise.resolve(
               _.mapValues(chartProviders, sanitizeProvider)
            )
          },
          getResource: (id) => {
            app.debug(`** getResource()`, id)
            const provider = chartProviders[id]
            if (provider) {
              return Promise.resolve(sanitizeProvider(provider))
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
      debug('Failed Provider Registration!')
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
        api: {
          type: 'number',
          title: 'Signal K API version to use (*server restart required)',
          description: '0 = Auto (determined by server version). Defines path to "/signalk/v{}/api/resources/charts"',
          default: 0,
          minimum: 0,
          maximum: 2
        },
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
    stop
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

function convertOnlineProviderConfig(provider, version = 1) {
  const id = _.kebabCase(_.deburr(provider.name))
  const data = {
    identifier: id,
    name: provider.name,
    description: provider.description,
    bounds: [-180, -90, 180, 90],
    minzoom: Math.min(Math.max(1, provider.minzoom), 19),
    maxzoom: Math.min(Math.max(1, provider.maxzoom), 19),
    format: provider.format,
    type: (provider.serverType) ? provider.serverType : 'tilelayer',
    scale: 250000
  }
  if (version === 1) {
    return _.merge(data, {
      tilemapUrl: provider.url,
      chartLayers: (provider.layers) ? provider.layers : null
    })
  } else {
    return _.merge(data, {
      url: provider.url,
      layers: (provider.layers) ? provider.layers : null
    })
  }
}

function sanitizeProvider(provider) {
  return _.omit(provider, ['_filePath', '_fileFormat', '_mbtilesHandle', '_flipY'])
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
