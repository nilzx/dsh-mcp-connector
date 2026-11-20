import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { apply } from '../index.js'
import { createCredentialStore, createFakeContext, waitFor } from './helpers/fake-ctx.js'
import { startOAuthMcpServer } from './helpers/oauth-http-server.js'

/** Mount one remote server against the fixture. */
async function mount(fixture, credentials, auth, overrides = {}) {
  const harness = createFakeContext({ services: { credentials } })
  await apply(harness.ctx, {
    servers: {
      remote: {
        transport: 'streamable-http',
        url: fixture.url,
        auth,
        tools: { default: 'allow' },
        ...overrides,
      },
    },
  })
  return harness
}

describe('OAuth over Streamable HTTP', () => {
  let fixture
  let credentials

  before(async () => {
    fixture = await startOAuthMcpServer()
    credentials = createCredentialStore()
  })

  after(async () => {
    await fixture.close()
  })

  it('opens authorization, completes the loopback callback, and connects', async () => {
    const harness = await mount(fixture, credentials, { type: 'oauth', openBrowser: false })

    const [pending] = (await harness.callTool('mcp_connector_status')).servers
    assert.equal(pending.state, 'authorizing')
    assert.ok(pending.authorizationUrl.startsWith(`${fixture.origin}/authorize`), pending.authorizationUrl)
    assert.equal(pending.toolCount, 0)

    // A repeated authorize call reuses the pending URL instead of starting a
    // new request that would invalidate the page the user already opened.
    const repeated = await harness.callTool('mcp_connector_authorize', { server: 'remote' })
    assert.equal(repeated.authorizationUrl, pending.authorizationUrl)
    assert.equal(fixture.state.authorizations, 0)

    // Be the browser: follow the authorization endpoint's redirect to the
    // connector's loopback listener.
    const authorization = await fetch(pending.authorizationUrl, { redirect: 'manual' })
    assert.equal(authorization.status, 302)
    const callbackUrl = authorization.headers.get('location')
    assert.match(callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback\?/)
    const callback = await fetch(callbackUrl)
    assert.equal(callback.status, 200)
    assert.match(await callback.text(), /Authorization complete/)

    const connected = await waitFor(async () => {
      const [server] = (await harness.callTool('mcp_connector_status')).servers
      return server.state === 'connected' ? server : false
    }, { what: 'reconnect after authorization' })

    assert.equal(connected.toolCount, 2)
    assert.equal(connected.authorizationUrl, undefined)
    assert.equal(fixture.state.registrations, 1)
    assert.equal(fixture.state.authorizations, 1)
    assert.equal(fixture.state.tokenRequests, 1)

    const value = await harness.callTool('mcp__remote__whoami')
    assert.deepEqual(value, { content: [{ type: 'text', text: 'authorized' }] })
    assert.match(fixture.state.lastMcpAuthorizationHeader, /^Bearer at-/)

    const record = credentials.records.get('mcp-connector/server-remote')
    assert.equal(record.kind, 'grant')
    assert.equal(record.payload.version, 1)
    assert.match(record.payload.tokens.access_token, /^at-/)
    assert.ok(record.payload.clientInformation.client_id.startsWith('client-'))

    await harness.dispose()
  })

  it('reuses the persisted registration and tokens without a new authorization', async () => {
    const harness = await mount(fixture, credentials, { type: 'oauth', openBrowser: false })
    const [server] = (await harness.callTool('mcp_connector_status')).servers
    assert.equal(server.state, 'connected')
    assert.equal(server.auth, 'oauth')
    assert.equal(fixture.state.authorizations, 1)
    assert.equal(fixture.state.registrations, 1)

    const value = await harness.callTool('mcp__remote__echo', { text: 'again' })
    assert.deepEqual(value, { content: [{ type: 'text', text: 'echo:again' }] })
    await harness.dispose()
  })

  it('forgets tokens on logout and reports the server idle', async () => {
    const harness = await mount(fixture, credentials, { type: 'oauth', openBrowser: false })
    const snapshot = await harness.callTool('mcp_connector_logout', { server: 'remote' })
    assert.equal(snapshot.state, 'idle')
    assert.equal(harness.tools.has('mcp__remote__whoami'), false)
    assert.equal(credentials.records.has('mcp-connector/server-remote'), false)
    await harness.dispose()
  })

  it('authorizes a static bearer token without OAuth', async () => {
    fixture.state.accessTokens.add('static-token')
    const harness = await mount(fixture, credentials, { type: 'bearer', token: 'static-token' })
    const [server] = (await harness.callTool('mcp_connector_status')).servers
    assert.equal(server.state, 'connected')
    const value = await harness.callTool('mcp__remote__whoami')
    assert.deepEqual(value, { content: [{ type: 'text', text: 'authorized' }] })
    assert.equal(fixture.state.lastMcpAuthorizationHeader, 'Bearer static-token')
    await harness.dispose()
  })
})