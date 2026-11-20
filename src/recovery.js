/** Private, configured state migrations with a durable crash-recovery journal. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readPointer } from './turn-context.js'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const hashes = z.object({ context: digest, lifecycle: digest, runtime: digest }).strict()
const record = z.object({ operationId: z.string(), fingerprint: digest, sessionId: z.string(), createdAt: z.number().int().safe().nonnegative(),
  server: z.string(), configuration: digest, before: hashes, after: hashes, phase: z.enum(['prepared', 'remote', 'complete']) }).strict()
export const recoveryDomain = { name: 'mcp_connector_recovery', version: 1, tables: { operations: { valueSchema: record } } }
const fail = message => { throw new Error(`MCP recovery: ${message}`) }
const names = ['context', 'lifecycle', 'runtime']
const slotsFor = c => ({ context: c.recoveryContext, lifecycle: c.recoveryLifecycle, runtime: c.recoveryRuntime })
const configuration = c => hash(names.map(n => slotsFor(c)[n].fingerprint()))
const mapSlots = (slots, fn) => Object.fromEntries(names.map(n => [n, fn(slots[n], n)]))

export async function installRecovery(ctx, connections, operations, allows, logger) {
  if (!connections.some(c => c.entry.lifecycle) && !operations.length) return undefined
  const facility = ctx.get('storageDomain'), query = ctx.get('sessionQuery')
  if (!facility?.open || !query?.readSession) fail('durable storage and verified session reads are required')
  const domain = await facility.open(recoveryDomain), table = domain.table('operations')
  const blocked = new Set(), configured = new Map(operations.map(o => [o.operationId, o]))
  let disposed = false, running
  function refreshGate() {
    blocked.clear()
    for (const [, r] of table.entries()) if (r.phase !== 'complete') blocked.add(r.sessionId)
    for (const o of operations) {
      const r = table.get(hash(o.operationId))
      if (!r || r.phase !== 'complete' || r.fingerprint !== hash(o)) blocked.add(o.sessionId)
    }
  }
  refreshGate()
  const deny = agent => disposed || blocked.has(agent?.session?.header?.id)
  ctx.effect(() => ctx.tools.guard(exec => deny(exec.agent) ? 'A private MCP recovery is pending. Finish recovery before continuing this conversation.' : undefined), 'mcp-connector: recovery tool gate')
  ctx.effect(() => ctx.on('tools/execute', (exec, next) => { if (deny(exec.agent)) fail('recovery is pending'); return next() }, { prepend: true }), 'mcp-connector: recovery dispatch gate')
  ctx.effect(() => ctx.on('agent/pre-step', (payload, next) => { if (deny(payload.agent)) fail('recovery is pending; keep the operation configuration and retry'); return next() }, { prepend: true }), 'mcp-connector: recovery step gate')
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    if (disposed || blocked.has(options.sessionId)) fail('recovery is pending; generation is not admitted')
    return next()
  }, { prepend: true }), 'mcp-connector: recovery model gate')
  ctx.effect(() => async () => { disposed = true; await running?.catch(() => {}); await domain.close() }, 'mcp-connector: durable recovery journal')

  async function inspect(server, sessionId) {
    if (disposed) fail('connector is stopping')
    const c = connections.find(c => c.entry.name === server), slots = c && slotsFor(c)
    if (!c?.entry.enabled || names.some(n => !slots[n])) fail('a complete configured lifecycle service is required')
    const snapshot = await query.readSession(sessionId, AbortSignal.timeout(30000)), h = snapshot.session
    if (h.id !== sessionId || !Number.isSafeInteger(h.createdAt) || h.origin !== undefined || (h.delegationDepth ?? 0) !== 0
      || !allows(c, { session: { header: h } })) fail('the original persistent conversation is unavailable or out of scope')
    const values = mapSlots(slots, s => s.read(sessionId))
    if (names.some(n => !values[n] || values[n].sessionId !== sessionId || values[n].createdAt !== h.createdAt)
      || !slots.lifecycle.owns(values.lifecycle)) fail('durable ownership is missing or belongs to another service')
    return { c, slots, values, claim: { id: h.id, createdAt: h.createdAt, parentId: h.parentSession ?? null, temporary: false, seeded: h.isSeeded === true },
      review: { server, sessionId, createdAt: h.createdAt, parentId: h.parentSession ?? null, configuration: configuration(c),
        expected: mapSlots(slots, (_s, n) => hash(values[n])), fromPins: slots.context.pins(values.context) ?? null } }
  }
  async function perform(o) {
    const key = hash(o.operationId), fingerprint = hash(o)
    let journal = table.get(key)
    if (journal && journal.fingerprint !== fingerprint) fail('an operation identifier was reused with different configuration')
    // A completed old operation is a receipt, never permission to rewind state.
    if (journal?.phase === 'complete') { refreshGate(); return }
    const { c, slots, values, claim, review } = await inspect(o.server, o.sessionId)
    if (claim.createdAt !== o.createdAt || review.configuration !== o.configuration) fail('reviewed conversation or target configuration changed')
    const transformed = mapSlots(slots, (s, n) => s.transform(values[n], o.toPins))
    if (!journal) {
      if (names.some(n => review.expected[n] !== o.expected[n])) fail('durable conversation state changed since private review')
      const pins = slots.context.pins(values.context)
      if (pins !== undefined && JSON.stringify(pins) !== JSON.stringify(o.fromPins)) fail('reviewed previous pins do not match')
      journal = record.parse({ operationId: o.operationId, fingerprint, sessionId: o.sessionId, createdAt: o.createdAt, server: o.server,
        configuration: o.configuration, before: o.expected, after: mapSlots(slots, (_s, n) => hash(transformed[n])), phase: 'prepared' })
      // This must be durable before any request can change the remote binding.
      await table.put(key, journal)
    }
    if (journal.configuration !== review.configuration || names.some(n => {
      const current = hash(values[n])
      return current !== journal.before[n] && current !== journal.after[n]
    })) fail('recovery state changed unexpectedly; do not reset ownership')
    if (journal.phase === 'prepared') {
      if (names.some(n => hash(values[n]) !== journal.before[n])) fail('local recovery advanced without a durable remote proof')
      if (Object.hasOwn(o.metadata, c.entry.runtimeMetadata.namespace)) fail('configured recovery metadata cannot override the actual conversation')
      const result = await c.recoveryCall(o.tool, o.arguments, { ...o.metadata, [c.entry.runtimeMetadata.namespace]: { ...claim, turn: `recovery_${hash(o.operationId)}` } })
      if (result?.isError === true || readPointer(result?.structuredContent, o.proof.operationId) !== o.operationId
        || JSON.stringify(o.proof.before.map(p => readPointer(result.structuredContent, p))) !== JSON.stringify(o.fromPins)
        || JSON.stringify(o.proof.after.map(p => readPointer(result.structuredContent, p))) !== JSON.stringify(o.toPins)) fail('server did not prove the exact approved recovery')
      journal = { ...journal, phase: 'remote' }
      await table.put(key, journal)
    }
    for (const n of names) {
      if (disposed) fail('connector is stopping')
      const current = slots[n].read(o.sessionId), currentHash = hash(current)
      if (currentHash === journal.after[n]) continue
      if (currentHash !== journal.before[n]) fail('a durable recovery record changed concurrently')
      const next = slots[n].transform(current, o.toPins)
      if (hash(next) !== journal.after[n]) fail('recovery transform differs from its durable plan')
      await slots[n].put(o.sessionId, next)
    }
    await table.put(key, { ...journal, phase: 'complete' })
    refreshGate()
  }
  return {
    inspect: async (server, sessionId) => (await inspect(server, sessionId)).review,
    status: () => ({ blockedSessions: [...blocked], operations: [...table.entries()].map(([, r]) => ({ operationId: r.operationId, sessionId: r.sessionId, phase: r.phase })) }),
    run() {
      if (running) return running
      if (disposed) return Promise.reject(new Error('MCP recovery: connector is stopping'))
      running = (async () => {
        for (const o of configured.values()) {
          try { await perform(o) } catch {
            // Keep the journal and all gates active; no remote data in logs.
            logger.warn(`MCP recovery remains pending for operation ${o.operationId}`)
          }
        }
      })().finally(() => { running = undefined })
      return running
    },
  }
}
