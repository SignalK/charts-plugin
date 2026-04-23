/**
 * Unit tests for the browser-side submitSeedJob helper in public/index.js.
 * The function is extracted so the fetch + response-validation paths can be
 * exercised in node with a mocked fetch, without spinning up jsdom. The DOM
 * wiring itself is covered by manual QA on the Webapp panel.
 */

import { expect } from 'chai'

type SeedJob = { id: number; [k: string]: unknown }

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { submitSeedJob } = require('../public/index.js') as {
  submitSeedJob: (
    chart: string,
    body: unknown,
    fetchImpl?: typeof fetch
  ) => Promise<SeedJob>
}

// Minimal Response stand-in; the helper only reads `ok`, `status`, `json`
// and `text`, so we don't need to satisfy the full DOM interface.
type FakeResponse = {
  ok: boolean
  status?: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

const mockFetch =
  (
    responder: (url: string, init: RequestInit | undefined) => FakeResponse
  ): typeof fetch =>
  (url, init) =>
    Promise.resolve(
      responder(String(url), init)
    ) as unknown as Promise<Response>

describe('public client: submitSeedJob', () => {
  it('sends a POST with JSON body and URL-encoded chart identifier', async () => {
    // The chart identifier comes from the UI and may contain characters that
    // require escaping (slashes, spaces); the helper should encode them so
    // the server sees a single path segment.
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl = mockFetch((url, init) => {
      capturedUrl = url
      capturedInit = init
      return { ok: true, json: async () => ({ id: 1 }) }
    })
    await submitSeedJob('chart a/b', { maxZoom: '5' }, fetchImpl)
    expect(capturedUrl).to.equal('/signalk/chart-tiles/cache/chart%20a%2Fb')
    expect(capturedInit?.method).to.equal('POST')
    expect(capturedInit?.headers).to.deep.equal({
      'Content-Type': 'application/json'
    })
    expect(capturedInit?.body).to.equal(JSON.stringify({ maxZoom: '5' }))
  })

  it('returns the parsed job info on success', async () => {
    const fetchImpl = mockFetch(() => ({
      ok: true,
      json: async () => ({ id: 42, totalTiles: 100, status: 0 })
    }))
    const job = await submitSeedJob('chart-1', {}, fetchImpl)
    expect(job).to.include({ id: 42, totalTiles: 100 })
  })

  it('throws with the status and body when the server responds non-ok', async () => {
    const fetchImpl = mockFetch(() => ({
      ok: false,
      status: 400,
      text: async () => 'maxZoom out of range'
    }))
    try {
      await submitSeedJob('chart-1', {}, fetchImpl)
      expect.fail('expected submitSeedJob to throw')
    } catch (err) {
      expect((err as Error).message).to.include('400')
      expect((err as Error).message).to.include('maxZoom out of range')
    }
  })

  it('throws even when the error body cannot be read', async () => {
    // Some proxies close the connection before the body is delivered. The
    // helper should still surface the status code rather than masking the
    // failure as a successful response.
    const fetchImpl = mockFetch(() => ({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('stream closed'))
    }))
    try {
      await submitSeedJob('chart-1', {}, fetchImpl)
      expect.fail('expected submitSeedJob to throw')
    } catch (err) {
      expect((err as Error).message).to.include('502')
    }
  })

  it('throws when the response body is missing a numeric id', async () => {
    // Server contract change or misrouted request: refuse silently succeeding
    // with no job to reference afterwards.
    const fetchImpl = mockFetch(() => ({
      ok: true,
      json: async () => ({ status: 'weird' })
    }))
    try {
      await submitSeedJob('chart-1', {}, fetchImpl)
      expect.fail('expected submitSeedJob to throw')
    } catch (err) {
      expect((err as Error).message).to.include('numeric id')
    }
  })

  it('propagates network errors from fetch', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.reject(new Error('ECONNREFUSED'))
    try {
      await submitSeedJob('chart-1', {}, fetchImpl)
      expect.fail('expected submitSeedJob to throw')
    } catch (err) {
      expect((err as Error).message).to.equal('ECONNREFUSED')
    }
  })
})
