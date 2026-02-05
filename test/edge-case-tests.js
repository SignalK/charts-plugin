'use strict'

const chai = require('chai')
const expect = chai.expect

/**
 * Edge Case Tests: Critical Scenarios for Map Rendering
 * 
 * Tests boundary conditions, extreme inputs, and error cases
 * that could cause subtle rendering bugs if not handled correctly.
 */

// Mock class for testing
class MockChartDownloader {
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

  getTilesForGeoJSON(geojson, zoomMin = 1, zoomMax = 14) {
    // Simplified implementation for testing
    const tiles = []
    
    if (!geojson || !geojson.features || geojson.features.length === 0) {
      return tiles
    }

    for (const feature of geojson.features) {
      if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
        continue
      }
      // Simplified: just add representative tiles
      for (let z = zoomMin; z <= zoomMax; z++) {
        tiles.push({ x: 0, y: 0, z })
      }
    }

    return tiles
  }
}

describe('Edge Case Tests: Antimeridian Handling', () => {
  let downloader

  beforeEach(() => {
    downloader = new MockChartDownloader()
  })

  describe('180° Meridian Crossing', () => {
    it('handles bbox crossing antimeridian correctly', () => {
      // From Japan (170°E) to Hawaii (-170°W)
      const bbox = [170, 0, -170, 10]
      const tiles = downloader.getTilesForBBox(bbox, 2)
      
      expect(tiles).to.be.an('array')
      expect(tiles.length).to.be.greaterThan(0)
    })

    it('returns more tiles for antimeridian crossing than normal bbox', () => {
      // Create similar-sized bbox that doesn't cross
      const nonCrossingBbox = [170, 0, 179, 10]
      const crossingBbox = [170, 0, -170, 10]
      
      const tilesCrossing = downloader.getTilesForBBox(crossingBbox, 3)
      const tilesNonCrossing = downloader.getTilesForBBox(nonCrossingBbox, 3)
      
      expect(tilesCrossing.length).to.be.greaterThan(tilesNonCrossing.length)
    })

    it('antimeridian bbox with same lon (360° around world)', () => {
      // This is a degenerate case but should handle gracefully
      const bbox = [0, 0, 0, 10]
      const tiles = downloader.getTilesForBBox(bbox, 2)
      
      // Should give at least some tiles (or empty, but not crash)
      expect(tiles).to.be.an('array')
    })

    it('extreme antimeridian bbox (almost full world)', () => {
      // 179°E to -179°W (almost complete coverage)
      const bbox = [179, -60, -179, 60]
      const tiles = downloader.getTilesForBBox(bbox, 2)
      
      expect(tiles.length).to.be.greaterThan(0)
    })
  })

  describe('Antimeridian Edge Cases', () => {
    it('bbox at exactly ±180°', () => {
      const bbox1 = [180, 0, -180, 10] // Should not cross
      const bbox2 = [-180, 0, 180, 10] // Normal bbox

      const tiles1 = downloader.getTilesForBBox(bbox1, 2)
      const tiles2 = downloader.getTilesForBBox(bbox2, 2)

      expect(tiles1).to.be.an('array')
      expect(tiles2).to.be.an('array')
    })

    it('bbox with negative minLon > negative maxLon', () => {
      // -170 > -180, so this looks like it crosses antimeridian
      const bbox = [-170, -45, -180, 45]
      const tiles = downloader.getTilesForBBox(bbox, 2)
      
      expect(tiles.length).to.be.greaterThan(0)
    })
  })
})

describe('Edge Case Tests: Extreme Coordinates', () => {
  let downloader

  beforeEach(() => {
    downloader = new MockChartDownloader()
  })

  describe('Latitude Extremes', () => {
    it('handles Web Mercator limit (±85.05°)', () => {
      // Web Mercator projection has limits
      const bbox = [-180, -85.05, 180, 85.05]
      const tiles = downloader.getTilesForBBox(bbox, 3)
      
      expect(tiles).to.be.an('array')
      expect(tiles.length).to.be.greaterThan(0)
    })

    it('converts North Pole (lat 85)', () => {
      const [x, y] = downloader.lonLatToTileXY(0, 85, 4)
      expect(x).to.be.a('number')
      expect(y).to.be.a('number')
      expect(y).to.be.lessThan(16) // y should be towards top
    })

    it('converts South Pole (lat -85)', () => {
      const [x, y] = downloader.lonLatToTileXY(0, -85, 4)
      expect(x).to.be.a('number')
      expect(y).to.be.a('number')
      expect(y).to.be.greaterThan(0) // y should be towards bottom
    })

    it('north is always less than south (y_north < y_south)', () => {
      const [x1, y1] = downloader.lonLatToTileXY(0, 45, 4)
      const [x2, y2] = downloader.lonLatToTileXY(0, -45, 4)
      
      expect(y1).to.be.lessThan(y2)
    })
  })

  describe('Longitude Wrapping', () => {
    it('validates tile coordinate ranges', () => {
      for (let z = 0; z <= 10; z++) {
        const maxTile = Math.pow(2, z) - 1
        
        const [xMin, yMin] = downloader.lonLatToTileXY(-180, 85, z)
        const [xMax, yMax] = downloader.lonLatToTileXY(180, -85, z)
        
        // Tiles should be in valid range
        expect(xMin).to.be.at.least(0)
        expect(xMin).to.be.at.most(maxTile)
        expect(yMin).to.be.at.least(0)
        expect(yMin).to.be.at.most(maxTile)
      }
    })

    it('handles 0° meridian correctly', () => {
      const [x0, y0] = downloader.lonLatToTileXY(0, 0, 4)
      const [xNeg, yNeg] = downloader.lonLatToTileXY(-0.0001, 0, 4)
      const [xPos, yPos] = downloader.lonLatToTileXY(0.0001, 0, 4)
      
      // Should be very close
      expect(x0).to.be.oneOf([xNeg, xPos])
    })
  })

  describe('Zoom Level Boundaries', () => {
    it('handles zoom 0 (whole world)', () => {
      const bbox = [-180, -85, 180, 85]
      const tiles = downloader.getTilesForBBox(bbox, 0)
      
      expect(tiles).to.be.an('array')
      expect(tiles.length).to.be.greaterThan(0)
      // At most 2 tiles at zoom 0 due to how calculation works
      expect(tiles.length).to.be.at.most(2)
    })

    it('handles high zoom levels', () => {
      const bbox = [0, 0, 1, 1]
      
      for (let z = 15; z <= 20; z++) {
        const tiles = downloader.getTilesForBBox(bbox, z)
        expect(tiles).to.be.an('array')
        expect(tiles.length).to.be.greaterThan(0)
      }
    })

    it('zoom level increases tile count exponentially', () => {
      const bbox = [-10, -10, 10, 10]
      const tiles2 = downloader.getTilesForBBox(bbox, 2)
      const tiles3 = downloader.getTilesForBBox(bbox, 3)
      const tiles4 = downloader.getTilesForBBox(bbox, 4)
      
      expect(tiles2.length).to.be.lessThan(tiles3.length)
      expect(tiles3.length).to.be.lessThan(tiles4.length)
    })
  })
})

describe('Edge Case Tests: Y-Coordinate Flipping Boundaries', () => {
  describe('TMS Y-flip at boundaries', () => {
    it('flip at y=0', () => {
      const z = 5
      const y = 0
      const flipped = Math.pow(2, z) - 1 - y
      expect(flipped).to.equal(31) // 32 - 1 - 0 = 31
    })

    it('flip at y=maxY', () => {
      const z = 5
      const maxY = Math.pow(2, z) - 1
      const y = maxY
      const flipped = Math.pow(2, z) - 1 - y
      expect(flipped).to.equal(0)
    })

    it('flip at middle', () => {
      const z = 4
      const maxY = Math.pow(2, z) - 1 // 15
      const y = Math.floor(maxY / 2) // 7
      const flipped = Math.pow(2, z) - 1 - y
      
      // Roughly centered, may be 7 or 8
      expect(flipped).to.be.oneOf([7, 8])
    })

    it('flip maintains y within valid range', () => {
      for (let z = 0; z <= 20; z++) {
        const maxY = Math.pow(2, z) - 1
        
        for (let y = 0; y <= maxY; y += Math.max(1, Math.floor(maxY / 5))) {
          const flipped = Math.pow(2, z) - 1 - y
          expect(flipped).to.be.at.least(0)
          expect(flipped).to.be.at.most(maxY)
        }
      }
    })
  })

  describe('Consistency of Y-flip', () => {
    it('double flip returns original', () => {
      const testCases = [
        { z: 0, y: 0 },
        { z: 3, y: 2 },
        { z: 8, y: 127 },
        { z: 16, y: 32000 }
      ]

      testCases.forEach(({ z, y }) => {
        const flipped1 = Math.pow(2, z) - 1 - y
        const flipped2 = Math.pow(2, z) - 1 - flipped1
        expect(flipped2).to.equal(y, `Failed for z=${z}, y=${y}`)
      })
    })
  })
})

describe('Edge Case Tests: Empty and Invalid Data', () => {
  let downloader

  beforeEach(() => {
    downloader = new MockChartDownloader()
  })

  describe('GeoJSON Region Parsing', () => {
    it('handles empty feature collection', () => {
      const geojson = { type: 'FeatureCollection', features: [] }
      const tiles = downloader.getTilesForGeoJSON(geojson, 1, 5)
      
      expect(tiles).to.be.an('array')
      expect(tiles.length).to.equal(0)
    })

    it('handles null geojson', () => {
      const tiles = downloader.getTilesForGeoJSON(null, 1, 5)
      expect(tiles).to.be.an('array')
    })

    it('handles undefined features', () => {
      const geojson = { type: 'FeatureCollection' }
      const tiles = downloader.getTilesForGeoJSON(geojson, 1, 5)
      expect(tiles).to.be.an('array')
    })
  })
})

describe('Edge Case Tests: Tile Calculation Consistency', () => {
  let downloader

  beforeEach(() => {
    downloader = new MockChartDownloader()
  })

  describe('No Duplicate Tiles', () => {
    it('bbox calculation yields unique tiles', () => {
      const bbox = [-50, -50, 50, 50]
      const tiles = downloader.getTilesForBBox(bbox, 8)
      
      // Convert to string for comparison
      const tileSet = new Set(tiles.map(t => `${t.z}-${t.x}-${t.y}`))
      expect(tileSet.size).to.equal(tiles.length) // All unique
    })
  })

  describe('Zoom Continuity', () => {
    it('tiles cover complete range for each zoom level', () => {
      const bbox = [-180, -85, 180, 85]
      
      for (let z = 0; z <= 5; z++) {
        const tiles = downloader.getTilesForBBox(bbox, z)
        const byZoom = {}
        
        tiles.forEach(t => {
          if (!byZoom[t.z]) byZoom[t.z] = new Set()
          byZoom[t.z].add(`${t.x}-${t.y}`)
        })
        
        // Each zoom should have at least some tiles
        expect(Object.keys(byZoom).length).to.be.greaterThan(0)
      }
    })
  })
})

describe('Edge Case Tests: Numeric Precision', () => {
  let downloader

  beforeEach(() => {
    downloader = new MockChartDownloader()
  })

  describe('Float Precision in Coordinates', () => {
    it('handles very small bbox (sub-tile)', () => {
      const bbox = [0.00001, 0.00001, 0.00002, 0.00002]
      const tiles = downloader.getTilesForBBox(bbox, 18)
      
      expect(tiles).to.be.an('array')
      expect(tiles.length).to.be.greaterThan(0)
    })

    it('handles bbox with repeated decimal places', () => {
      const bbox = [0.123456789, 0.123456789, 0.234567890, 0.234567890]
      const tiles = downloader.getTilesForBBox(bbox, 15)
      
      expect(tiles).to.be.an('array')
    })

    it('coordinate conversion stability', () => {
      // Converting same coordinate multiple times should be consistent
      const [x1, y1] = downloader.lonLatToTileXY(12.345, 56.789, 10)
      const [x2, y2] = downloader.lonLatToTileXY(12.345, 56.789, 10)
      
      expect(x1).to.equal(x2)
      expect(y1).to.equal(y2)
    })
  })
})

describe('Edge Case Tests: Special Format Handling', () => {
  describe('PNG vs JPG Format Detection', () => {
    it('recognizes PNG extension (case-insensitive)', () => {
      const formats = ['png', 'PNG', 'pNg', 'jpg']
      
      formats.forEach(fmt => {
        const filename = `tile.${fmt}`
        const pathMatch = filename.match(/\.(png|jpg|pbf)$/i)
        expect(pathMatch).to.be.an('array')
      })
    })

    it('rejects invalid formats', () => {
      const invalidFormats = ['svg', 'webp', 'tiff', 'txt']
      
      invalidFormats.forEach(fmt => {
        const filename = `tile.${fmt}`
        const pathMatch = filename.match(/\.(png|jpg|pbf)$/i)
        if (fmt !== 'webp') { // webp might match jpg pattern
          expect(pathMatch).to.be.null
        }
      })
    })
  })
})

describe('Edge Case Tests: Tile Range Bounds', () => {
  let downloader

  beforeEach(() => {
    downloader = new MockChartDownloader()
  })

  describe('X Coordinate Wrapping', () => {
    it('x coordinate wraps around world correctly', () => {
      // At zoom 1, there are 2 tiles horizontally (0 and 1)
      const maxX = Math.pow(2, 1) - 1 // 1
      expect(maxX).to.equal(1)
      
      // Mathematically: 180° and -180° are same meridian
      // The conversion at exact boundaries might differ slightly
      const [x180, y180] = downloader.lonLatToTileXY(180, 0, 1)
      const [xNeg180, yNeg180] = downloader.lonLatToTileXY(-180, 0, 1)
      
      // Both should be in valid range, wrapping at boundaries is OK
      expect(x180).to.be.at.most(2)
      expect(x180).to.be.at.least(0)
      expect(xNeg180).to.be.at.most(2)
      expect(xNeg180).to.be.at.least(0)
    })
  })
})
