/**
 * Integration tests for the charts plugin. Spins up an Express app,
 * registers the plugin, issues HTTP requests via chai-http, and asserts
 * responses against expected fixtures.
 */

import fs from 'fs'
import path from 'path'
import http from 'http'
import * as _ from 'lodash'
import express from 'express'
import bodyParser from 'body-parser'
import chai from 'chai'
import chaiHttp from 'chai-http'
import Plugin = require('../plugin/index')
import expectedCharts from './expected-charts.json'

chai.use(chaiHttp)
const expect = chai.expect

type PluginInstance = ReturnType<typeof Plugin>

describe('GET /resources/charts', () => {
  let plugin: PluginInstance
  let testServer: http.Server

  beforeEach(() =>
    createDefaultApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )
  afterEach(done => testServer.close(() => done()))

  it('returns all charts for default path', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then(result => {
        expect(result.status).to.equal(200)
        const resultCharts = result.body
        expect(_.keys(resultCharts).length).to.deep.equal(3)
        expect(resultCharts).to.deep.equal(expectedCharts)
      })
  })

  it('handle canonical paths', () => {
    return plugin.start({chartPaths: ['charts', path.resolve(__dirname, 'charts').toString()]})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then(result => {
        expect(result.status).to.equal(200)
        const resultCharts = result.body
        expect(_.keys(resultCharts).length).to.deep.equal(3)
      })
  })

  it('returns all charts for multiple paths', () => {
    return plugin.start({chartPaths: ['charts', 'charts-2']})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then(result => {
        expect(result.status).to.equal(200)
        const resultCharts = result.body
        expect(_.keys(resultCharts).length).to.deep.equal(4)
        expect(resultCharts['test2']).not.to.equal(undefined)
      })
  })

  it('returns empty charts for custom path', () => {
    return plugin.start({chartPaths: ['../src/']})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then(result => {
        expect(result.status).to.equal(200)
        expect(result.body).to.deep.equal({})
      })
  })

  it('returns online chart providers', () => {
    return plugin.start({chartPaths: ['charts'], onlineChartProviders: [
        {name: 'Test Name', minzoom: 2, maxzoom: 15, format: 'jpg', url: 'https://example.com'}
      ]})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then(result => {
        expect(result.body['test-name']).to.deep.equal({
          bounds: [-180, -90, 180, 90],
          format: 'jpg',
          headers: {},
          identifier: 'test-name',
          maxzoom: 15,
          minzoom: 2,
          name: 'Test Name',
          proxy: false,
          remoteUrl: null,
          scale: 250000,
          "style": null,
          tilemapUrl: 'https://example.com',
          type: 'tilelayer',
          chartLayers: null
        })
      })
  })

  it('returns one chart', () => {
    const identifier = 'test'
    return plugin.start({})
      .then(() => get(testServer, `/signalk/v1/api/resources/charts/${identifier}`))
      .then(result => {
        expect(result.status).to.equal(200)
        expect(result.body).to.deep.equal(expectedCharts[identifier as keyof typeof expectedCharts])
      })
  })

  it('returns 404 for unknown chart', () => {
    return plugin.start({})
      .then(() => get(testServer, `/signalk/v1/api/resources/charts/foo`))
      .catch(e => e.response)
      .then(result => {
        expect(result.status).to.equal(404)
      })
  })

})

describe('GET /signalk/chart-tiles/:identifier/:z/:x/:y', () => {
  let plugin: PluginInstance
  let testServer: http.Server

  beforeEach(() =>
    createDefaultApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )
  afterEach(done => testServer.close(() => done()))

  it('returns correct tile from MBTiles file', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/chart-tiles/test/4/5/6'))
      .then(response => {
        // unpacked-tiles contains same tiles as the test.mbtiles file
        expectTileResponse(response, 'charts/unpacked-tiles/4/5/6.png', 'image/png')
      })
  })

  it('returns correct tile from directory', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/chart-tiles/unpacked-tiles/4/4/6'))
      .then(response => {
        expectTileResponse(response, 'charts/unpacked-tiles/4/4/6.png', 'image/png')
      })
  })

  it('returns correct tile from TMS directory', () => {
    // Y-coordinate flipped
    return plugin.start({})
      .then(() => get(testServer, '/signalk/chart-tiles/tms-tiles/5/17/10'))
      .then(response => {
        expectTileResponse(response, 'charts/tms-tiles/5/17/21.png', 'image/png')
      })
  })

  it('returns 404 for missing tile', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/chart-tiles/tms-tiles/5/55/10'))
      .catch(e => e.response)
      .then(response => {
        expect(response.status).to.equal(404)
      })
  })

  it('returns 404 for wrong chart identifier', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/chart-tiles/foo/4/4/6'))
      .catch(e => e.response)
      .then(response => {
        expect(response.status).to.equal(404)
      })
  })
})


const expectTileResponse = (response: ChaiHttp.Response, expectedTilePath: string, expectedFormat: string) => {
  const expectedTile = fs.readFileSync(path.resolve(__dirname, expectedTilePath))
  expect(response.status).to.equal(200)
  expect(response.headers['content-type']).to.equal(expectedFormat)
  expect(response.headers['cache-control']).to.equal('public, max-age=7776000')
  expect(response.body.toString('hex')).to.deep.equal(expectedTile.toString('hex'))
}

interface TestApp extends express.Express {
  debug: (...msg: unknown[]) => void
  error: (msg: string) => void
  config: { configPath: string }
  statusMessage: () => string
  setPluginStatus: (pluginId: string, status: string) => void
  setPluginError: (pluginId: string, status: string) => void
}

const createDefaultApp = (): Promise<{app: TestApp, server: http.Server}> => {
  const app = express() as TestApp
  app.use(bodyParser.json())
  app.config = { configPath: path.resolve(__dirname) }
  app.statusMessage = () => 'started'
  app.error = () => undefined
  app.debug = () => undefined
  app.setPluginStatus = () => undefined
  app.setPluginError = () => undefined

  return new Promise((resolve) => {
    const server = http.createServer(app)
    server.listen(() => {
      const address = server.address()
      if (address && typeof address !== 'string') {
        app.set('port', address.port)
        console.log(`Test server on port ${address.port}`)
      }
      resolve({app, server})
    })
  })
}

const get = (server: http.Server, location: string) => {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Test server has no address')
  }
  const baseUrl = `http://localhost:${address.port}`
  return chai
    .request(baseUrl)
    .get(location)
}
