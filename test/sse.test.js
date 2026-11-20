import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply } from '../index.js'
import { createFakeContext } from './helpers/fake-ctx.js'
import { startSseMcpServer } from './helpers/sse-server.js'

describe('legacy SSE transport', () => {
  it('connects, lists tools, and calls one', async () => {
    const fixture = await startSseMcpServer()
    const harness = createFakeContext()
    try {
      await apply(harness.ctx, {
        servers: {
          legacy: {
            transport: 'sse',
            url: fixture.url,
            reconnect: { enabled: false },
          },
        },
      })
      const [server] = (await harness.callTool('mcp_connector_status')).servers
      assert.equal(server.state, 'connected')
      assert.equal(server.transport, 'sse')
      assert.equal(server.serverVersion, 'sse-fixture 1.0.0')
      assert.deepEqual(server.tools.map(tool => tool.name), ['mcp__legacy__sse_echo'])

      const value = await harness.callTool('mcp__legacy__sse_echo', { text: 'hi' })
      assert.deepEqual(value, { content: [{ type: 'text', text: 'sse:hi' }] })
    } finally {
      await harness.dispose()
      await fixture.close()
    }
  })
})