const debug = require('debug')('signalk-charts-plugin')
const Promise = require('bluebird')
const _ = require('lodash')
const path = require('path')
const fs = require('fs')
const Charts = require('./charts')
const {apiRoutePrefix} = require('./constants')

const MIN_ZOOM = 1
const MAX_ZOOM = 19

module.exports = function(app) {
  let chartProviders = []
  let pluginStarted = false
  const configBasePath = app.config.configPath
  const defaultChartsPath = path.join(configBasePath, "/charts")
  ensureDirectoryExists(defaultChartsPath)

  function start(props) {
    const chartPaths = _.isEmpty(props.chartPaths)
      ? [defaultChartsPath]
      : resolveUniqueChartPaths(props.chartPaths, configBasePath)
    const onlineProviders = _.reduce(props.onlineChartProviders, (result, data) => {
      const provider = convertOnlineProviderConfig(data)
      result[provider.identifier] = provider
      return result
    }, {})
    debug(`Start charts plugin. Chart paths: ${chartPaths.join(', ')}, online charts: ${onlineProviders.length}`)

    const loadProviders = Promise.mapSeries(chartPaths, chartPath => Charts.findCharts(chartPath))
      .then(list => _.reduce(list, (result, charts) => _.merge({}, result, charts), {}))
    return loadProviders.then(charts => {
      console.log(`Chart plugin: Found ${_.keys(charts).length} charts from ${chartPaths.join(', ')}`)
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
    debug("Chart plugin stopped")
  }

  function registerRoutes() {
    app.get(apiRoutePrefix + '/charts/:identifier/:z([0-9]*)/:x([0-9]*)/:y([0-9]*)', (req, res) => {
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

    app.get(apiRoutePrefix + "/charts/:identifier", (req, res) => {
      const { identifier } = req.params
      const provider = chartProviders[identifier]
      if (provider) {
        return res.json(sanitizeProvider(provider))
      } else {
        return res.status(404).send('Not found')
      }
    })

    app.get(apiRoutePrefix + "/charts", (req, res) => {
      const sanitized = _.mapValues(chartProviders, sanitizeProvider)
      res.json(sanitized)
    })
  }

  return {
    id: 'charts',
    name: 'Signal K Charts',
    description: 'Singal K Charts resource',
    schema: {
      title: 'Signal K Charts',
      description: `Add one or more paths to find charts. Defaults to "${defaultChartsPath}"`,
      type: 'object',
      properties: {
        chartPaths: {
          type: 'array',
          title: 'Chart paths',
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
                title: 'Server Type',
                default: 'tilelayer',
                enum: ['tilelayer', 'WMS']
              },
              format: {
                type: 'string',
                title: 'Format',
                default: 'png',
                enum: ['png', 'jpg']
              },
              url: {
                type: 'string',
                title: 'URL',
                description: 'Tileset URL containing {z}, {x} and {y} parameters, for example "http://example.org/{z}/{x}/{y}.png"'
              },
              layers: {
                type: 'array',
                title: 'Layers',
                items: {
                    title: 'Layer Name',
                    description: '(WMS maps only) Name of layer to fetch and display',
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

function convertOnlineProviderConfig(provider) {
  const id = _.kebabCase(_.deburr(provider.name))
  return {
    name: provider.name,
    description: provider.description,
    bounds: [-180, -90, 180, 90],
    minzoom: Math.min(Math.max(1, provider.minzoom), 19),
    maxzoom: Math.min(Math.max(1, provider.maxzoom), 19),
    format: provider.format,
    scale: 'N/A',
    identifier: id,
    tilemapUrl: provider.url,
    type: (provider.serverType) ? provider.serverType : 'tilelayer',
    chartLayers: (provider.layers) ? provider.layers : null
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
