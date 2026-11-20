import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { describe, it, test } from 'node:test'
import { apply } from '../index.js'
import { normalizeConfig } from '../src/config.js'
import { createFakeContext, waitFor } from './helpers/fake-ctx.js'

const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))
function agent(id, header) {
  const restrictions = []
  return { id, session: header === null ? {} : { header }, restrictions,
    ctx: { tools: { restrict(filter) { restrictions.push(filter); return () => restrictions.splice(restrictions.indexOf(filter), 1) } } } }
}
async function mount({ instructions = 'Use {{literal}} carefully.', scope = { mode: 'global' }, delegation = 'allow', agents = [], tools } = {}) {
  const h = createFakeContext({ services: { agents: { list: () => agents }, workingDirectory: { get: s => s.header?.cwd } } })
  await apply(h.ctx, { servers: { fix: { command: process.execPath, args: [fixture], env: { FIXTURE_INSTRUCTIONS: instructions }, scope, delegation, ...(tools ? { tools } : {}), reconnect: { enabled: false } } } })
  return h
}
function rendered(h, a) {
  return [...h.sections.values()].map(s => typeof s.text === 'function' ? s.text({ agent: a }) : s.text).filter(Boolean).join('\n')
}
describe('server instructions and delegation', () => {
  it('normalizes delegation and rejects invalid policies', () => {
    assert.equal(normalizeConfig({ servers: { x: { command: 'node' } } }).servers[0].delegation, 'allow')
    assert.equal(normalizeConfig({ servers: { x: { command: 'node', delegation: 'deny' } } }).servers[0].delegation, 'deny')
    assert.throws(() => normalizeConfig({ servers: { x: { command: 'node', delegation: 'maybe' } } }))
  })
  it('publishes real handshake instructions literally and clears on disposal', async () => {
    const root = agent('root', { cwd: '/work/a' })
    const h = await mount({ agents: [root] })
    try {
      assert.match(rendered(h, root), /fix/)
      assert.match(rendered(h, root), /\{\{literal\}\}/)
      assert.ok([...h.sections.values()].every(s => s.interpolate === false))
    } finally { await h.dispose() }
    assert.equal(rendered(h, root), '')
  })
  it('clears instructions after an unexpected server disconnect', async () => {
    const root = agent('root', { cwd: '/work/a' })
    const h = await mount({ agents: [root] })
    try {
      assert.match(rendered(h, root), /literal/)
      await h.callTool('mcp__fix__crash')
      await waitFor(() => rendered(h, root) === '')
      assert.equal(rendered(h, root), '')
      const result = await h.callTool('mcp_connector_reconnect', { server: 'fix' })
      assert.equal(result.state, 'connected')
      assert.match(rendered(h, root), /\{\{literal\}\}/)
    } finally { await h.dispose() }
  })
  it('does not publish blank instructions', async () => {
    const h = await mount({ instructions: '  \n' })
    try { assert.equal(rendered(h, agent('r', {})).trim(), '') } finally { await h.dispose() }
  })
  it('rejects oversized UTF-8 instructions without registering usable tools', async () => {
    const h = await mount({ instructions: '界'.repeat(11000) })
    try { assert.equal(h.tools.has('mcp__fix__echo'), false); assert.equal(rendered(h, agent('r', {})), '') } finally { await h.dispose() }
  })
  it('hides instructions when every tool is off or denied', async () => {
    for (const policy of ['off', 'deny']) {
      const h = await mount({ tools: { default: policy } })
      try { assert.equal(rendered(h, agent('root', {})), '') } finally { await h.dispose() }
    }
  })
  it('filters management tools for inaccessible agents', async () => {
    const root = agent('root', { cwd: '/work/a' })
    const child = agent('child', { cwd: '/work/a', origin: 'subagent', delegationDepth: 1 })
    const outside = agent('outside', { cwd: '/work/b' })
    const h = await mount({ scope: { mode: 'workspaces', paths: ['/work/a'] }, delegation: 'deny', agents: [root, child, outside] })
    try {
      assert.equal((await h.callTool('mcp_connector_status', {}, root)).servers.length, 1)
      for (const a of [child, outside, undefined]) {
        assert.deepEqual((await h.callTool('mcp_connector_status', {}, a)).servers, [])
        for (const action of ['authorize', 'logout', 'reconnect']) {
          await assert.rejects(() => h.callTool(`mcp_connector_${action}`, { server: 'fix' }, a))
        }
      }
      assert.equal((await h.callTool('mcp_connector_reconnect', { server: 'fix' }, root)).state, 'connected')
    } finally { await h.dispose() }
  })
  it('filters scoped instructions and denies child and unknown executions', async () => {
    const root = agent('root', { cwd: '/work/a' })
    const fork = agent('fork', { cwd: '/work/a', parentSession: 'old' })
    const child = agent('child', { cwd: '/work/a', origin: 'subagent', delegationDepth: 1 })
    const depth = agent('depth', { cwd: '/work/a', delegationDepth: 1 })
    const unknown = agent('unknown', null)
    const outside = agent('outside', { cwd: '/work/b' })
    const h = await mount({ scope: { mode: 'workspaces', paths: ['/work/a'] }, delegation: 'deny', agents: [root, fork, child, depth, unknown, outside] })
    try {
      for (const a of [root, fork]) { assert.match(rendered(h, a), /literal/); assert.equal((await h.preExecute('mcp__fix__echo', {}, a)).kind, 'allow') }
      for (const a of [child, depth, unknown, outside, undefined]) { assert.equal(rendered(h, a), ''); assert.equal((await h.preExecute('mcp__fix__echo', {}, a)).kind, 'deny') }
      for (const a of [child, depth, unknown, outside]) assert.ok(a.restrictions.some(r => r.deny.includes('mcp__fix__echo')))
    } finally { await h.dispose() }
  })
})
test('history reader is visible only to eligible persistent agents',async()=>{
 const root=agent('root',{id:'root',createdAt:1,cwd:'/work/a'}), child=agent('child',{id:'child',createdAt:2,cwd:'/work/a',origin:'subagent',delegationDepth:1}), depth=agent('depth',{id:'depth',createdAt:3,cwd:'/work/a',delegationDepth:1}), unknown=agent('unknown',null), outside=agent('outside',{id:'outside',createdAt:4,cwd:'/work/b'})
 const records=new Map(),table={get:k=>records.get(k),put:async(k,v)=>records.set(k,v),delete:async k=>records.delete(k)}
 const h=createFakeContext({services:{agents:{list:()=>[root,child,depth,unknown,outside]},workingDirectory:{get:s=>s.header?.cwd},storageDomain:{open:async()=>({table:()=>table,close:async()=>{}})},sessionQuery:{readSession:async()=>({session:{id:'root',createdAt:1},events:[]})}}})
 await apply(h.ctx,{servers:{fix:{command:process.execPath,args:[fixture],scope:{mode:'workspaces',paths:['/work/a']},delegation:'deny',runtimeMetadata:{namespace:'io.example/session',historyTools:['echo'],captureTools:['echo']},reconnect:{enabled:false}}}})
 try {
  assert.ok(h.tools.has('mcp_connector_history'));assert.ok(!root.restrictions.some(r=>r.deny.includes('mcp_connector_history')))
  for(const a of [child,depth,unknown,outside]){assert.ok(a.restrictions.some(r=>r.deny.includes('mcp_connector_history')));await assert.rejects(()=>h.callTool('mcp_connector_history',{server:'fix'},a))}
 } finally {await h.dispose()}
})
