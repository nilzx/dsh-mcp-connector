import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { apply } from '../index.js'
import { createFakeContext, waitFor } from './helpers/fake-ctx.js'

const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))

/** Mount the plugin with one stdio server and the policy matrix under test. */
async function mount(overrides = {}) {
  const harness = createFakeContext()
  await apply(harness.ctx, {
    servers: {
      fix: {
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        tools: {
          default: 'allow',
          rules: {
            'secret_*': 'deny',
            ask_me: 'ask',
            hidden_tool: 'off',
          },
        },
        ...overrides,
      },
    },
  })
  return harness
}

describe('stdio MCP server', () => {
  let harness

  before(async () => {
    harness = await mount()
  })

  after(async () => {
    await harness.dispose()
  })

  it('registers every discovered tool under the server-qualified name', () => {
    const names = [...harness.tools.keys()].filter(name => name.startsWith('mcp__fix__')).sort()
    assert.deepEqual(names, ['mcp__fix__ask_me', 'mcp__fix__boom', 'mcp__fix__crash', 'mcp__fix__echo', 'mcp__fix__secret_delete'])
  })

  it('does not register a tool whose policy is off', () => {
    assert.equal(harness.tools.has('mcp__fix__hidden_tool'), false)
  })

  it('calls a tool and renders its text result', async () => {
    const value = await harness.callTool('mcp__fix__echo', { text: 'hi' })
    const definition = harness.tools.get('mcp__fix__echo')
    assert.deepEqual(value, { content: [{ type: 'text', text: 'echo:hi' }] })
    const rendered = definition.output.render({ text: 'hi' }, value)
    assert.deepEqual(rendered, [{ type: 'text', text: 'echo:hi' }])
  })

  it('applies the deny policy in the pre-execute waterfall', async () => {
    const decision = await harness.preExecute('mcp__fix__secret_delete')
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.info.code, 'MCP_CONNECTOR_TOOL_DENIED')
  })

  it('applies the ask policy in the pre-execute waterfall', async () => {
    const decision = await harness.preExecute('mcp__fix__ask_me')
    assert.equal(decision.kind, 'ask')
    assert.match(decision.reason, /per-tool policy/)
  })

  it('delegates allow to the remaining listeners', async () => {
    const decision = await harness.preExecute('mcp__fix__echo')
    assert.deepEqual(decision, { kind: 'allow' })
  })

  it('ignores tools it does not own', async () => {
    const decision = await harness.preExecute('read_file')
    assert.deepEqual(decision, { kind: 'allow' })
  })

  it('surfaces an MCP tool-level error as a failed call', async () => {
    await assert.rejects(() => harness.callTool('mcp__fix__boom'), /boom happened/)
  })

  it('returns status as lossless JSON with no undefined members', async () => {
    const status = await harness.callTool('mcp_connector_status')
    const walk = (value) => {
      if (Array.isArray(value)) return value.every(walk)
      if (value !== null && typeof value === 'object') {
        return Object.values(value).every(entry => entry !== undefined && walk(entry))
      }
      return true
    }
    assert.equal(walk(status), true)
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
  })

  it('reports connection state and per-tool policies', async () => {
    const status = await harness.callTool('mcp_connector_status')
    const [server] = status.servers
    assert.equal(server.name, 'fix')
    assert.equal(server.state, 'connected')
    assert.equal(server.transport, 'stdio')
    assert.equal(server.auth, 'none')
    assert.equal(server.serverVersion, 'stdio-fixture 1.0.0')
    const policies = Object.fromEntries(server.tools.map(tool => [tool.remoteName, tool.policy]))
    assert.deepEqual(policies, {
      echo: 'allow',
      secret_delete: 'deny',
      ask_me: 'ask',
      boom: 'allow',
      crash: 'allow',
    })
  })

  it('unregisters every tool when the plugin unloads', async () => {
    const local = await mount()
    assert.equal(local.tools.has('mcp__fix__echo'), true)
    await local.dispose()
    assert.equal(local.tools.size, 0)
  })
})
describe('reconnection', () => {
  it('reconnects after the server process dies', async () => {
    const harness = await mount({ reconnect: { initialDelayMs: 100, maxAttempts: 3 } })
    try {
      const value = await harness.callTool('mcp__fix__crash')
      assert.deepEqual(value, { content: [{ type: 'text', text: 'bye' }] })

      const recovered = await waitFor(async () => {
        const status = await harness.callTool('mcp_connector_status')
        return status.servers[0].state === 'connected' ? status.servers[0] : false
      }, { timeoutMs: 10_000, what: 'reconnect after the child exited' })
      assert.equal(recovered.serverVersion, 'stdio-fixture 1.0.0')

      const echoed = await harness.callTool('mcp__fix__echo', { text: 'back' })
      assert.deepEqual(echoed, { content: [{ type: 'text', text: 'echo:back' }] })
    } finally {
      await harness.dispose()
    }
  })

  it('rejects activation when failOnStartupError is set and the server cannot start', async () => {
    const harness = createFakeContext()
    await assert.rejects(
      () => apply(harness.ctx, {
        failOnStartupError: true,
        servers: {
          broken: {
            transport: 'stdio',
            command: '/nonexistent/binary',
            startupTimeoutMs: 2_000,
            reconnect: { enabled: false },
          },
        },
      }),
      /server "broken" failed to start/,
    )
    await harness.dispose()
  })
})
