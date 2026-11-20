import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { API_PATHS, registerApi } from '../src/api.js'
import { createFakeContext, createWebHarness, invokeRoute } from './helpers/fake-ctx.js'

/** Build a plugin-shaped context with the panel services. */
function harness({ editable = true, rejection = undefined, auth = 'Bearer test', workspaces = [], recovery } = {}) {
  const entry = { id: 'include:mcp-connector' }
  const web = createWebHarness({ authenticated: auth === 'Bearer test' })
  if (rejection !== undefined) web.connection.requestRejection = () => rejection
  const edits = []
  const editor = editable
    ? {
        configuration: () => [{ entry, inherited: { servers: {} }, override: { servers: {} } }],
        async edit(target, change) {
          const next = change({ servers: {} }, { servers: {} })
          edits.push(next)
          return undefined
        },
      }
    : undefined
  const connections = [{
    entry: { name: 'fix' },
    snapshot: () => ({ name: 'fix', transport: 'stdio', state: 'connected', toolCount: 1, tools: [] }),
    authorize: async () => ({ name: 'fix', state: 'authorizing', authorizationUrl: 'https://auth.example/x' }),
    logout: async () => ({ name: 'fix', state: 'idle' }),
    reconnect: async () => ({ state: 'connected' }),
  }]
  const find = (name) => {
    if (name !== 'fix') throw new Error(`unknown MCP server "${String(name)}"`)
    return connections[0]
  }
  const { ctx, effects } = createFakeContext({
    services: {
      webServer: web.webServer,
      connection: web.connection,
      configEditor: editor,
      workspaceRegistry: { list: () => workspaces },
    },
  })
  ctx.fiber = { entry }
  registerApi(ctx, {
    rawConfig: { servers: { fix: { command: 'node' } } },
    connections,
    find,
    logger: { warn() {} },
    recovery,
  })
  return { ctx, web, edits, effects, entry }
}

describe('management API', () => {
  it('keeps recovery inspection and retry behind the private host fence', async () => {
    const calls = [], recovery = { inspect: async (...args) => (calls.push(args), { sessionId: args[1], expected: {} }),
      run: async () => { calls.push('retry') }, status: () => ({ blockedSessions: [] }) }
    const denied = harness({ auth: 'none', recovery })
    assert.equal((await invokeRoute(denied.web.routes.get(API_PATHS.action), { method: 'POST', body: { action: 'inspect-recovery', server: 'fix', sessionId: 'chat' } })).status, 401)
    assert.equal(calls.length, 0)
    const { web } = harness({ recovery }), route = web.routes.get(API_PATHS.action)
    const inspected = await invokeRoute(route, { method: 'POST', body: { action: 'inspect-recovery', server: 'fix', sessionId: 'chat' } })
    assert.equal(inspected.status, 200); assert.equal(inspected.body.review.sessionId, 'chat'); assert.deepEqual(calls, [['fix', 'chat']])
    const retried = await invokeRoute(route, { method: 'POST', body: { action: 'retry-recovery', server: 'fix' } })
    assert.equal(retried.status, 200); assert.deepEqual(retried.body.recovery.blockedSessions, [])
  })
  it('returns the editable config and live server state', async () => {
    const { web } = harness()
    const response = await invokeRoute(web.routes.get(API_PATHS.state))
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.editable, true)
    assert.deepEqual(response.body.config, { servers: {} })
    assert.equal(response.body.servers[0].state, 'connected')
    assert.equal(response.body.workspaceSupport, true)
    assert.deepEqual(response.body.workspaces, [])
  })

  it('lists the workspaces a server can be scoped to', async () => {
    const { web } = harness({ workspaces: [{ id: 'w1', title: 'Project', path: '/work/project' }] })
    const response = await invokeRoute(web.routes.get(API_PATHS.state))
    assert.deepEqual(response.body.workspaces, [{ id: 'w1', title: 'Project', path: '/work/project' }])
    assert.equal(response.body.workspaceSupport, true)
  })

  it('reports the config as read-only when no editor is mounted', async () => {
    const { web } = harness({ editable: false })
    const response = await invokeRoute(web.routes.get(API_PATHS.state))
    assert.equal(response.body.editable, false)
    assert.match(response.body.reason, /no configuration editor/)
    assert.deepEqual(response.body.config, { servers: { fix: { command: 'node' } } })
  })

  it('rejects an unauthenticated request', async () => {
    const { web } = harness({ auth: 'none' })
    const response = await invokeRoute(web.routes.get(API_PATHS.state), { headers: { authorization: '' } })
    assert.equal(response.status, 401)
    assert.equal(response.body.ok, false)
  })

  it('rejects a method that the route does not serve', async () => {
    const { web } = harness()
    const response = await invokeRoute(web.routes.get(API_PATHS.config), { method: 'GET' })
    assert.equal(response.status, 405)
  })

  it('refuses an invalid configuration with the validation message', async () => {
    const { web, edits } = harness()
    const response = await invokeRoute(web.routes.get(API_PATHS.config), {
      method: 'POST',
      body: { config: { servers: { bad: { transport: 'stdio' } } } },
    })
    assert.equal(response.status, 400)
    assert.match(response.body.error, /servers\.bad\.command/)
    assert.equal(edits.length, 0)
  })

  it('persists a valid configuration through the editor', async () => {
    const { web, edits } = harness()
    const next = { servers: { fix: { command: 'node', args: ['server.mjs'] } } }
    const response = await invokeRoute(web.routes.get(API_PATHS.config), { method: 'POST', body: { config: next } })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.deepEqual(edits, [next])
  })

  it('rejects a malformed body', async () => {
    const { web } = harness()
    const response = await invokeRoute(web.routes.get(API_PATHS.config), { method: 'POST', body: { nope: true } })
    assert.equal(response.status, 400)
  })

  it('dispatches authorize, logout, and reconnect actions', async () => {
    const { web } = harness()
    const route = web.routes.get(API_PATHS.action)
    const authorized = await invokeRoute(route, { method: 'POST', body: { action: 'authorize', server: 'fix' } })
    assert.equal(authorized.body.server.state, 'authorizing')
    const loggedOut = await invokeRoute(route, { method: 'POST', body: { action: 'logout', server: 'fix' } })
    assert.equal(loggedOut.body.server.state, 'idle')
    const reconnected = await invokeRoute(route, { method: 'POST', body: { action: 'reconnect', server: 'fix' } })
    assert.equal(reconnected.body.server.state, 'connected')
  })

  it('reports an unknown server and an unknown action', async () => {
    const { web } = harness()
    const route = web.routes.get(API_PATHS.action)
    const missing = await invokeRoute(route, { method: 'POST', body: { action: 'reconnect', server: 'nope' } })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /unknown MCP server/)
    const unknown = await invokeRoute(route, { method: 'POST', body: { action: 'explode', server: 'fix' } })
    assert.match(unknown.body.error, /Unknown action/)
  })
})
