'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const chai = require('chai')
const chaiHttp = require('chai-http')
const Promise = require('bluebird')
const express = require('express')
const expect = chai.expect
const Plugin = require('../src/plugin')
const expectedCharts = require('./expected-charts.json')

chai.use(chaiHttp)

describe('GET /resources/charts', () => {
  let plugin
  let testServer
  beforeEach(() =>
    createDefaultApp()
      .then(({app, server}) => {
      plugin = Plugin(app)
      testServer = server
    })
  )
  afterEach(done => testServer.close(() => done()))

  it('returns all charts', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then(result => {
        expect(result.status).to.equal(200)
        const resultCharts = result.body
        expect(resultCharts.length).to.equal(3)
        expectedCharts.map(expectedChart => {
          const match = resultCharts.find(c => c.identifier === expectedChart.identifier)
          expect(match).to.deep.equal(expectedChart)
        })
      })
  })

  it('returns empty charts for custom path', () => {
    return plugin.start({chartsPath: '../src/'})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then(result => {
        expect(result.status).to.equal(200)
        expect(result.body.length).to.equal(0)
      })
  })

  it('returns one chart', () => {
    const expectedChart = expectedCharts[0]
    return plugin.start({})
      .then(() => get(testServer, `/signalk/v1/api/resources/charts/${expectedChart.identifier}`))
      .then(result => {
        expect(result.status).to.equal(200)
        expect(result.body).to.deep.equal(expectedChart)
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

describe.only('GET /resources/charts/:identifier/:z/:x/:y', () => {
  let plugin
  let testServer
  beforeEach(() =>
    createDefaultApp()
      .then(({app, server}) => {
      plugin = Plugin(app)
      testServer = server
    })
  )
  afterEach(done => testServer.close(() => done()))

  it('returns correct tile from MBTiles file', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts/test/4/5/6'))
      .then(response => {
        // unpacked-tiles contains same tiles as the test.mbtiles file
        expectTileResponse(response, 'charts/unpacked-tiles/4/5/6.png', 'image/png')
      })
  })

  it('returns correct tile from directory', () => {
    const expectedTile = fs.readFileSync(path.resolve(__dirname, 'charts/unpacked-tiles/4/4/6.png'))
    return plugin.start({})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts/unpacked-tiles/4/4/6'))
      .then(response => {
        expectTileResponse(response, 'charts/unpacked-tiles/4/4/6.png', 'image/png')
      })
  })

  it('returns correct tile from TMS directory', () => {
    const expectedTile = fs.readFileSync(path.resolve(__dirname, 'charts/tms-tiles/5/17/21.png'))
    // Y-coordinate flipped
    return plugin.start({})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts/tms-tiles/5/17/10'))
      .then(response => {
        expectTileResponse(response, 'charts/tms-tiles/5/17/21.png', 'image/png')
      })
  })

  it('returns 404 for missing tile', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts/tms-tiles/5/55/10'))
      .catch(e => e.response)
      .then(response => {
        expect(response.status).to.equal(404)
      })
  })

  it('returns 404 for wrong chart identifier', () => {
    return plugin.start({})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts/foo/4/4/6'))
      .catch(e => e.response)
      .then(response => {
        expect(response.status).to.equal(404)
      })
  })
})

const expectTileResponse = (response, expectedTilePath, expectedFormat) => {
  const expectedTile = fs.readFileSync(path.resolve(__dirname, expectedTilePath))
  expect(response.status).to.equal(200)
  expect(response.headers['content-type']).to.equal(expectedFormat)
  expect(response.headers['cache-control']).to.equal('public, max-age=7776000')
  expect(response.body.toString('hex')).to.deep.equal(expectedTile.toString('hex'))
}

const createDefaultApp = () => {
  let app = express()
  app.use(require('body-parser').json())
  app.config = { configPath: path.resolve(__dirname) }
  return new Promise((resolve, reject) => {
    const server = http.createServer(app)
    server.listen(() => {
      const {port} = server.address()
      app.set('port', port)
      console.log(`Test server on port ${port}`)
      resolve({app, server})
    })
  })
}

const get = (server, location) => {
  const baseUrl = `http://localhost:${server.address().port}`
  return chai
    .request(baseUrl)
    .get(location)
}
