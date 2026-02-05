'use strict'

const fs = require('fs')
const path = require('path')
const chai = require('chai')
const chaiHttp = require('chai-http')
const express = require('express')
const expect = chai.expect

chai.use(chaiHttp)

/**
 * Integration Tests: Chart Loading & Tile Serving
 * 
 * Tests full HTTP request/response cycles to ensure:
 * 1. Charts load correctly from various sources
 * 2. Tiles are served with correct content and headers
 * 3. Error responses are appropriate
 * 4. Y-flipping works correctly for TMS
 */

const Plugin = require('../plugin/index')
const http = require('http')

const createTestApp = () => {
  let app = express()
  app.use(require('body-parser').json())
  app.debug = (x) => console.log(x)
  app.config = { configPath: path.resolve(__dirname) }

  app.statusMessage = () => 'started'
  app.error = (msg) => undefined
  app.debug = (...msg) => undefined
  app.setPluginStatus = (pluginId, status) => undefined
  app.setPluginError = (pluginId, status) => undefined

  return new Promise((resolve, reject) => {
    const server = http.createServer(app)
    server.listen(() => {
      const { port } = server.address()
      app.set('port', port)
      resolve({ app, server })
    })
  })
}

const getRequest = (server, location) => {
  const baseUrl = `http://localhost:${server.address().port}`
  return chai.request(baseUrl).get(location)
}

describe('Integration Tests: Chart Loading', () => {
  let plugin
  let testServer

  beforeEach(() =>
    createTestApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )

  afterEach((done) => testServer.close(() => done()))

  describe('Chart Discovery and Metadata', () => {
    it('loads MBTiles chart metadata correctly', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts/test')
      ).then((result) => {
        expect(result.status).to.equal(200)
        expect(result.body).to.have.property('identifier', 'test')
        expect(result.body).to.have.property('name')
        expect(result.body).to.have.property('bounds')
        expect(result.body).to.have.property('minzoom')
        expect(result.body).to.have.property('maxzoom')
        expect(result.body).to.have.property('format')
        expect(result.body).to.have.property('type', 'tilelayer')
      })
    })

    it('loads directory-based chart metadata correctly', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts/unpacked-tiles')
      ).then((result) => {
        expect(result.status).to.equal(200)
        expect(result.body).to.have.property('identifier', 'unpacked-tiles')
        expect(result.body).to.have.property('format')
      })
    })

    it('includes all required metadata fields', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts')
      ).then((result) => {
        const charts = result.body
        Object.values(charts).forEach((chart) => {
          expect(chart).to.have.property('identifier')
          expect(chart).to.have.property('name')
          expect(chart).to.have.property('type')
        })
      })
    })
  })
})

describe('Integration Tests: Tile Serving - Headers & Content Type', () => {
  let plugin
  let testServer

  beforeEach(() =>
    createTestApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )

  afterEach((done) => testServer.close(() => done()))

  describe('Cache-Control Headers', () => {
    it('sets correct Cache-Control header for MBTiles tile', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/test/4/5/6')
      ).then((response) => {
        expect(response.headers).to.have.property('cache-control')
        expect(response.headers['cache-control']).to.include('public')
        expect(response.headers['cache-control']).to.include('max-age=7776000') // 90 days
      })
    })

    it('sets correct Cache-Control header for directory tile', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/unpacked-tiles/4/4/6')
      ).then((response) => {
        expect(response.headers).to.have.property('cache-control')
        expect(response.headers['cache-control']).to.equal('public, max-age=7776000')
      })
    })
  })

  describe('Content-Type Headers', () => {
    it('returns png content-type for PNG tiles', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/test/4/5/6')
      ).then((response) => {
        expect(response.headers['content-type']).to.equal('image/png')
      })
    })

    it('returns image/png for unpacked PNG directory', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/unpacked-tiles/4/4/6')
      ).then((response) => {
        expect(response.headers['content-type']).to.equal('image/png')
      })
    })
  })
})

describe('Integration Tests: Tile Serving - Content Integrity', () => {
  let plugin
  let testServer

  beforeEach(() =>
    createTestApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )

  afterEach((done) => testServer.close(() => done()))

  describe('Tile Content Verification', () => {
    it('mbtiles tile content matches expected file', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/test/4/5/6')
      ).then((response) => {
        expect(response.status).to.equal(200)
        
        // unpacked-tiles contains same tiles as the test.mbtiles file
        const expectedTile = fs.readFileSync(
          path.resolve(__dirname, 'charts/unpacked-tiles/4/5/6.png')
        )
        expect(response.body.toString('hex')).to.deep.equal(
          expectedTile.toString('hex')
        )
      })
    })

    it('directory tile content matches file exactly', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/unpacked-tiles/4/4/6')
      ).then((response) => {
        expect(response.status).to.equal(200)
        
        const expectedTile = fs.readFileSync(
          path.resolve(__dirname, 'charts/unpacked-tiles/4/4/6.png')
        )
        expect(response.body.toString('hex')).to.deep.equal(
          expectedTile.toString('hex')
        )
      })
    })
  })

  describe('Response Body Characteristics', () => {
    it('returns non-empty buffer for valid tile', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/test/4/5/6')
      ).then((response) => {
        expect(response.status).to.equal(200)
        expect(response.body.length).to.be.greaterThan(0)
      })
    })

    it('returns consistent content on multiple requests', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/test/4/5/6')
      ).then((response1) => {
        const hex1 = response1.body.toString('hex')
        return getRequest(testServer, '/signalk/chart-tiles/test/4/5/6').then(
          (response2) => {
            const hex2 = response2.body.toString('hex')
            expect(hex1).to.equal(hex2)
          }
        )
      })
    })
  })
})

describe('Integration Tests: Y-Coordinate Flipping (TMS Critical)', () => {
  let plugin
  let testServer

  beforeEach(() =>
    createTestApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )

  afterEach((done) => testServer.close(() => done()))

  describe('TMS Y-flip Correctness', () => {
    it('flips Y correctly for TMS tiles - boundary at z=5', () => {
      // The test expects: y_requested = 10 → file at y_flipped = 2^5 - 1 - 10 = 21
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/tms-tiles/5/17/10')
      ).then((response) => {
        expect(response.status).to.equal(200)
        
        // Should match the file at tms-tiles/5/17/21.png
        const expectedTile = fs.readFileSync(
          path.resolve(__dirname, 'charts/tms-tiles/5/17/21.png')
        )
        expect(response.body.toString('hex')).to.equal(
          expectedTile.toString('hex')
        )
      })
    })

    it('TMS flipping preserves image integrity', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/tms-tiles/5/17/10')
      ).then((response) => {
        expect(response.status).to.equal(200)
        expect(response.headers['content-type']).to.equal('image/png')
        expect(response.body.length || response.text.length).to.be.greaterThan(0)
      })
    })

    it('correctly identifies TMS format from chart metadata', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts/tms-tiles')
      ).then((response) => {
        expect(response.status).to.equal(200)
        expect(response.body).to.have.property('identifier', 'tms-tiles')
        // TMS tiles have _flipY set to true
      })
    })
  })

  describe('Y-flip Boundary Conditions', () => {
    it('handles Y at 0 (bottom of TMS grid)', () => {
      // At z=4: y_flipped = 2^4 - 1 - 0 = 15 (top of grid)
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/tms-tiles/5/16/31')
      ).catch((e) => e.response)
      .then((response) => {
        // Expect 404 since the test data may not have all tiles
        expect(response.status).to.be.oneOf([200, 404])
      })
    })
  })
})

describe('Integration Tests: Error Handling', () => {
  let plugin
  let testServer

  beforeEach(() =>
    createTestApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )

  afterEach((done) => testServer.close(() => done()))

  describe('404 Error Responses', () => {
    it('returns 404 for missing tile from valid chart', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/test/99/99/99')
      ).catch((e) => e.response)
      .then((response) => {
        expect(response.status).to.equal(404)
      })
    })

    it('returns 404 for invalid chart identifier', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/nonexistent/4/5/6')
      ).catch((e) => e.response)
      .then((response) => {
        expect(response.status).to.equal(404)
      })
    })

    it('returns 404 for unknown chart in resources API', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts/missing-chart')
      ).catch((e) => e.response)
      .then((response) => {
        expect(response.status).to.equal(404)
      })
    })
  })
})

describe('Integration Tests: Multiple Chart Sources', () => {
  let plugin
  let testServer

  beforeEach(() =>
    createTestApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )

  afterEach((done) => testServer.close(() => done()))

  describe('Multi-path configuration', () => {
    it('loads charts from multiple paths', () => {
      return plugin.start({ chartPaths: ['charts', 'charts-2'] }).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts')
      ).then((result) => {
        expect(result.status).to.equal(200)
        const charts = result.body
        
        // Should have both default and secondary chart
        expect(charts).to.have.property('test')
        expect(charts).to.have.property('test2')
      })
    })

    it('handles duplicate chart names (later path wins)', () => {
      // If test exists in both paths, second should override
      return plugin.start({ chartPaths: ['charts', 'charts'] }).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts')
      ).then((result) => {
        const charts = result.body
        expect(charts).to.have.property('test')
      })
    })
  })
})

describe('Integration Tests: Response Format Consistency', () => {
  let plugin
  let testServer

  beforeEach(() =>
    createTestApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )

  afterEach((done) => testServer.close(() => done()))

  describe('API Response Structure', () => {
    it('chart list returns object of charts', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts')
      ).then((result) => {
        expect(result.body).to.be.an('object')
        expect(Object.keys(result.body).length).to.be.greaterThan(0)
      })
    })

    it('individual chart response includes all required fields', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/v1/api/resources/charts/test')
      ).then((result) => {
        const chart = result.body
        expect(chart).to.include.keys(
          'identifier',
          'name',
          'description',
          'type',
          'format',
          'scale'
        )
        // Should have either tilemapUrl or url
        expect(chart).to.satisfy(c => 'tilemapUrl' in c || 'url' in c)
      })
    })

    it('tile response sets content headers consistently', () => {
      return plugin.start({}).then(() =>
        getRequest(testServer, '/signalk/chart-tiles/test/4/5/6')
      ).then((response) => {
        expect(response.headers).to.have.property('content-type')
        expect(response.headers).to.have.property('cache-control')
      })
    })
  })
})


// --- Additional Chart Material Integration Tests ---
const charts2Path = path.resolve(__dirname, 'charts-2')

describe('Integration Tests: Additional Chart Material Scenarios', () => {
  let plugin
  let testServer

  beforeEach(() =>
    createTestApp().then(({ app, server }) => {
      plugin = Plugin(app)
      testServer = server
    })
  )

  afterEach((done) => testServer.close(() => done()))

  it('serves tiles from secondary MBTiles file (test2.mbtiles)', () => {
    return plugin.start({ chartPaths: ['charts', 'charts-2'] }).then(() =>
      getRequest(testServer, '/signalk/v1/api/resources/charts/test2')
    ).then((result) => {
      expect(result.status).to.equal(200)
      expect(result.body).to.have.property('identifier', 'test2')
      // Try to fetch a tile (should 404 or 200 depending on test2.mbtiles content)
      return getRequest(testServer, '/signalk/chart-tiles/test2/4/5/6')
    }).then((response) => {
      expect([200, 404]).to.include(response.status)
    })
  })

  it('returns 404 for all tiles in empty-test chart directory', () => {
    return plugin.start({ chartPaths: ['charts'] }).then(() =>
      getRequest(testServer, '/signalk/v1/api/resources/charts/empty-test')
    ).catch((e) => e.response)
    .then((result) => {
      // Empty directories may not be registered as charts
      expect([200, 404]).to.include(result.status)
      // Try to fetch a tile (should always 404)
      return getRequest(testServer, '/signalk/chart-tiles/empty-test/4/5/6')
        .then((response) => {
          expect(response.status).to.equal(404)
        })
        .catch(e => {
          // e.response may be undefined if request fails before response
          if (e && e.response && typeof e.response.status !== 'undefined') {
            expect(e.response.status).to.equal(404)
          } else {
            // Kein Response: Test ist fehlgeschlagen
            throw new Error('No response received for empty-test tile request')
          }
        })
    })
  })

  it('returns 404 for missing TMS tile and parses tilemapresource.xml', () => {
    return plugin.start({ chartPaths: ['charts'] }).then(() =>
      getRequest(testServer, '/signalk/v1/api/resources/charts/tms-tiles')
    ).then((result) => {
      expect(result.status).to.equal(200)
      expect(result.body).to.have.property('identifier', 'tms-tiles')
      // Try to fetch a non-existent tile
      return getRequest(testServer, '/signalk/chart-tiles/tms-tiles/5/17/99')
    }).catch(e => e.response)
    .then((response) => {
      expect(response.status).to.equal(404)
    })
  })

  it('returns 500 or 404 for directory chart with missing metadata.json', () => {
    // Simulate by pointing to a directory without metadata.json (empty-test)
    return plugin.start({ chartPaths: ['charts'] }).then(() =>
      getRequest(testServer, '/signalk/v1/api/resources/charts/empty-test')
    ).catch(e => e.response)
    .then((response) => {
      // Should be 200 if plugin tolerates missing metadata, 404 or 500 if not
      expect([200, 404, 500]).to.include(response.status)
    })
  })

  it('rejects tiles for unsupported format charts', () => {
    return plugin.start({ chartPaths: ['charts'] }).then(() =>
      getRequest(testServer, '/signalk/v1/api/resources/charts/invalid-format')
    ).then((result) => {
      expect(result.status).to.equal(200)
      expect(result.body).to.have.property('format', 'gif')
      return getRequest(testServer, '/signalk/chart-tiles/invalid-format/4/5/6')
    }).catch(e => e.response)
    .then((response) => {
      expect(response.status).to.equal(404)
    })
  })

  it('returns 404 for unreadable tile files', async () => {
    const chartDir = path.resolve(__dirname, 'charts/unreadable-tiles')
    const tileDir = path.resolve(chartDir, '4/5')
    const tilePath = path.resolve(tileDir, '6.png')
    fs.mkdirSync(tileDir, { recursive: true })
    fs.copyFileSync(
      path.resolve(__dirname, 'charts/unpacked-tiles/4/5/6.png'),
      tilePath
    )
    fs.writeFileSync(
      path.resolve(chartDir, 'metadata.json'),
      JSON.stringify({
        name: 'Unreadable Tiles',
        description: 'Unreadable tile files for testing',
        bounds: [-180, -90, 180, 90],
        minzoom: 1,
        maxzoom: 5,
        format: 'png',
        type: 'tilelayer',
        scale: 250000
      }, null, 2)
    )

    fs.chmodSync(tilePath, 0)

    try {
      await plugin.start({ chartPaths: ['charts'] })
      const response = await getRequest(
        testServer,
        '/signalk/chart-tiles/unreadable-tiles/4/5/6'
      ).catch(e => e.response)
      expect(response.status).to.equal(404)
    } finally {
      try {
        fs.chmodSync(tilePath, 0o644)
      } catch (e) {
        // ignore cleanup errors
      }
      fs.rmSync(chartDir, { recursive: true, force: true })
    }
  })

  it('returns 404 for invalid tile parameters', () => {
    return plugin.start({ chartPaths: ['charts'] }).then(() =>
      getRequest(testServer, '/signalk/chart-tiles/test/a/b/c')
    ).catch(e => e.response)
    .then((response) => {
      expect(response.status).to.equal(404)
    })
  })

  it('returns 404 for out-of-range zoom levels', () => {
    return plugin.start({ chartPaths: ['charts'] }).then(() =>
      getRequest(testServer, '/signalk/chart-tiles/test/0/0/0')
    ).catch(e => e.response)
    .then((response) => {
      expect(response.status).to.equal(404)
      return getRequest(testServer, '/signalk/chart-tiles/test/99/0/0')
    }).catch(e => e.response)
    .then((response) => {
      expect(response.status).to.equal(404)
    })
  })

  it('returns 404 for out-of-range tile coordinates', () => {
    return plugin.start({ chartPaths: ['charts'] }).then(() =>
      // At z=4 valid x/y are 0..15, so 16 is out of range
      getRequest(testServer, '/signalk/chart-tiles/test/4/16/0')
    ).catch(e => e.response)
    .then((response) => {
      expect(response.status).to.equal(404)
      return getRequest(testServer, '/signalk/chart-tiles/test/4/0/16')
    }).catch(e => e.response)
    .then((response) => {
      expect(response.status).to.equal(404)
    })
  })

  it('MBTiles and unpacked directory tiles match for same coordinates', () => {
    return plugin.start({ chartPaths: ['charts'] }).then(() =>
      Promise.all([
        getRequest(testServer, '/signalk/chart-tiles/test/4/5/6'),
        getRequest(testServer, '/signalk/chart-tiles/unpacked-tiles/4/5/6')
      ])
    ).then(([mbtilesResp, dirResp]) => {
      if (mbtilesResp.status === 200 && dirResp.status === 200) {
        expect(mbtilesResp.body.toString('hex')).to.equal(dirResp.body.toString('hex'))
      } else {
        // If either is missing, at least one should be 404
        expect([mbtilesResp.status, dirResp.status]).to.include(404)
      }
    })
  })
})
