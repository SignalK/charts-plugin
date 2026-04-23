import { expect } from 'chai'
import {
  WEB_MERCATOR_HALF_EXTENT_M,
  WEB_MERCATOR_MAX_LAT,
  tileToBBox,
  lonLatToMercator,
  lonLatToTile
} from '../src/projection'

const approx = (actual: number, expected: number, tolerance = 1e-6) => {
  expect(
    Math.abs(actual - expected),
    `${actual} not within ${tolerance} of ${expected}`
  ).to.be.lessThan(tolerance)
}

describe('projection: tileToBBox', () => {
  it('returns the whole world at z=0', () => {
    const [minLon, minLat, maxLon, maxLat] = tileToBBox(0, 0, 0)
    approx(minLon, -180)
    approx(maxLon, 180)
    approx(minLat, -WEB_MERCATOR_MAX_LAT, 1e-9)
    approx(maxLat, WEB_MERCATOR_MAX_LAT, 1e-9)
  })

  it('returns the north-west quadrant at z=1,(0,0)', () => {
    const [minLon, minLat, maxLon, maxLat] = tileToBBox(0, 0, 1)
    approx(minLon, -180)
    approx(maxLon, 0)
    approx(minLat, 0, 1e-9)
    approx(maxLat, WEB_MERCATOR_MAX_LAT, 1e-9)
  })

  it('returns the south-east quadrant at z=1,(1,1)', () => {
    const [minLon, minLat, maxLon, maxLat] = tileToBBox(1, 1, 1)
    approx(minLon, 0)
    approx(maxLon, 180)
    approx(minLat, -WEB_MERCATOR_MAX_LAT, 1e-9)
    approx(maxLat, 0, 1e-9)
  })

  it('produces contiguous non-overlapping tiles at z=2', () => {
    // tile (1,1,2) ends where tile (2,1,2) begins in longitude
    const left = tileToBBox(1, 1, 2)
    const right = tileToBBox(2, 1, 2)
    approx(left[2], right[0])
    // tile (1,1,2) ends where tile (1,2,2) begins in latitude (min->max)
    const below = tileToBBox(1, 2, 2)
    approx(left[1], below[3])
  })

  it('returns bbox as [minLon, minLat, maxLon, maxLat]', () => {
    const bbox = tileToBBox(3, 5, 4)
    expect(bbox[0]).to.be.lessThan(bbox[2])
    expect(bbox[1]).to.be.lessThan(bbox[3])
  })

  // Out-of-range x/y at a given zoom silently produced bbox coordinates
  // outside the real-world range; downstream bbox math (turf) then operated
  // on nonsense, turning a caller bug into a silent wrong-result. Fail fast.
  it('throws for y at or above 2^z', () => {
    // at z=2 the valid y range is [0, 3]; y=4 is outside the grid
    expect(() => tileToBBox(0, 4, 2)).to.throw(RangeError)
  })

  it('throws for y below 0', () => {
    expect(() => tileToBBox(0, -1, 2)).to.throw(RangeError)
  })

  it('throws for x at or above 2^z', () => {
    expect(() => tileToBBox(4, 0, 2)).to.throw(RangeError)
  })

  it('throws for x below 0', () => {
    expect(() => tileToBBox(-1, 0, 2)).to.throw(RangeError)
  })
})

describe('projection: lonLatToMercator', () => {
  it('maps the origin to (0, 0)', () => {
    const [x, y] = lonLatToMercator(0, 0)
    approx(x, 0)
    approx(y, 0)
  })

  it('maps lon=180 to the eastern extent', () => {
    const [x, y] = lonLatToMercator(180, 0)
    approx(x, WEB_MERCATOR_HALF_EXTENT_M)
    approx(y, 0)
  })

  it('maps lon=-180 to the western extent', () => {
    const [x] = lonLatToMercator(-180, 0)
    approx(x, -WEB_MERCATOR_HALF_EXTENT_M)
  })

  it('maps the Web Mercator max latitude to the northern extent', () => {
    const [, y] = lonLatToMercator(0, WEB_MERCATOR_MAX_LAT)
    // math loses precision near the pole; allow 1m tolerance on a ~20M m value
    approx(y, WEB_MERCATOR_HALF_EXTENT_M, 1)
  })

  it('is symmetric about the equator', () => {
    const [, yNorth] = lonLatToMercator(0, 45)
    const [, ySouth] = lonLatToMercator(0, -45)
    approx(yNorth, -ySouth, 1e-6)
  })

  it('is linear in longitude at a fixed latitude', () => {
    const [x1] = lonLatToMercator(45, 10)
    const [x2] = lonLatToMercator(90, 10)
    approx(x2, x1 * 2, 1e-6)
  })
})

describe('projection: lonLatToTile', () => {
  it('maps the world origin to (0,0) at z=0', () => {
    const [x, y] = lonLatToTile(0, 0, 0)
    expect(x).to.equal(0)
    expect(y).to.equal(0)
  })

  it('splits the equator at z=1 into x=0 (west) and x=1 (east)', () => {
    const [west] = lonLatToTile(-90, 0, 1)
    const [east] = lonLatToTile(90, 0, 1)
    expect(west).to.equal(0)
    expect(east).to.equal(1)
  })

  it('returns integer tile coords', () => {
    const [x, y] = lonLatToTile(13.4, 52.5, 8)
    expect(Number.isInteger(x)).to.equal(true)
    expect(Number.isInteger(y)).to.equal(true)
  })

  it('clamps latitudes at or beyond the poles instead of returning NaN', () => {
    // Without clamping, tan(π/2) blows up and the floor of NaN is NaN.
    // A user dragging a selection that touches ±90 shouldn't poison the tile set.
    const [xNorth, yNorth] = lonLatToTile(0, 90, 4)
    expect(Number.isFinite(xNorth)).to.equal(true)
    expect(Number.isFinite(yNorth)).to.equal(true)
    expect(yNorth).to.be.within(0, 2 ** 4 - 1)

    const [xSouth, ySouth] = lonLatToTile(0, -90, 4)
    expect(Number.isFinite(xSouth)).to.equal(true)
    expect(Number.isFinite(ySouth)).to.equal(true)
    expect(ySouth).to.be.within(0, 2 ** 4 - 1)
  })

  it('clamps at WEB_MERCATOR_MAX_LAT (north tile = 0)', () => {
    const [, y] = lonLatToTile(0, WEB_MERCATOR_MAX_LAT, 5)
    expect(y).to.equal(0)
  })
})
