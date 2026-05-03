/**
 * Declarative token-based chart providers.
 *
 * Replaces the auto-imported `.js` chart-provider modules from the early
 * iterations of PR #49. Those modules executed arbitrary Node code at
 * startup with full server privileges; a malicious or buggy module dropped
 * into the chart directory would have full filesystem and network access.
 *
 * The vast majority of providers that need runtime-computed URLs
 * (Navionics, ArcGIS-style key rotation, OAuth client_credentials) only
 * need: fetch a token from a known URL, cache it for some TTL, template
 * it into the tile URL and request headers. That shape is expressible as
 * JSON config — no code execution required, no review burden on the
 * plugin maintainers, and no TOS exposure for SignalK if the user is
 * talking to a provider whose terms forbid third-party clients.
 *
 * Providers that need request signing or HMAC are not covered here and
 * stay out of scope; if those become a real demand later, the right
 * answer is a sandboxed extension point (worker_threads with a fixed
 * message API), not unrestricted .js loading.
 */

import { ChartProvider, TokenProviderConfig } from './types'

// Random-range placeholder used for sharded tile hostnames like
// `tile{1-5}.host.com`. Inclusive on both ends.
const RANGE_PLACEHOLDER = /\{(\d+)-(\d+)\}/g
const TOKEN_PLACEHOLDER = /\{token\.([a-zA-Z0-9_]+)\}/g

export class TokenProvider {
  // Resolved token fields (string-valued only; non-strings from the JSON
  // response are dropped during fetchToken to keep template substitution
  // unambiguous).
  private token: { [key: string]: string } = {}
  // Epoch-millis at which the cached token is considered stale. Zero forces
  // a fetch on the first ensureFreshToken() call.
  private tokenExpiry = 0
  // Coalesces concurrent refresh attempts: the first caller wins, the rest
  // await the same in-flight promise instead of triggering parallel fetches
  // (which would all race to write `this.token`).
  private inFlight: Promise<void> | null = null

  constructor(private config: TokenProviderConfig) {}

  /**
   * Refresh the cached token if it has expired. Safe to call on the hot
   * path: a fresh-enough token short-circuits without I/O. Concurrent
   * callers share the same in-flight fetch.
   *
   * Errors are swallowed to a console warning rather than thrown: a token
   * fetch failure shouldn't take down a tile request that might still
   * succeed against a stale token (worst case the upstream returns 401
   * and the next request will re-attempt the refresh).
   */
  async ensureFreshToken(): Promise<void> {
    if (Date.now() < this.tokenExpiry) return
    if (this.inFlight) return this.inFlight
    this.inFlight = this.fetchToken()
      .catch((err: Error) => {
        console.warn(
          `Token provider ${this.config.identifier}: token fetch failed: ${err.message}`
        )
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  private async fetchToken(): Promise<void> {
    const ep = this.config.tokenEndpoint
    const res = await fetch(ep.url, {
      method: ep.method ?? 'GET',
      headers: ep.headers,
      body: ep.body
    })
    if (!res.ok) {
      throw new Error(`token endpoint ${ep.url} returned ${res.status}`)
    }
    const data = (await res.json()) as unknown
    if (typeof data !== 'object' || data === null) {
      throw new Error(`token endpoint ${ep.url} returned non-object`)
    }
    const next: { [key: string]: string } = {}
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') next[k] = v
    }
    this.token = next
    this.tokenExpiry = Date.now() + ep.ttlSeconds * 1000
  }

  /**
   * Force-invalidate the cached token. Used by the proxy fetch path when
   * the upstream returns 401: next request will re-fetch the token rather
   * than hammering with the stale one.
   */
  invalidateToken(): void {
    this.tokenExpiry = 0
  }

  /** Templated tile URL with the current token and any range placeholders. */
  resolveUrl(): string {
    return this.applyTemplates(this.config.tile.url)
  }

  /** Templated tile request headers with the current token. */
  resolveHeaders(): { [key: string]: string } {
    const out: { [key: string]: string } = {}
    for (const [k, v] of Object.entries(this.config.tile.headers ?? {})) {
      out[k] = this.applyTemplates(v)
    }
    return out
  }

  // Substitute {token.<field>} from the cached token, then {<a>-<b>} with a
  // random integer in [a, b]. Token comes first so a sharded hostname
  // referenced inside a token field still randomises correctly.
  private applyTemplates(s: string): string {
    return s
      .replace(TOKEN_PLACEHOLDER, (_, key: string) => this.token[key] ?? '')
      .replace(RANGE_PLACEHOLDER, (_, lo: string, hi: string) => {
        const a = parseInt(lo, 10)
        const b = parseInt(hi, 10)
        const span = b - a + 1
        return String(a + Math.floor(Math.random() * span))
      })
  }
}

/**
 * Build a ChartProvider view of a token-provider config. The returned
 * object has property getters for `remoteUrl` and `headers` so the
 * existing tile-serving code keeps reading provider.remoteUrl /
 * provider.headers without knowing about token rotation. The proxy path
 * is responsible for awaiting `_tokenProvider.ensureFreshToken()`
 * before the fetch.
 */
export function chartProviderFromTokenConfig(
  cfg: TokenProviderConfig
): ChartProvider {
  const tp = new TokenProvider(cfg)
  const provider: ChartProvider = {
    identifier: cfg.identifier,
    name: cfg.name,
    description: cfg.description ?? '',
    type: cfg.type ?? 'tilelayer',
    scale: cfg.scale ?? 250000,
    proxy: true,
    _filePath: '',
    _tokenProvider: tp
  }
  if (cfg.format !== undefined) provider.format = cfg.format
  if (cfg.minzoom !== undefined) provider.minzoom = cfg.minzoom
  if (cfg.maxzoom !== undefined) provider.maxzoom = cfg.maxzoom
  if (cfg.bounds !== undefined) provider.bounds = cfg.bounds

  // Defining as accessors rather than data properties so every read pulls
  // a freshly-templated string from the current token. The plain
  // ChartProvider interface declares these as `string` / `object`; the
  // getter shape is compatible at the call site.
  Object.defineProperty(provider, 'remoteUrl', {
    enumerable: true,
    configurable: false,
    get: () => tp.resolveUrl()
  })
  Object.defineProperty(provider, 'headers', {
    enumerable: true,
    configurable: false,
    get: () => tp.resolveHeaders()
  })

  provider.v1 = {
    tilemapUrl: `~tilePath~/${cfg.identifier}/{z}/{x}/{y}`,
    chartLayers: []
  }
  provider.v2 = {
    url: `~tilePath~/${cfg.identifier}/{z}/{x}/{y}`,
    layers: []
  }
  return provider
}

/**
 * Lightweight validation of a parsed token-provider config. Returns the
 * config on success and throws with a human-readable message on the first
 * problem found. Validates the fields the implementation actually relies
 * on; admins can still pass extra fields without error.
 */
export function validateTokenProviderConfig(
  raw: unknown,
  index: number
): TokenProviderConfig {
  const where = `token provider #${index}`
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${where}: expected an object`)
  }
  const c = raw as Record<string, unknown>
  if (typeof c['identifier'] !== 'string' || c['identifier'].length === 0) {
    throw new Error(`${where}: identifier is required (non-empty string)`)
  }
  if (typeof c['name'] !== 'string' || c['name'].length === 0) {
    throw new Error(`${where}: name is required (non-empty string)`)
  }
  const ep = c['tokenEndpoint']
  if (typeof ep !== 'object' || ep === null) {
    throw new Error(`${where}: tokenEndpoint is required (object)`)
  }
  const epRec = ep as Record<string, unknown>
  if (typeof epRec['url'] !== 'string' || epRec['url'].length === 0) {
    throw new Error(
      `${where}: tokenEndpoint.url is required (non-empty string)`
    )
  }
  if (
    typeof epRec['ttlSeconds'] !== 'number' ||
    !Number.isFinite(epRec['ttlSeconds']) ||
    epRec['ttlSeconds'] <= 0
  ) {
    throw new Error(
      `${where}: tokenEndpoint.ttlSeconds must be a positive number`
    )
  }
  const tile = c['tile']
  if (typeof tile !== 'object' || tile === null) {
    throw new Error(`${where}: tile is required (object)`)
  }
  const tileRec = tile as Record<string, unknown>
  if (typeof tileRec['url'] !== 'string' || tileRec['url'].length === 0) {
    throw new Error(`${where}: tile.url is required (non-empty string)`)
  }
  return c as unknown as TokenProviderConfig
}
