import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OAuthRecordStore } from '../src/oauth/store.js'

/**
 * A credentials stub that enforces the real store's JSON-only rule.
 * @returns the service plus its backing map.
 */
function strictCredentials() {
  const records = new Map()
  const assertJson = (value, seen = new Set()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return
      throw new TypeError('non-finite number')
    }
    if (typeof value === 'object') {
      if (seen.has(value)) throw new TypeError('cyclic')
      if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
        seen.add(value)
        for (const nested of Object.values(value)) assertJson(nested, seen)
        seen.delete(value)
        return
      }
    }
    throw new TypeError('value JSON cannot represent')
  }
  return {
    records,
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) {
        assertJson(next)
        records.set(key, next)
      }
      return next
    },
    async deleteRecord(key) { records.delete(key) },
  }
}

describe('OAuth record store', () => {
  it('strips undefined members and stringifies URL values before writing', async () => {
    const credentials = strictCredentials()
    const store = new OAuthRecordStore({
      credentials,
      scope: 'mcp-connector',
      id: 'server-test',
      serverName: 'test',
    })
    const written = await store.update(current => ({
      ...current,
      clientInformation: { client_id: 'abc' },
      tokens: undefined,
      codeVerifier: undefined,
      authorizationUrl: undefined,
      discovery: { resourceMetadataUrl: new URL('https://auth.example.com/meta') },
    }))
    assert.equal(written.tokens, undefined)
    assert.equal(written.codeVerifier, undefined)
    assert.equal(written.discovery.resourceMetadataUrl, 'https://auth.example.com/meta')
    const stored = credentials.records.get('mcp-connector/server-test')
    assert.deepEqual(JSON.parse(JSON.stringify(stored)), stored)
    assert.equal(Object.hasOwn(stored.payload, 'tokens'), false)
  })

  it('keeps the payload readable through a fresh store instance', async () => {
    const credentials = strictCredentials()
    const first = new OAuthRecordStore({ credentials, scope: 'mcp-connector', id: 'server-test', serverName: 'test' })
    await first.update(() => ({ tokens: { access_token: 'at', token_type: 'Bearer' } }))
    const second = new OAuthRecordStore({ credentials, scope: 'mcp-connector', id: 'server-test', serverName: 'test' })
    const payload = await second.read()
    assert.equal(payload.tokens.access_token, 'at')
  })

  it('clears the client registration when the redirect changes', async () => {
    const credentials = strictCredentials()
    const store = new OAuthRecordStore({ credentials, scope: 'mcp-connector', id: 'server-test', serverName: 'test' })
    await store.update(() => ({ clientInformation: { client_id: 'abc' } }))
    await store.update(current => ({ ...current, clientInformation: undefined, callbackPort: 1234 }))
    const payload = await store.read()
    assert.equal(payload.clientInformation, undefined)
    assert.equal(payload.callbackPort, 1234)
  })
})