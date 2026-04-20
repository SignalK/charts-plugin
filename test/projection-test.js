'use strict'
const chai = require('chai')
const expect = chai.expect
const {
  WEB_MERCATOR_HALF_EXTENT_M,
  tileToBBox,
  lonLatToMercator
} = require('../plugin/projection')

const WEB_MERCATOR_MAX_LAT = 85.0511287798066

const approx = (actual, expected, tolerance = 1e-6) => {
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
