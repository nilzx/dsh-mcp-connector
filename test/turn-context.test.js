import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installTurnContext, readPointer, turnContextDomain } from '../src/turn-context.js'

function fixture(shared = new Map()) {
  const effects = [], listeners = new Map(), calls = [], wireArgs = []
  let pin = 'identity-a', token = 'session-a', failure, failPut = false
  const table = { get: k => shared.get(k), async put(k, v) { if (failPut) throw new Error('disk failed'); shared.set(k, structuredClone(v)) } }
  const ctx = { get: n => n === 'storageDomain' ? { open: async () => ({ table: () => table, close: async () => {} }) } : undefined,
    effect(fn) { effects.push(fn()) }, on(n, fn) { listeners.set(n, fn); return () => {} } }
  const config = { tool: 'load', arguments: {}, state: { session: '/session' }, pins: ['/identity'], maxBytes: 4096 }
  const connection = { entry: { name: 'fixture', enabled: true, transport: 'stdio', command: 'fixture', turnContext: config }, policies: new Map([['mcp__fixture__load', 'allow']]) }
  const agent = { session: { header: { id: 'root', createdAt: 123, isSeeded: false, delegationDepth: 0 } }, ctx: { tools: { execute: async input => {
    calls.push(input)
    if (failure) throw failure
    const result = await connection.contextCall('load', {}, { agent, signal: input.signal }, invoke)
    return { results: [{ result: { isError: false, value: result } }], additionalContexts: [], concluded: false }
  } } } }
  const invoke = async args => (wireArgs.push(args), { content: [{ type: 'text', text: 'current context' }], structuredContent: { session: token, identity: pin }, args })
  const signal = new AbortController().signal
  const pre = (turn, step, messages = []) => listeners.get('agent/pre-step')({ agent, turn, step, messages, signal }, async () => ({ kind: 'enter', messages }))
  return { ctx, connection, agent, invoke, pre, calls, wireArgs, listeners, effects, shared, signal, setPin: v => { pin = v }, setFailure: v => { failure = v }, setFailPut: v => { failPut = v } }
}
async function mounted(shared) { const f = fixture(shared); await installTurnContext(f.ctx, [f.connection], (_c, a) => a?.session?.header?.origin !== 'subagent', { warn() {} }); return f }
async function bind(f) { assert.equal((await f.pre(1, 1)).kind, 'enter'); return f.connection.contextCall('load', {}, { agent: f.agent, signal: f.signal }, f.invoke) }

test('refreshes each turn and steering but not intermediate tool steps, via scoped executor', async () => {
  const f = await mounted(); await bind(f)
  let d = await f.pre(2, 1, [{ source: { kind: 'user' } }]); assert.equal(d.kind, 'enter'); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].agent, f.agent); assert.match(d.messages.at(-1).content[0].text, /current context/)
  await f.pre(2, 2, []); assert.equal(f.calls.length, 1)
  await f.pre(2, 3, [{ source: { kind: 'user' } }]); assert.equal(f.calls.length, 2)
})
test('restores persisted state, injects mapped argument, and rejects changed pin', async () => {
  const shared = new Map(), first = await mounted(shared); await bind(first)
  const restored = await mounted(shared); const d = await restored.pre(3, 1); assert.equal(d.kind, 'enter'); assert.equal(restored.calls.length, 1); assert.equal(restored.wireArgs[0].session, 'session-a')
  restored.setPin('identity-b'); await assert.rejects(() => restored.pre(4, 1), { name: 'McpTurnContextError' })
})
test('rejects missing resumed state and preserves downstream rejection', async () => {
  const f = await mounted(); await assert.rejects(() => f.pre(2, 1), { name: 'McpTurnContextError' })
  const decision = await f.listeners.get('agent/pre-step')({ agent: f.agent, turn: 1, step: 1, signal: f.signal }, async () => ({ kind: 'reject' }))
  assert.equal(decision.kind, 'reject'); assert.equal(f.calls.length, 0)
})
test('rejects failure and disabled policy after activation', async () => {
  const f = await mounted(); await bind(f); f.setFailure(new Error('timeout')); await assert.rejects(() => f.pre(2, 1), { name: 'McpTurnContextError' })
  f.setFailure(undefined); f.connection.policies.set('mcp__fixture__load', 'deny'); await assert.rejects(() => f.pre(3, 1), { name: 'McpTurnContextError' })
})
test('JSON pointer reads own structured scalars only', () => {
  assert.equal(readPointer({ a: { 'b/c': 'v' } }, '/a/b~1c'), 'v')
  assert.throws(() => readPointer({}, '/__proto__'))
  assert.throws(() => readPointer({ a: {} }, '/a'))
})

test('rejects changed session identity and caller-selected state', async () => {
  const f = await mounted(); await bind(f)
  await assert.rejects(() => f.connection.contextCall('load', { session: 'forged' }, { agent: f.agent, signal: f.signal }, f.invoke))
  f.agent.session.header.createdAt = 456
  await assert.rejects(() => f.pre(2, 1), { name: 'McpTurnContextError' })
})
test('does not initialize seeded or resumed conversations', async () => {
  const f = await mounted(); f.agent.session.header.isSeeded = true
  await assert.rejects(() => f.pre(1, 1), { name: 'McpTurnContextError' })
})
test('neutral conversation stays unbound across turns without tool calls', async () => {
  const f = await mounted()
  for (let turn = 1; turn <= 4; turn++) assert.equal((await f.pre(turn, 1, [{ source: { kind: 'user' } }])).kind, 'enter')
  assert.equal(f.calls.length, 0)
})
test('blocks activated session when server is disabled or removed', async () => {
  const f = await mounted(); await bind(f)
  f.connection.entry.enabled = false
  await assert.rejects(() => f.pre(2, 1), { name: 'McpTurnContextError' })
})
test('child without binding does not refresh', async () => {
  const f = await mounted(); f.agent.session.header.origin = 'subagent'; f.agent.session.header.delegationDepth = 1
  assert.equal((await f.pre(1, 1)).kind, 'enter'); assert.equal(f.calls.length, 0)
})
test('failed durable write prevents result delivery', async () => {
  const f = await mounted(); await bind(f)
  const before = f.shared.size
  f.setFailPut(true)
  await assert.rejects(() => f.pre(2, 1), { name: 'McpTurnContextError' }); assert.equal(f.shared.size, before)
})
test('pre-aborted signal blocks refresh', async () => {
  const f = await mounted(); await bind(f)
  const c = new AbortController(); c.abort()
  const d = await f.listeners.get('agent/pre-step')({ agent: f.agent, turn: 2, step: 1, signal: c.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(d.kind, 'reject'); assert.equal(f.calls.length, 0)
})
test('real MCP stdio structuredContent reaches the state mapper', async () => {
  const { Client } = await import('@modelcontextprotocol/client')
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
  const { fileURLToPath } = await import('node:url')
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} })
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))] })
  await client.connect(transport)
  try {
    const f = await mounted(); await f.pre(1, 1)
    const result = await f.connection.contextCall('load', {}, { agent: f.agent, signal: f.signal }, args => client.callTool({ name: 'context_fixture', arguments: args }))
    assert.equal(result.structuredContent.session, 'fixture-session')
    const record = [...f.shared.values()][0].servers.fixture
    assert.equal(record.arguments.session, 'fixture-session'); assert.deepEqual(record.pins, ['fixture-identity'])
  } finally { await client.close() }
})
test('serializes concurrent context calls per session', async () => {
  const f = await mounted(); await bind(f)
  let active = 0, max = 0
  const invoke = async () => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 10)); active--; return { content: [{ type: 'text', text: 'ok' }], structuredContent: { session: 'session-a', identity: 'identity-a' } } }
  await Promise.all([1, 2, 3].map(() => f.connection.contextCall('load', {}, { agent: f.agent, signal: f.signal }, invoke)))
  assert.equal(max, 1)
})
test('installed dsh domain name contract accepts the declared domain', async t => {
  const path = process.env.DSH_STORAGE_DOMAIN_MODULE ?? '@deepseek-ai/dsh-storage-domain'
  let sdk
  try { sdk = await import(path) } catch { t.skip('installed dsh storage-domain unavailable'); return }
  assert.doesNotThrow(() => sdk.defineDomain(turnContextDomain))
  assert.throws(() => sdk.defineDomain({ name: 'mcp-connector-context', version: 1, tables: {} }))
})

test('rejects model override of fixed arguments', async () => {
  const f = await mounted(); f.connection.entry.turnContext.arguments = { mode: 'safe' }; await bind(f)
  await assert.rejects(() => f.connection.contextCall('load', { mode: 'unsafe' }, { agent: f.agent, signal: f.signal }, f.invoke))
})
