const debug = require('debug')('signalk-charts-plugin')
const _ = require('lodash')
const path = require('path')
const fs = require('fs')
const Charts = require('./charts')
const {apiRoutePrefix} = require('./constants')

module.exports = function(app) {
  let chartProviders = []
  let pluginStarted = false
  const configBasePath = app.config.configPath
  const defaultChartsPath = path.join(configBasePath, "/charts")
  ensureDirectoryExists(defaultChartsPath)

  function start(props) {
    const chartsPath = props.chartsPath ? path.resolve(configBasePath, props.chartsPath) : defaultChartsPath
    debug(`Start plugin, charts path: ${chartsPath}`)
    const loadProviders = Charts.findCharts(chartsPath)
    return loadProviders.then(charts => {
      console.log(`Chart plugin: Found ${_.keys(charts).length} charts from ${chartsPath}`)
      chartProviders = charts
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
      type: 'object',
      properties: {
        chartsPath: {
          type: 'string',
          title: "Charts path",
          description: `Path for chart files, relative to "${configBasePath}". Defaults to "${defaultChartsPath}".`
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
