/**
 * Unit tests for the declarative token provider. Covers:
 * - token TTL cache: refetch only after expiry
 * - concurrent ensureFreshToken calls coalesce
 * - template substitution: {token.x}, {a-b} range
 * - validateTokenProviderConfig rejects malformed input
 * - chartProviderFromTokenConfig exposes URL/headers as live getters
 * - fetchTileFromRemote awaits ensureFreshToken before reading getters
 */

import { expect } from 'chai'
import {
  TokenProvider,
  chartProviderFromTokenConfig,
  validateTokenProviderConfig
} from '../src/tokenProvider'
import { ChartDownloader } from '../src/chartDownloader'
import type { TokenProviderConfig } from '../src/types'

// Minimal valid config used as the base for tweaks. Each test extends this
// rather than rebuilding from scratch, so the relevant difference stays
// obvious.
const BASE_CONFIG: TokenProviderConfig = {
  identifier: 'test',
  name: 'Test',
  tokenEndpoint: {
    url: 'https://token.example.com/issue',
    method: 'GET',
    ttlSeconds: 600
  },
  tile: {
    url: 'https://tile{1-3}.example.com/{z}/{x}/{y}?t={token.access}',
    headers: { Authorization: 'Bearer {token.access}' }
  }
}

// Stub global fetch with a recording mock that returns programmable bodies.
// Restored in afterEach so tests don't leak.
type FetchCall = { url: string; init: RequestInit | undefined }
const installFetchMock = (responder: (call: FetchCall) => Response) => {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    calls.push({ url, init })
    return responder({ url, init })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    }
  }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

describe('TokenProvider: token TTL cache', () => {
  it('fetches the token on the first request and reuses it inside the TTL', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ access: 'abc', other: 'xyz' })
    )
    try {
      const dp = new TokenProvider({ ...BASE_CONFIG })
      await dp.ensureFreshToken()
      await dp.ensureFreshToken()
      await dp.ensureFreshToken()
      // Three calls, one fetch: TTL hasn't expired between them.
      expect(mock.calls.length).to.equal(1)
      expect(mock.calls[0]!.url).to.equal('https://token.example.com/issue')
    } finally {
      mock.restore()
    }
  })

  it('refetches after the TTL expires', async () => {
    const mock = installFetchMock(() => jsonResponse({ access: 'abc' }))
    try {
      // 1ms TTL so we don't have to mock Date.now.
      const dp = new TokenProvider({
        ...BASE_CONFIG,
        tokenEndpoint: { ...BASE_CONFIG.tokenEndpoint, ttlSeconds: 0.001 }
      })
      await dp.ensureFreshToken()
      // Wait long enough for the 1ms TTL to lapse.
      await new Promise<void>((r) => setTimeout(r, 20))
      await dp.ensureFreshToken()
      expect(mock.calls.length).to.equal(2)
    } finally {
      mock.restore()
    }
  })

  it('coalesces concurrent ensureFreshToken calls into one fetch', async () => {
    let resolveBody: ((body: Response) => void) | null = null
    // Slow first response: ensureFreshToken from multiple callers should
    // share the same in-flight fetch instead of firing N parallel ones.
    const mock = installFetchMock(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify({ access: 'abc' }))
                )
                controller.close()
              }, 25)
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    try {
      const dp = new TokenProvider({ ...BASE_CONFIG })
      await Promise.all([
        dp.ensureFreshToken(),
        dp.ensureFreshToken(),
        dp.ensureFreshToken()
      ])
      expect(mock.calls.length).to.equal(1)
    } finally {
      // Silence unused-var lint: the slow-stream pattern doesn't need the
      // outer resolver after all (setTimeout drives completion).
      void resolveBody
      mock.restore()
    }
  })

  it('invalidateToken forces the next call to refetch', async () => {
    const mock = installFetchMock(() => jsonResponse({ access: 'abc' }))
    try {
      const dp = new TokenProvider({ ...BASE_CONFIG })
      await dp.ensureFreshToken()
      dp.invalidateToken()
      await dp.ensureFreshToken()
      expect(mock.calls.length).to.equal(2)
    } finally {
      mock.restore()
    }
  })

  it('does not throw when the token endpoint returns 5xx', async () => {
    const mock = installFetchMock(() => jsonResponse({ err: 'down' }, 503))
    try {
      const dp = new TokenProvider({ ...BASE_CONFIG })
      // ensureFreshToken swallows errors so the tile fetch path can decide
      // whether to retry. Throwing here would crash unrelated tile reads.
      await dp.ensureFreshToken()
      // resolveUrl with no token leaves {token.x} substituted to empty
      // string, which is the documented behaviour.
      expect(dp.resolveUrl()).to.match(/t=$/)
    } finally {
      mock.restore()
    }
  })
})

describe('TokenProvider: template substitution', () => {
  it('substitutes {token.<field>} from the cached token', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ access: 'AT', config: 'CT' })
    )
    try {
      const dp = new TokenProvider({
        ...BASE_CONFIG,
        tile: {
          url: 'https://h.example.com/?a={token.access}&c={token.config}',
          headers: { 'X-Cfg': '{token.config}' }
        }
      })
      await dp.ensureFreshToken()
      expect(dp.resolveUrl()).to.equal('https://h.example.com/?a=AT&c=CT')
      expect(dp.resolveHeaders()).to.deep.equal({ 'X-Cfg': 'CT' })
    } finally {
      mock.restore()
    }
  })

  it('substitutes a missing token field with empty string', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    try {
      const dp = new TokenProvider({ ...BASE_CONFIG })
      await dp.ensureFreshToken()
      // Empty token: {token.access} resolves to '', range still randomises.
      const url = dp.resolveUrl()
      expect(url).to.match(/^https:\/\/tile[1-3]\.example\.com\/.*\?t=$/)
    } finally {
      mock.restore()
    }
  })

  it('substitutes {a-b} with an integer in the inclusive range', () => {
    const dp = new TokenProvider({
      ...BASE_CONFIG,
      tile: { url: 'https://t{1-5}.example.com/' }
    })
    // Run enough iterations to cover the range; flakiness here would point
    // at off-by-one in the random math, not test ordering.
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const url = dp.resolveUrl()
      const m = url.match(/^https:\/\/t(\d+)\.example\.com\/$/)
      expect(m, `unexpected url ${url}`).to.not.equal(null)
      seen.add(m![1]!)
      const n = parseInt(m![1]!, 10)
      expect(n).to.be.at.least(1)
      expect(n).to.be.at.most(5)
    }
    // Statistically we expect to see all 5 over 200 iterations; if not,
    // either the random bounds are off or this is a 1-in-10^40 fluke.
    expect(seen.size).to.equal(5)
  })

  it('drops non-string fields from the token response', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ access: 'AT', expires_in: 3600, scopes: ['read'] })
    )
    try {
      const dp = new TokenProvider({
        ...BASE_CONFIG,
        tile: {
          url: 'https://h.example.com/?a={token.access}&e={token.expires_in}'
        }
      })
      await dp.ensureFreshToken()
      // expires_in is a number in the JSON; it doesn't appear in the
      // template (which avoids ambiguity around stringification rules).
      expect(dp.resolveUrl()).to.equal('https://h.example.com/?a=AT&e=')
    } finally {
      mock.restore()
    }
  })
})

describe('TokenProvider: validateTokenProviderConfig', () => {
  it('returns the config unchanged when all required fields are present', () => {
    const result = validateTokenProviderConfig(BASE_CONFIG, 0)
    expect(result.identifier).to.equal('test')
  })

  it('rejects missing identifier', () => {
    const bad = { ...BASE_CONFIG, identifier: '' }
    expect(() => validateTokenProviderConfig(bad, 0)).to.throw(/identifier/)
  })

  it('rejects missing tokenEndpoint.url', () => {
    const bad = {
      ...BASE_CONFIG,
      tokenEndpoint: { ...BASE_CONFIG.tokenEndpoint, url: '' }
    }
    expect(() => validateTokenProviderConfig(bad, 0)).to.throw(
      /tokenEndpoint\.url/
    )
  })

  it('rejects non-positive ttlSeconds', () => {
    const bad = {
      ...BASE_CONFIG,
      tokenEndpoint: { ...BASE_CONFIG.tokenEndpoint, ttlSeconds: 0 }
    }
    expect(() => validateTokenProviderConfig(bad, 0)).to.throw(/ttlSeconds/)
  })

  it('rejects missing tile.url', () => {
    const bad = { ...BASE_CONFIG, tile: { url: '' } }
    expect(() => validateTokenProviderConfig(bad, 0)).to.throw(/tile\.url/)
  })

  it('rejects non-object input', () => {
    expect(() => validateTokenProviderConfig(null, 0)).to.throw()
    expect(() => validateTokenProviderConfig('string', 0)).to.throw()
  })
})

describe('chartProviderFromTokenConfig', () => {
  it('exposes proxy=true and a stable identifier', () => {
    const provider = chartProviderFromTokenConfig(BASE_CONFIG)
    expect(provider.proxy).to.equal(true)
    expect(provider.identifier).to.equal('test')
    expect(provider.type).to.equal('tilelayer')
  })

  it('exposes remoteUrl and headers as live getters tied to the cached token', async () => {
    const mock = installFetchMock(() => jsonResponse({ access: 'AT-1' }))
    try {
      const provider = chartProviderFromTokenConfig({
        ...BASE_CONFIG,
        tokenEndpoint: { ...BASE_CONFIG.tokenEndpoint, ttlSeconds: 0.001 }
      })
      await provider._tokenProvider!.ensureFreshToken()
      expect(provider.remoteUrl).to.match(/access=|t=AT-1/)
      expect(provider.headers).to.deep.equal({
        Authorization: 'Bearer AT-1'
      })
    } finally {
      mock.restore()
    }
  })
})

describe('ChartDownloader.fetchTileFromRemote with a token provider', () => {
  it('awaits ensureFreshToken before reading the templated URL', async () => {
    let tokenFetched = false
    let tileFetched = false
    let tileUrl = ''
    const mock = installFetchMock((call) => {
      if (call.url.startsWith('https://token.')) {
        tokenFetched = true
        return jsonResponse({ access: 'XYZ' })
      }
      if (call.url.startsWith('https://tile')) {
        tileFetched = true
        tileUrl = call.url
        return new Response(Buffer.from('PNG-DATA'), { status: 200 })
      }
      return new Response('', { status: 404 })
    })
    try {
      const provider = chartProviderFromTokenConfig({ ...BASE_CONFIG })
      const buf = await ChartDownloader.fetchTileFromRemote(provider, {
        x: 1,
        y: 2,
        z: 3
      })
      expect(tokenFetched, 'token endpoint should have been called').to.equal(
        true
      )
      expect(tileFetched, 'tile endpoint should have been called').to.equal(
        true
      )
      expect(tileUrl).to.match(
        /^https:\/\/tile[1-3]\.example\.com\/3\/1\/2\?t=XYZ$/
      )
      expect(buf).to.be.instanceOf(Buffer)
    } finally {
      mock.restore()
    }
  })
})
