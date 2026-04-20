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

// Short debounce so watcher-based tests don't wait 5s per assertion. Must be
// set before requiring the plugin so the module-level RELOAD_DEBOUNCE_MS picks
// it up.
process.env.SK_CHARTS_RELOAD_DEBOUNCE_MS = '150'

import Plugin = require('../src/index')
import expectedCharts from './expected-charts.json'

chai.use(chaiHttp)
const expect = chai.expect

// The Plugin interface from @signalk/server-api types `start` as
// `(config, restart) => void`, but charts-plugin's real implementation
// is async (the tests sequence on the returned promise). Wrap the type
// here so the test file can await / chain `.then` without fighting the
// upstream declaration.
type PluginInstance = {
  start: (settings: object) => Promise<void>
  stop: () => void
}

// TestApp intentionally omits most of ServerAPI since these are
// integration tests that exercise only the HTTP surface, not the
// resource APIs. Cast through `unknown` to sidestep the full interface.
const asPluginApp = (app: TestApp): PluginInstance =>
  Plugin(
    app as unknown as Parameters<typeof Plugin>[0]
  ) as unknown as PluginInstance

// Slightly larger than the debounce, plus slack for the filesystem event to
// propagate and the reload to complete.
const RELOAD_WAIT_MS = 600
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Keep the watcher-test temp dir on the same drive as the repo. @signalk/mbtiles
// mangles Windows paths via url.parse (drive letter becomes the protocol), so
// a cross-drive path like C:\Users\...\Temp from a D:\ checkout fails to open.
const TMP_BASE = path.resolve(__dirname, '.tmp')

describe('GET /resources/charts', () => {
  let plugin: PluginInstance
  let testServer: http.Server

  beforeEach(() =>
    createDefaultApp().then(({ app, server }) => {
      plugin = asPluginApp(app)
      testServer = server
    })
  )
  afterEach((done) => {
    if (plugin && plugin.stop) plugin.stop()
    testServer.close(() => done())
  })

  it('returns all charts for default path', () => {
    return plugin
      .start({})
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then((result) => {
        expect(result.status).to.equal(200)
        const resultCharts = result.body
        expect(_.keys(resultCharts).length).to.deep.equal(3)
        expect(resultCharts).to.deep.equal(expectedCharts)
      })
  })

  it('handle canonical paths', () => {
    return plugin
      .start({
        chartPaths: ['charts', path.resolve(__dirname, 'charts').toString()]
      })
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then((result) => {
        expect(result.status).to.equal(200)
        const resultCharts = result.body
        expect(_.keys(resultCharts).length).to.deep.equal(3)
      })
  })

  it('returns all charts for multiple paths', () => {
    return plugin
      .start({ chartPaths: ['charts', 'charts-2'] })
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then((result) => {
        expect(result.status).to.equal(200)
        const resultCharts = result.body
        expect(_.keys(resultCharts).length).to.deep.equal(4)
        expect(resultCharts['test2']).not.to.equal(undefined)
      })
  })

  it('returns empty charts for custom path', () => {
    return plugin
      .start({ chartPaths: ['../src/'] })
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then((result) => {
        expect(result.status).to.equal(200)
        expect(result.body).to.deep.equal({})
      })
  })

  it('returns online chart providers', () => {
    return plugin
      .start({
        chartPaths: ['charts'],
        onlineChartProviders: [
          {
            name: 'Test Name',
            minzoom: 2,
            maxzoom: 15,
            format: 'jpg',
            url: 'https://example.com'
          }
        ]
      })
      .then(() => get(testServer, '/signalk/v1/api/resources/charts'))
      .then((result) => {
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
          style: null,
          tilemapUrl: 'https://example.com',
          type: 'tilelayer',
          chartLayers: null
        })
      })
  })

  it('returns one chart', () => {
    const identifier = 'test'
    return plugin
      .start({})
      .then(() =>
        get(testServer, `/signalk/v1/api/resources/charts/${identifier}`)
      )
      .then((result) => {
        expect(result.status).to.equal(200)
        expect(result.body).to.deep.equal(
          expectedCharts[identifier as keyof typeof expectedCharts]
        )
      })
  })

  it('returns 404 for unknown chart', () => {
    return plugin
      .start({})
      .then(() => get(testServer, `/signalk/v1/api/resources/charts/foo`))
      .catch((e) => e.response)
      .then((result) => {
        expect(result.status).to.equal(404)
      })
  })
})

describe('GET /signalk/chart-tiles/:identifier/:z/:x/:y', () => {
  let plugin: PluginInstance
  let testServer: http.Server

  beforeEach(() =>
    createDefaultApp().then(({ app, server }) => {
      plugin = asPluginApp(app)
      testServer = server
    })
  )
  afterEach((done) => {
    if (plugin && plugin.stop) plugin.stop()
    testServer.close(() => done())
  })

  it('returns correct tile from MBTiles file', () => {
    return plugin
      .start({})
      .then(() => get(testServer, '/signalk/chart-tiles/test/4/5/6'))
      .then((response) => {
        // unpacked-tiles contains same tiles as the test.mbtiles file
        expectTileResponse(
          response,
          'charts/unpacked-tiles/4/5/6.png',
          'image/png'
        )
      })
  })

  it('returns correct tile from directory', () => {
    return plugin
      .start({})
      .then(() => get(testServer, '/signalk/chart-tiles/unpacked-tiles/4/4/6'))
      .then((response) => {
        expectTileResponse(
          response,
          'charts/unpacked-tiles/4/4/6.png',
          'image/png'
        )
      })
  })

  it('returns correct tile from TMS directory', () => {
    // Y-coordinate flipped
    return plugin
      .start({})
      .then(() => get(testServer, '/signalk/chart-tiles/tms-tiles/5/17/10'))
      .then((response) => {
        expectTileResponse(
          response,
          'charts/tms-tiles/5/17/21.png',
          'image/png'
        )
      })
  })

  it('returns 404 for missing tile', () => {
    return plugin
      .start({})
      .then(() => get(testServer, '/signalk/chart-tiles/tms-tiles/5/55/10'))
      .catch((e) => e.response)
      .then((response) => {
        expect(response.status).to.equal(404)
      })
  })

  it('returns 404 for wrong chart identifier', () => {
    return plugin
      .start({})
      .then(() => get(testServer, '/signalk/chart-tiles/foo/4/4/6'))
      .catch((e) => e.response)
      .then((response) => {
        expect(response.status).to.equal(404)
      })
  })
})

describe('chart folder watcher', function () {
  this.timeout(10000)
  let plugin: PluginInstance
  let testServer: http.Server
  let tmpDir: string
  const fixtureMbtiles = path.resolve(__dirname, 'charts/test.mbtiles')

  beforeEach(() => {
    fs.mkdirSync(TMP_BASE, { recursive: true })
    return createDefaultApp().then(({ app, server }) => {
      plugin = asPluginApp(app)
      testServer = server
      tmpDir = fs.mkdtempSync(path.join(TMP_BASE, 'watch-'))
    })
  })
  afterEach((done) => {
    if (plugin && plugin.stop) plugin.stop()
    testServer.close(() => {
      // Give Windows a moment to release any file handles we just closed.
      setTimeout(() => {
        try {
          fs.rmSync(tmpDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50
          })
        } catch {
          // best-effort cleanup
        }
        done()
      }, 50)
    })
  })

  it('picks up a new chart file added after startup', async () => {
    await plugin.start({ chartPaths: [tmpDir] })
    let response = await get(testServer, '/signalk/v1/api/resources/charts')
    expect(Object.keys(response.body).length).to.equal(0)

    fs.copyFileSync(fixtureMbtiles, path.join(tmpDir, 'added.mbtiles'))
    await wait(RELOAD_WAIT_MS)

    response = await get(testServer, '/signalk/v1/api/resources/charts')
    expect(Object.keys(response.body)).to.include('added')
  })

  it('drops a chart that has been deleted', async () => {
    // Use a directory-based chart (TMS tiles) rather than an .mbtiles file.
    // Deleting an open SQLite file is blocked on Windows; directories aren't,
    // so this exercises the watcher's "removal" path without being tangled up
    // in node:sqlite file-locking behavior.
    const tmsSrc = path.resolve(__dirname, 'charts/tms-tiles')
    const tmsDst = path.join(tmpDir, 'deleteme')
    fs.cpSync(tmsSrc, tmsDst, { recursive: true })

    await plugin.start({ chartPaths: [tmpDir] })
    let response = await get(testServer, '/signalk/v1/api/resources/charts')
    expect(Object.keys(response.body)).to.include('deleteme')

    fs.rmSync(tmsDst, { recursive: true, force: true })
    await wait(RELOAD_WAIT_MS)

    response = await get(testServer, '/signalk/v1/api/resources/charts')
    expect(Object.keys(response.body)).to.not.include('deleteme')
  })

  it('discovers charts in nested subdirectories', async () => {
    const region = path.join(tmpDir, 'region-a')
    fs.mkdirSync(region)
    fs.copyFileSync(fixtureMbtiles, path.join(region, 'nested.mbtiles'))

    await plugin.start({ chartPaths: [tmpDir] })
    const response = await get(testServer, '/signalk/v1/api/resources/charts')
    expect(Object.keys(response.body)).to.include('nested')
  })

  it('picks up a chart added to a nested subdirectory after startup', async () => {
    const region = path.join(tmpDir, 'region-b')
    fs.mkdirSync(region)
    await plugin.start({ chartPaths: [tmpDir] })

    fs.copyFileSync(fixtureMbtiles, path.join(region, 'late.mbtiles'))
    await wait(RELOAD_WAIT_MS)

    const response = await get(testServer, '/signalk/v1/api/resources/charts')
    expect(Object.keys(response.body)).to.include('late')
  })

  it('ignores invalid files without dropping good charts', async () => {
    fs.copyFileSync(fixtureMbtiles, path.join(tmpDir, 'stable.mbtiles'))
    await plugin.start({ chartPaths: [tmpDir] })

    let response = await get(testServer, '/signalk/v1/api/resources/charts')
    expect(Object.keys(response.body)).to.include('stable')

    // An .mbtiles file that isn't a valid SQLite database. openMbtilesFile
    // rejects it, but that shouldn't take out the 'stable' chart already loaded.
    fs.writeFileSync(path.join(tmpDir, 'broken.mbtiles'), 'not a sqlite db')
    await wait(RELOAD_WAIT_MS)

    response = await get(testServer, '/signalk/v1/api/resources/charts')
    expect(Object.keys(response.body)).to.include('stable')
    expect(Object.keys(response.body)).to.not.include('broken')
  })
})

describe('tile cache HTTP endpoints', () => {
  let plugin: PluginInstance
  let testServer: http.Server
  const proxyProvider = {
    name: 'Proxy Test',
    minzoom: 3,
    maxzoom: 5,
    format: 'png',
    url: 'https://example.com/{z}/{x}/{y}.png',
    proxy: true
  }

  beforeEach(() =>
    createDefaultApp().then(({ app, server }) => {
      plugin = asPluginApp(app)
      testServer = server
    })
  )
  afterEach((done) => {
    if (plugin && plugin.stop) plugin.stop()
    testServer.close(() => done())
  })

  it('POST /cache/:identifier returns 404 when the provider is unknown', async () => {
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const res = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/does-not-exist')
      .send({
        maxZoom: '5',
        bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }
      })
      .catch((e) => e.response)
    expect(res.status).to.equal(404)
  })

  it('POST /cache/:identifier returns 400 when maxZoom is missing', async () => {
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const res = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/proxy-test')
      .send({ bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 } })
      .catch((e) => e.response)
    expect(res.status).to.equal(400)
  })

  it('POST /cache/:identifier returns 400 when no region/bbox/tile is given', async () => {
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const res = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/proxy-test')
      .send({ maxZoom: '5' })
      .catch((e) => e.response)
    expect(res.status).to.equal(400)
  })

  it('POST /cache/:identifier returns 202 with the fully-initialised job info', async () => {
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const res = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/proxy-test')
      .send({
        maxZoom: '5',
        bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }
      })
    expect(res.status).to.equal(202)
    expect(res.body).to.include.keys(['id', 'totalTiles', 'status'])
    // Init must have completed before the response: totalTiles is non-zero,
    // which proves the tile set is populated.
    expect(res.body.totalTiles).to.be.greaterThan(0)
    // Job should not be auto-started — seeding is an explicit follow-up.
    expect(res.body.downloadedTiles).to.equal(0)
  })

  it('POST /cache/:identifier with bbox respects the provider minzoom', async () => {
    // provider minzoom=3, maxzoom=5. Before the fix, getTilesForBBox started
    // at z=0 regardless of minzoom, so totalTiles would include the three
    // low-zoom tiles we'd never actually seed. With the fix in place we
    // should only see tiles from the provider's declared zoom range.
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const maxZoom = '5'
    const bbox = { minLon: 5, minLat: 5, maxLon: 6, maxLat: 6 }
    const withMinzoom = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/proxy-test')
      .send({ maxZoom, bbox })
    expect(withMinzoom.status).to.equal(202)
    // With minzoom=3 we cover z=3..5, which for a tiny bbox well within a
    // tile at each zoom is 3 tiles total. If minzoom were ignored we'd see
    // 6 (also z=0,1,2 would each contribute 1 tile).
    expect(withMinzoom.body.totalTiles).to.equal(3)
  })

  it('POST /cache/jobs/:id returns 400 on a non-numeric job id', async () => {
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const res = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/jobs/not-a-number')
      .send({ action: 'start' })
      .catch((e) => e.response)
    expect(res.status).to.equal(400)
  })

  it('POST /cache/jobs/:id returns 404 for an unknown job', async () => {
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const res = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/jobs/99999')
      .send({ action: 'start' })
      .catch((e) => e.response)
    expect(res.status).to.equal(404)
  })

  it('POST /cache/jobs/:id returns 400 for a missing action', async () => {
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const createRes = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/proxy-test')
      .send({
        maxZoom: '4',
        bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }
      })
    expect(createRes.status).to.equal(202)
    const jobId = createRes.body.id

    const res = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post(`/signalk/chart-tiles/cache/jobs/${jobId}`)
      .send({})
      .catch((e) => e.response)
    expect(res.status).to.equal(400)
  })

  it('POST /cache/jobs/:id returns 400 for an unknown action', async () => {
    await plugin.start({ onlineChartProviders: [proxyProvider] })
    const createRes = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post('/signalk/chart-tiles/cache/proxy-test')
      .send({
        maxZoom: '4',
        bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }
      })
    const jobId = createRes.body.id

    const res = await chai
      .request(`http://localhost:${serverPort(testServer)}`)
      .post(`/signalk/chart-tiles/cache/jobs/${jobId}`)
      .send({ action: 'detonate' })
      .catch((e) => e.response)
    expect(res.status).to.equal(400)
  })
})

const expectTileResponse = (
  response: ChaiHttp.Response,
  expectedTilePath: string,
  expectedFormat: string
) => {
  const expectedTile = fs.readFileSync(
    path.resolve(__dirname, expectedTilePath)
  )
  expect(response.status).to.equal(200)
  expect(response.headers['content-type']).to.equal(expectedFormat)
  expect(response.headers['cache-control']).to.equal('public, max-age=7776000')
  expect(response.body.toString('hex')).to.deep.equal(
    expectedTile.toString('hex')
  )
}

interface TestApp extends express.Express {
  debug: (...msg: unknown[]) => void
  error: (msg: string) => void
  config: { configPath: string }
  statusMessage: () => string
  setPluginStatus: (pluginId: string, status: string) => void
  setPluginError: (pluginId: string, status: string) => void
}

const createDefaultApp = (): Promise<{ app: TestApp; server: http.Server }> => {
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
      resolve({ app, server })
    })
  })
}

const get = (server: http.Server, location: string) => {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Test server has no address')
  }
  const baseUrl = `http://localhost:${address.port}`
  return chai.request(baseUrl).get(location)
}

const serverPort = (server: http.Server): number => {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Test server has no address')
  }
  return address.port
}
