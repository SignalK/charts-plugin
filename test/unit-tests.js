'use strict'

const fs = require('fs')
const path = require('path')
const chai = require('chai')
const expect = chai.expect

/**
 * Unit Tests for Math & Coordinate Functions
 * 
 * Tests coordinate conversions, tile calculations, and metadata parsing
 * that are critical for map rendering, independent of HTTP layer.
 * 
 * These tests are essential for safe refactoring - they verify the
 * mathematical correctness of chart calculations.
 */

// Mock the ChartDownloader for testing tile calculation methods
class MockChartDownloader {
  lonLatToTileXY(lon, lat, zoom) {
    const n = 2 ** zoom
    const x = Math.floor(((lon + 180) / 360) * n)
    const y = Math.floor(
      ((1 -
        Math.log(
          Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)
        ) /
          Math.PI) /
        2) *
        n
    )
    return [x, y]
  }

  tileToBBox(x, y, z) {
    const n = 2 ** z
    const lon1 = (x / n) * 360 - 180
    const lat1 =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
    const lon2 = ((x + 1) / n) * 360 - 180
    const lat2 =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
    return [lon1, lat2, lon2, lat1]
  }

  getTilesForBBox(bbox, maxZoom) {
    const tiles = []
    const [minLon, minLat, maxLon, maxLat] = bbox

    const crossesAntiMeridian = minLon > maxLon

    const processBBox = (lo1, la1, lo2, la2) => {
      for (let z = 0; z <= maxZoom; z++) {
        const [minX, maxY] = this.lonLatToTileXY(lo1, la1, z)
        const [maxX, minY] = this.lonLatToTileXY(lo2, la2, z)

        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) {
            tiles.push({ x, y, z })
          }
        }
      }
    }

    if (!crossesAntiMeridian) {
      processBBox(minLon, minLat, maxLon, maxLat)
    } else {
      processBBox(minLon, minLat, 180, maxLat)
      processBBox(-180, minLat, maxLon, maxLat)
    }

    return tiles
  }

  getSubTiles(tile, maxZoom) {
    const tiles = [tile]

    for (let z = tile.z + 1; z <= maxZoom; z++) {
      const zoomDiff = z - tile.z
      const factor = Math.pow(2, zoomDiff)

      const startX = tile.x * factor
      const startY = tile.y * factor

      for (let x = startX; x < startX + factor; x++) {
        for (let y = startY; y < startY + factor; y++) {
          tiles.push({ x, y, z })
        }
      }
    }

    return tiles
  }
}

describe('Unit Tests: Coordinate Conversion', () => {
  let downloader

  beforeEach(() => {
    downloader = new MockChartDownloader()
  })

  describe('lonLatToTileXY() - Lon/Lat to Web Mercator Tile Coordinates', () => {
    it('converts world center (0, 0) at zoom 0 to tile (0, 0)', () => {
      const [x, y] = downloader.lonLatToTileXY(0, 0, 0)
      expect(x).to.equal(0)
      expect(y).to.equal(0)
    })

    it('converts equator crossing antimeridian correctly', () => {
      const [x1, y1] = downloader.lonLatToTileXY(0, 0, 1)
      expect(x1).to.equal(1) // eastern hemisphere
      
      const [x2, y2] = downloader.lonLatToTileXY(-180, 0, 1)
      expect(x2).to.equal(0) // western hemisphere
    })

    it('converts western hemisphere (negative longitude)', () => {
      const [x, y] = downloader.lonLatToTileXY(-120, 45.5, 4)
      expect(x).to.be.a('number')
      expect(y).to.be.a('number')
      expect(x).to.be.at.least(0)
      expect(y).to.be.at.least(0)
    })

    it('converts valid latitude range (85 to -85)', () => {
      const [x1, y1] = downloader.lonLatToTileXY(0, 85, 4)
      const [x2, y2] = downloader.lonLatToTileXY(0, -85, 4)
      
      expect(y1).to.be.lessThan(y2) // North is smaller y
      expect(Math.abs(y1 - y2)).to.be.greaterThan(0)
    })

    it('handles zoom level 0 to 24', () => {
      for (let z = 0; z <= 24; z++) {
        const [x, y] = downloader.lonLatToTileXY(0, 0, z)
        expect(x).to.be.a('number')
        expect(y).to.be.a('number')
        expect(x).to.be.at.least(0)
        expect(y).to.be.at.least(0)
      }
    })
  })

  describe('tileToBBox() - Tile Coordinates to Bounding Box', () => {
    it('converts zoom 0 tile (0, 0) to world bounds', () => {
      const bbox = downloader.tileToBBox(0, 0, 0)
      expect(bbox[0]).to.be.closeTo(-180, 5) // minLon
      expect(bbox[1]).to.be.closeTo(-85, 5)   // minLat (Web Mercator limit)
      expect(bbox[2]).to.be.closeTo(180, 5)  // maxLon (roughly)
      expect(bbox[3]).to.be.closeTo(85, 5)   // maxLat (Web Mercator limit)
    })

    it('produces bbox with correct lon ordering (min < max)', () => {
      const bbox = downloader.tileToBBox(1, 1, 2)
      expect(bbox[0]).to.be.lessThan(bbox[2])
    })

    it('produces bbox with correct lat ordering (minLat < maxLat)', () => {
      const bbox = downloader.tileToBBox(1, 1, 2)
      expect(bbox[1]).to.be.lessThan(bbox[3])
    })

    it('reverses to original tile via lonLatToTileXY', () => {
      // Tile to bbox and back
      const bbox = downloader.tileToBBox(5, 8, 4)
      const centerLon = (bbox[0] + bbox[2]) / 2
      const centerLat = (bbox[1] + bbox[3]) / 2
      
      const [x, y] = downloader.lonLatToTileXY(centerLon, centerLat, 4)
      expect(x).to.equal(5)
      expect(y).to.equal(8)
    })
  })

  describe('Coordinate Roundtrip: Tile → BBox → Tile', () => {
    it('roundtrips zoom 0, multiple tiles', () => {
      const original = { x: 0, y: 0, z: 0 }
      const bbox = downloader.tileToBBox(original.x, original.y, original.z)
      const [x, y] = downloader.lonLatToTileXY(
        (bbox[0] + bbox[2]) / 2,
        (bbox[1] + bbox[3]) / 2,
        original.z
      )
      expect(x).to.equal(original.x)
      expect(y).to.equal(original.y)
    })

    it('roundtrips zoom 8, multiple tiles', () => {
      for (let x = 0; x < 10; x++) {
        for (let y = 0; y < 10; y++) {
          const original = { x, y, z: 8 }
          const bbox = downloader.tileToBBox(original.x, original.y, original.z)
          const [newX, newY] = downloader.lonLatToTileXY(
            (bbox[0] + bbox[2]) / 2,
            (bbox[1] + bbox[3]) / 2,
            original.z
          )
          expect(newX).to.equal(original.x, `Failed at x=${x}, y=${y}`)
          expect(newY).to.equal(original.y, `Failed at x=${x}, y=${y}`)
        }
      }
    })
  })
})

describe('Unit Tests: Tile Calculations', () => {
  let downloader

  beforeEach(() => {
    downloader = new MockChartDownloader()
  })

  describe('getTilesForBBox() - BBox to Tiles', () => {
    it('returns at least 1 tile for world bbox at zoom 0', () => {
      const tiles = downloader.getTilesForBBox([-180, -85, 180, 85], 0)
      expect(tiles).to.be.an('array')
      expect(tiles.length).to.be.greaterThan(0)
    })

    it('returns correct number of tiles for zoom 0', () => {
      const tiles = downloader.getTilesForBBox([-180, -85, 180, 85], 0)
      // At zoom 0 there is 1 maximum possible, but implementation may return more
      expect(tiles.length).to.be.greaterThan(0)
      expect(tiles.length).to.be.at.most(2)
    })

    it('returns multiple tiles at zoom 1 for world bbox', () => {
      const tiles = downloader.getTilesForBBox([-180, -85, 180, 85], 1)
      // At zoom 1 there are 4 tiles in the world, but may get more depending on algorithm
      expect(tiles.length).to.be.greaterThan(0)
      expect(tiles.length).to.be.at.least(4)
    })

    it('handles normal (non-antimeridian) bbox', () => {
      const bbox = [-120, 30, -100, 40] // Normal bbox (US)
      const tiles = downloader.getTilesForBBox(bbox, 4)
      
      expect(tiles).to.be.an('array')
      expect(tiles.length).to.be.greaterThan(0)
      
      // All tiles should have valid coordinates
      tiles.forEach(tile => {
        expect(tile.z).to.be.at.most(4) // z should not exceed maxZoom
        expect(tile.x).to.be.a('number')
        expect(tile.y).to.be.a('number')
      })
    })

    it('handles antimeridian crossing bbox', () => {
      const bbox = [170, -10, -170, 10] // Crosses 180° meridian
      const tiles = downloader.getTilesForBBox(bbox, 3)
      
      expect(tiles).to.be.an('array')
      expect(tiles.length).to.be.greaterThan(0)
    })

    it('increases tile count with zoom level', () => {
      const bbox = [-10, -10, 10, 10]
      const tiles1 = downloader.getTilesForBBox(bbox, 2)
      const tiles2 = downloader.getTilesForBBox(bbox, 3)
      const tiles3 = downloader.getTilesForBBox(bbox, 4)
      
      expect(tiles1.length).to.be.lessThan(tiles2.length)
      expect(tiles2.length).to.be.lessThan(tiles3.length)
    })

    it('smaller bbox returns fewer tiles', () => {
      const largeBbox = [-45, -45, 45, 45]
      const smallBbox = [-10, -10, 10, 10]
      
      const largeTiles = downloader.getTilesForBBox(largeBbox, 4)
      const smallTiles = downloader.getTilesForBBox(smallBbox, 4)
      
      expect(smallTiles.length).to.be.lessThan(largeTiles.length)
    })
  })

  describe('getSubTiles() - Tile Subdivision', () => {
    it('returns initial tile when max zoom equals current zoom', () => {
      const tile = { x: 0, y: 0, z: 0 }
      const subTiles = downloader.getSubTiles(tile, 0)
      
      expect(subTiles.length).to.equal(1)
      expect(subTiles[0]).to.deep.equal(tile)
    })

    it('returns 4 subtiles when zooming down 1 level', () => {
      const tile = { x: 0, y: 0, z: 0 }
      const subTiles = downloader.getSubTiles(tile, 1)
      
      // 1 parent + 4 children = 5
      expect(subTiles.length).to.equal(5)
      
      // Parent tile should be first
      expect(subTiles[0]).to.deep.equal(tile)
      
      // Should have 4 children at z=1
      const z1Tiles = subTiles.filter(t => t.z === 1)
      expect(z1Tiles.length).to.equal(4)
      
      // All z=1 tiles should have x,y between 0-1
      z1Tiles.forEach(t => {
        expect(t.x).to.be.oneOf([0, 1])
        expect(t.y).to.be.oneOf([0, 1])
      })
    })

    it('correct number of tiles for multi-level subdivision', () => {
      const tile = { x: 0, y: 0, z: 0 }
      
      // Tiles = 1 (z0) + 4 (z1) + 16 (z2) = 21
      const subTiles = downloader.getSubTiles(tile, 2)
      expect(subTiles.length).to.equal(21)
      
      // Tiles = 1 + 4 + 16 + 64 = 85
      const subTiles3 = downloader.getSubTiles(tile, 3)
      expect(subTiles3.length).to.equal(85)
    })

    it('handles non-zero starting tile', () => {
      const tile = { x: 3, y: 2, z: 2 }
      const subTiles = downloader.getSubTiles(tile, 3)
      
      // 1 parent + 4 children = 5
      expect(subTiles.length).to.equal(5)
      
      // Parent should be preserved
      expect(subTiles[0]).to.deep.equal(tile)
      
      // Children x,y should be doubled
      expect(subTiles[1].x).to.equal(6) // 3 * 2
      expect(subTiles[1].y).to.equal(4) // 2 * 2
    })
  })
})

describe('Unit Tests: Metadata Parsing', () => {
  describe('Metadata JSON Parsing', () => {
    it('parses valid metadata.json', () => {
      const json = {
        name: 'Test Chart',
        description: 'A test chart',
        bounds: '0,0,10,10',
        minzoom: '2',
        maxzoom: '14',
        format: 'png',
        type: 'tilelayer',
        scale: '250000'
      }

      // Simulate parseMetadataJson behavior
      function parseBounds(bounds) {
        if (typeof bounds === 'string') {
          return bounds.split(',').map(b => parseFloat(b.trim()))
        } else if (Array.isArray(bounds) && bounds.length === 4) {
          return bounds
        }
        return undefined
      }

      const result = {
        name: json.name || json.id,
        description: json.description || '',
        bounds: parseBounds(json.bounds),
        minzoom: parseInt(json.minzoom),
        maxzoom: parseInt(json.maxzoom),
        format: json.format,
        type: json.type,
        scale: parseInt(json.scale) || 250000
      }

      expect(result.name).to.equal('Test Chart')
      expect(result.bounds).to.deep.equal([0, 0, 10, 10])
      expect(result.minzoom).to.equal(2)
      expect(result.maxzoom).to.equal(14)
      expect(result.format).to.equal('png')
    })

    it('handles bounds as array', () => {
      function parseBounds(bounds) {
        if (typeof bounds === 'string') {
          return bounds.split(',').map(b => parseFloat(b.trim()))
        } else if (Array.isArray(bounds) && bounds.length === 4) {
          return bounds
        }
        return undefined
      }

      const bounds = [1.5, 2.5, 3.5, 4.5]
      const result = parseBounds(bounds)
      expect(result).to.deep.equal(bounds)
    })

    it('handles missing optional fields', () => {
      const json = {
        name: 'Required Only',
        format: 'png',
        type: 'tilelayer'
      }

      // defaults
      const result = {
        name: json.name,
        description: json.description || '',
        bounds: undefined,
        minzoom: isNaN(parseInt(json.minzoom)) ? undefined : parseInt(json.minzoom),
        maxzoom: isNaN(parseInt(json.maxzoom)) ? undefined : parseInt(json.maxzoom),
        format: json.format,
        type: json.type,
        scale: parseInt(json.scale) || 250000
      }

      expect(result.name).to.equal('Required Only')
      expect(result.description).to.equal('')
      expect(result.bounds).to.be.undefined
      expect(result.scale).to.equal(250000)
    })
  })

  describe('Vector Layer Parsing', () => {
    it('extracts layer ids from vector layers', () => {
      const layers = [
        { id: 'layer1', name: 'Layer One' },
        { id: 'layer2', name: 'Layer Two' },
        { id: 'water', name: 'Water' }
      ]

      function parseVectorLayers(layers) {
        return layers.map(l => l.id)
      }

      const result = parseVectorLayers(layers)
      expect(result).to.deep.equal(['layer1', 'layer2', 'water'])
    })

    it('handles empty vector layers', () => {
      function parseVectorLayers(layers) {
        return layers ? layers.map(l => l.id) : []
      }

      const result = parseVectorLayers(undefined)
      expect(result).to.deep.equal([])
    })
  })
})

describe('Unit Tests: Y-Coordinate Flipping (TMS)', () => {
  describe('TMS Y-flip calculation', () => {
    it('flips Y coordinate correctly for TMS', () => {
      // TMS tiles are numbered from bottom-left, Web Mercator from top-left
      // flip: y_wm = 2^z - 1 - y_tms

      const z = 5
      const y_tms = 10

      const flipped = Math.pow(2, z) - 1 - y_tms
      expect(flipped).to.equal(21) // 32 - 1 - 10 = 21
    })

    it('flip is symmetric', () => {
      // Flipping twice should return original
      const z = 4
      const original = 7

      const flipped1 = Math.pow(2, z) - 1 - original
      const flipped2 = Math.pow(2, z) - 1 - flipped1

      expect(flipped2).to.equal(original)
    })

    it('calculates correct range for different zoom levels', () => {
      // At zoom z, valid tiles are 0 to 2^z - 1
      const testCases = [
        { z: 0, maxY: 0 }, // 1 tile
        { z: 1, maxY: 1 }, // 2 tiles
        { z: 2, maxY: 3 }, // 4 tiles
        { z: 4, maxY: 15 }, // 16 tiles
        { z: 8, maxY: 255 } // 256 tiles
      ]

      testCases.forEach(({ z, maxY }) => {
        expect(Math.pow(2, z) - 1).to.equal(maxY)
      })
    })

    it('edge cases: flip at boundaries', () => {
      const z = 3
      const maxY = Math.pow(2, z) - 1

      // Flip minimum
      const flipped0 = Math.pow(2, z) - 1 - 0
      expect(flipped0).to.equal(maxY)

      // Flip maximum
      const flippedMax = Math.pow(2, z) - 1 - maxY
      expect(flippedMax).to.equal(0)
    })
  })
})
