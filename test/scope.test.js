import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { apply } from '../index.js'
import { createFakeContext } from './helpers/fake-ctx.js'

const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))

/**
 * Create one agent stub whose scope records tool restrictions.
 * @param id - session id.
 * @param cwd - reported working directory.
 */
function createAgent(id, cwd) {
  const restrictions = []
  return {
    id,
    session: { header: { cwd } },
    restrictions,
    ctx: {
      tools: {
        restrict(filter) {
          restrictions.push(filter)
          return () => { restrictions.splice(restrictions.indexOf(filter), 1) }
        },
      },
    },
  }
}

/**
 * Mount one stdio server with a scope and return the harness pieces.
 * @param scope - the server's scope.
 * @param agents - agents the registry reports.
 */
async function mount(scope, agents) {
  const harness = createFakeContext({
    services: {
      agents: { list: () => agents },
      workingDirectory: { get: session => session.header?.cwd },
    },
  })
  await apply(harness.ctx, {
    servers: {
      fix: {
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        scope,
        reconnect: { enabled: false },
      },
    },
  })
  return harness
}

describe('workspace scope', () => {
  it('keeps a global server visible to every agent', async () => {
    const inside = createAgent('a', '/work/allowed')
    const outside = createAgent('b', '/work/other')
    const harness = await mount({ mode: 'global' }, [inside, outside])
    try {
      assert.equal(inside.restrictions.length, 0)
      assert.equal(outside.restrictions.length, 0)
    } finally {
      await harness.dispose()
    }
  })

  it('hides a workspace-scoped server from sessions elsewhere', async () => {
    const inside = createAgent('a', '/work/allowed')
    const outside = createAgent('b', '/work/other')
    const harness = await mount({ mode: 'workspaces', paths: ['/work/allowed'] }, [inside, outside])
    try {
      assert.equal(inside.restrictions.length, 0)
      assert.equal(outside.restrictions.length, 1)
      const denied = outside.restrictions[0].deny
      assert.ok(denied.includes('mcp__fix__echo'), denied.join(','))
      assert.ok(denied.every(name => name.startsWith('mcp__fix__')))
    } finally {
      await harness.dispose()
    }
  })

  it('applies the scope to an agent created later', async () => {
    const agents = []
    const harness = await mount({ mode: 'workspaces', paths: ['/work/allowed'] }, agents)
    try {
      assert.equal(agents.length, 0)
      const late = createAgent('late', '/work/elsewhere')
      agents.push(late)
      for (const listener of harness.listeners.get('agent/created') ?? []) {
        await listener({ agent: late })
      }
      assert.equal(late.restrictions.length, 1)
    } finally {
      await harness.dispose()
    }
  })

  it('drops the restriction when the plugin unloads', async () => {
    const outside = createAgent('b', '/work/other')
    const harness = await mount({ mode: 'workspaces', paths: ['/work/allowed'] }, [outside])
    assert.equal(outside.restrictions.length, 1)
    await harness.dispose()
    assert.equal(outside.restrictions.length, 0)
  })
})