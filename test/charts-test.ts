/**
 * Unit tests for charts.ts. findCharts is exercised against the real chart
 * fixtures in test/charts; the goal here is to pin its contract (what it
 * discovers, what it rejects) separately from the plugin-level integration
 * scenarios in plugin-test.ts.
 */

import path from 'path'
import { expect } from 'chai'
import { findCharts } from '../src/charts'

const CHARTS_DIR = path.resolve(__dirname, 'charts')

describe('charts: findCharts', () => {
  it('returns an identifier-keyed map of chart providers', async () => {
    const result = await findCharts(CHARTS_DIR)
    expect(result).to.be.an('object')
    expect(Object.keys(result)).to.have.length.greaterThan(0)
    for (const [id, chart] of Object.entries(result)) {
      expect(chart.identifier).to.equal(id)
    }
  })

  it('discovers the MBTiles fixture and tags its file format', async () => {
    const result = await findCharts(CHARTS_DIR)
    const mbtiles = result.test
    expect(mbtiles, 'test.mbtiles fixture').to.exist
    expect(mbtiles!._fileFormat).to.equal('mbtiles')
    expect(mbtiles!.format).to.equal('png')
  })

  it('discovers directory-backed (TMS) charts with _flipY set', async () => {
    const result = await findCharts(CHARTS_DIR)
    const tms = result['tms-tiles']
    expect(tms, 'tms-tiles fixture').to.exist
    expect(tms!._fileFormat).to.equal('directory')
    expect(tms!._flipY).to.equal(true)
  })

  it('discovers directory-backed (metadata.json) charts with _flipY cleared', async () => {
    const result = await findCharts(CHARTS_DIR)
    const unpacked = result['unpacked-tiles']
    expect(unpacked, 'unpacked-tiles fixture').to.exist
    expect(unpacked!._fileFormat).to.equal('directory')
    expect(unpacked!._flipY).to.equal(false)
  })

  it('returns an empty map for a directory with no charts', async () => {
    // The fixture tree contains subfolders of plain PNGs; without tilemap
    // metadata they should not be treated as charts.
    const result = await findCharts(path.join(CHARTS_DIR, 'tms-tiles', '4'))
    expect(result).to.deep.equal({})
  })

  it('returns an empty map for a non-existent directory rather than throwing', async () => {
    // A misconfigured chart path shouldn't take the plugin down; the caller
    // logs and continues with the providers that did load.
    const result = await findCharts(path.join(CHARTS_DIR, 'does-not-exist'))
    expect(result).to.deep.equal({})
  })

  it('does not invoke onScanError for a non-existent directory (ENOENT)', async () => {
    // ENOENT is the "user misconfiguration" path, not a transient failure —
    // the caller should trust the empty result rather than preserve a stale
    // last-good set because of it.
    let errorFired = false
    await findCharts(path.join(CHARTS_DIR, 'does-not-exist'), () => {
      errorFired = true
    })
    expect(errorFired).to.equal(false)
  })

  it('invokes onScanError when readdir fails with a non-ENOENT code', async () => {
    // Pointing findCharts at a file (not a directory) yields ENOTDIR from
    // readdir, which represents the class of transient / unexpected failures
    // the callback is meant to flag. The caller uses this signal to keep
    // the last-good chart set instead of wiping providers.
    let errorFired = false
    const result = await findCharts(
      path.join(CHARTS_DIR, 'test.mbtiles'),
      () => {
        errorFired = true
      }
    )
    expect(errorFired).to.equal(true)
    expect(result).to.deep.equal({})
  })
})
