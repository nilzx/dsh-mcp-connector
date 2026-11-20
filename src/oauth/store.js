/**
 * Durable OAuth state for one MCP server.
 *
 * Client registration, tokens, the PKCE verifier, the pending `state` value and
 * the discovery snapshot live in a Host credential record (`<scope>/<id>`), so
 * a restart keeps the authorization the user already granted and configuration
 * files never hold a secret. Records are opaque to the credential seam; the
 * shape below is this plugin's own versioned payload.
 *
 * @module dsh-mcp-connector/oauth/store
 */

/** Record payload version; bump when the shape changes incompatibly. */
export const OAUTH_RECORD_VERSION = 1

/**
 * Derive the credential-record id for one server name.
 * @param serverName - configured server name.
 * @returns a lowercase hyphenated record id.
 */
export function recordIdForServer(serverName) {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `server-${slug === '' ? 'unnamed' : slug}`
}

/**
 * Read and write one OAuth record.
 */
export class OAuthRecordStore {
  /**
   * @param options - `{ credentials, scope, id, serverName }`.
   */
  constructor({ credentials, scope, id, serverName }) {
    this.credentials = credentials
    this.scope = scope
    this.id = id
    this.serverName = serverName
    this.key = `${scope}/${id}`
    this.cache = undefined
    this.loaded = false
  }

  /**
   * Read the stored payload.
   * @returns the payload, or undefined when nothing usable is stored.
   */
  async read() {
    if (this.loaded) return this.cache
    const record = await this.credentials.readRecord(this.key)
    this.cache = normalizePayload(record, this.serverName)
    this.loaded = true
    return this.cache
  }

  /**
   * Atomically update the stored payload.
   * @param mutate - receives the current payload (never undefined) and returns the next one.
   * @returns the next payload.
   */
  async update(mutate) {
    const current = (await this.read()) ?? defaultPayload(this.serverName)
    const next = mutate(current)
    if (next === undefined) return current
    const stamped = toJsonValue({
      ...next,
      version: OAUTH_RECORD_VERSION,
      server: this.serverName,
      updatedAt: new Date().toISOString(),
    })
    await this.credentials.modifyRecord(this.key, () => ({ kind: 'grant', payload: stamped }))
    this.cache = stamped
    this.loaded = true
    return stamped
  }

  /** Remove everything stored for this server. */
  async clear() {
    this.cache = undefined
    this.loaded = true
    await this.credentials.deleteRecord(this.key)
  }

  /**
   * Drop the fields one invalidation scope owns.
   * @param scope - the SDK's invalidation scope.
   */
  async invalidate(scope) {
    await this.update((current) => {
      const next = { ...current }
      if (scope === 'tokens' || scope === 'all') {
        delete next.tokens
        delete next.codeVerifier
        delete next.state
        delete next.authorizationUrl
      }
      if (scope === 'client' || scope === 'all') delete next.clientInformation
      if (scope === 'verifier') {
        delete next.codeVerifier
        delete next.state
        delete next.authorizationUrl
      }
      if (scope === 'discovery' || scope === 'all') delete next.discoveryState
      return next
    })
  }
}

/**
 * The empty payload for one server.
 * @param serverName - configured name.
 * @returns a payload with no credentials.
 */
function defaultPayload(serverName) {
  return { version: OAUTH_RECORD_VERSION, server: serverName }
}

/**
 * Validate a stored record, ignoring anything this plugin does not own.
 * @param record - the credential record, if any.
 * @param serverName - configured name used for the ownership check.
 * @returns the payload or undefined.
 */
function normalizePayload(record, serverName) {
  if (record === undefined || record === null) return undefined
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) return undefined
  const payload = record.payload
  if (payload.version !== OAUTH_RECORD_VERSION) return undefined
  if (typeof payload.server === 'string' && payload.server !== serverName) return undefined
  return payload
}

/**
 * Reduce a payload to exactly what JSON can represent.
 *
 * The credential store rejects `undefined` members, functions, class instances
 * and non-finite numbers. The OAuth SDK hands providers objects that may carry
 * any of those — a `URL` inside discovery metadata, an explicit `undefined`
 * when a flow ends — so the record is normalized before every write.
 *
 * @param value - the candidate payload.
 * @returns an equal value that survives a JSON round trip.
 */
function toJsonValue(value) {
  return JSON.parse(JSON.stringify(value))
}
