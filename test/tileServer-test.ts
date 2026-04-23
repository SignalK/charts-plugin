/**
 * Unit tests for tileServer.ts. The HTTP-facing helpers
 * (serveTileFromFilesystem / Mbtiles / CacheOrRemote) are exercised end-to-end
 * in plugin-test.ts; here we focus on the pure validators and predicates so
 * regressions surface with a clear assertion rather than via a 500 downstream.
 */

import { expect } from 'chai'
import {
  MAX_ZOOM,
  MIN_TILE_Z,
  MIN_ZOOM,
  isAllowedTileFormat,
  isMbtilesTileMissing,
  validateBBox,
  validateMaxZoom,
  validateTileCoords
} from '../src/tileServer'

describe('tileServer: validateTileCoords', () => {
  it('accepts a valid coordinate', () => {
    expect(validateTileCoords(4, 5, 6)).to.equal(undefined)
  })

  it('accepts z=0 (Leaflet default minZoom)', () => {
    // Rejecting z=0 broke standard map clients; the route-level bound sits
    // below the provider-config bound on purpose.
    expect(validateTileCoords(0, 0, 0)).to.equal(undefined)
  })

  it('rejects zoom below MIN_TILE_Z', () => {
    expect(validateTileCoords(MIN_TILE_Z - 1, 0, 0)).to.be.a('string')
  })

  it('rejects zoom above MAX_ZOOM', () => {
    expect(validateTileCoords(MAX_ZOOM + 1, 0, 0)).to.be.a('string')
  })

  it('rejects non-integer zoom', () => {
    expect(validateTileCoords(3.5, 0, 0)).to.be.a('string')
  })

  it('rejects x at the zoom boundary (x = 2^z)', () => {
    expect(validateTileCoords(4, 16, 0)).to.be.a('string')
  })

  it('rejects y at the zoom boundary (y = 2^z)', () => {
    expect(validateTileCoords(4, 0, 16)).to.be.a('string')
  })

  it('rejects negative x', () => {
    expect(validateTileCoords(4, -1, 0)).to.be.a('string')
  })

  it('rejects negative y', () => {
    expect(validateTileCoords(4, 0, -1)).to.be.a('string')
  })

  it('rejects NaN coordinates', () => {
    expect(validateTileCoords(NaN, 0, 0)).to.be.a('string')
    expect(validateTileCoords(4, NaN, 0)).to.be.a('string')
    expect(validateTileCoords(4, 0, NaN)).to.be.a('string')
  })

  it('accepts corner coordinates inside the grid', () => {
    // at z=4 the valid range is 0..15 inclusive
    expect(validateTileCoords(4, 0, 0)).to.equal(undefined)
    expect(validateTileCoords(4, 15, 15)).to.equal(undefined)
  })
})

describe('tileServer: validateMaxZoom', () => {
  it('accepts a zoom inside the range', () => {
    expect(validateMaxZoom(10)).to.equal(undefined)
  })

  it('accepts the inclusive bounds', () => {
    expect(validateMaxZoom(MIN_ZOOM)).to.equal(undefined)
    expect(validateMaxZoom(MAX_ZOOM)).to.equal(undefined)
  })

  it('rejects NaN', () => {
    expect(validateMaxZoom(NaN)).to.be.a('string')
  })

  it('rejects a value below MIN_ZOOM', () => {
    expect(validateMaxZoom(MIN_ZOOM - 1)).to.be.a('string')
  })

  it('rejects a value above MAX_ZOOM', () => {
    expect(validateMaxZoom(MAX_ZOOM + 1)).to.be.a('string')
  })
})

describe('tileServer: validateBBox', () => {
  const valid = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }

  it('accepts a valid bbox', () => {
    expect(validateBBox(valid)).to.equal(undefined)
  })

  it('accepts a bbox that crosses the antimeridian (minLon > maxLon)', () => {
    // real-world use case: a passage across the 180° line in the Pacific
    expect(
      validateBBox({ minLon: 170, minLat: -10, maxLon: -170, maxLat: 10 })
    ).to.equal(undefined)
  })

  it('rejects a bbox with a non-number coordinate', () => {
    expect(
      validateBBox({ ...valid, minLon: 'nope' as unknown as number })
    ).to.be.a('string')
  })

  it('rejects a bbox with an infinite coordinate', () => {
    expect(validateBBox({ ...valid, maxLat: Infinity })).to.be.a('string')
  })

  it('rejects a bbox with longitude outside [-180, 180]', () => {
    expect(validateBBox({ ...valid, minLon: -181 })).to.be.a('string')
    expect(validateBBox({ ...valid, maxLon: 181 })).to.be.a('string')
  })

  it('rejects a bbox with latitude outside [-90, 90]', () => {
    expect(validateBBox({ ...valid, minLat: -91 })).to.be.a('string')
    expect(validateBBox({ ...valid, maxLat: 91 })).to.be.a('string')
  })

  it('rejects an inverted-latitude bbox (minLat >= maxLat)', () => {
    expect(validateBBox({ ...valid, minLat: 5, maxLat: 5 })).to.be.a('string')
    expect(validateBBox({ ...valid, minLat: 5, maxLat: 4 })).to.be.a('string')
  })
})

describe('tileServer: isAllowedTileFormat', () => {
  it('accepts known raster extensions regardless of case', () => {
    expect(isAllowedTileFormat('png')).to.equal(true)
    expect(isAllowedTileFormat('PNG')).to.equal(true)
    expect(isAllowedTileFormat('jpg')).to.equal(true)
    expect(isAllowedTileFormat('jpeg')).to.equal(true)
  })

  it('accepts the pbf vector extension', () => {
    expect(isAllowedTileFormat('pbf')).to.equal(true)
  })

  it('rejects unknown extensions', () => {
    expect(isAllowedTileFormat('gif')).to.equal(false)
    expect(isAllowedTileFormat('webp')).to.equal(false)
  })

  it('rejects empty and undefined inputs', () => {
    expect(isAllowedTileFormat('')).to.equal(false)
    expect(isAllowedTileFormat(undefined)).to.equal(false)
  })
})

describe('tileServer: isMbtilesTileMissing', () => {
  it('matches the legacy message the library currently throws', () => {
    expect(isMbtilesTileMissing(new Error('Tile does not exist'))).to.equal(
      true
    )
  })

  it('matches an ENOENT-coded error from a hypothetical newer release', () => {
    const err = new Error('ENOENT: tile not found') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    expect(isMbtilesTileMissing(err)).to.equal(true)
  })

  it('does not match unrelated errors', () => {
    expect(isMbtilesTileMissing(new Error('SQLITE_CORRUPT'))).to.equal(false)
  })
})
