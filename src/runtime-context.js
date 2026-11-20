/** Authenticated MCP request metadata derived from the actual host session. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readPointer } from './turn-context.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = message => { throw new Error(`MCP runtime context: ${message}`) }
const historyRecord = z.object({ sessionId: z.string(), createdAt: z.number(), fingerprint: z.string(),
  source: z.object({ sessionId: z.string(), createdAt: z.number() }).strict().optional(),
  state: z.enum(['pending', 'ready']), through: z.number().int(), history: z.record(z.string(), z.unknown()),
  refs: z.array(z.object({ itemId: z.string(), sequences: z.array(z.number().int()) })) }).strict()
export const runtimeContextDomain = { name: 'mcp_connector_runtime', version: 1,
  tables: { histories: { valueSchema: historyRecord } } }

function claim(agent) {
  const h = agent?.session?.header
  if (typeof h?.id !== 'string' || !Number.isSafeInteger(h.createdAt) || h.createdAt < 0) fail('persistent session identity is unavailable')
  return { id: h.id, createdAt: h.createdAt, parentId: h.parentSession ?? null,
    temporary: h.origin !== undefined || (h.delegationDepth ?? 0) !== 0, seeded: h.isSeeded === true }
}
function messages(events) {
  const result = []
  let partial = false
  for (const e of events) {
    // Replacement copies are model-only summaries, not original exchanges.
    if (e.surfaceOp?.op === 'replace') continue
    const message = e.type === 'user/message' && e.data.source?.kind === 'user' ? e.data
      : e.type === 'assistant/message' ? e.data.message : undefined
    if (!message) continue
    const content = []
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text })
      else if (!['reasoning', 'tool-call'].includes(block.type)) partial = true
    }
    if (content.length || message.role === 'user') result.push({ role: message.role, content })
  }
  return { messages: result, partial: partial || result.length === 0 }
}

/** Freeze completed user/assistant exchanges, excluding system and tool data. */
export function historyFromSnapshot(snapshot) {
  const closed = []
  let open
  for (const e of snapshot.events) {
    if (e.type === 'turn/start') open = { turn: e.data.turn, events: [], start: e.time }
    else if (e.type === 'turn/end' && open?.turn === e.data.turn) { closed.push({ ...open, end: e.seq, complete: e.data.reason.kind === 'completed' }); open = undefined }
    else if (open && (e.type === 'user/message' || e.type === 'assistant/message')) open.events.push(e)
  }
  const last = closed.findLastIndex(t => t.complete)
  const items = [], refs = [], gaps = []
  const selected = new Set(closed.slice(0, last + 1).flatMap(t => t.events.map(e => e.seq)))
  const cutoffSeq = last < 0 ? -1 : closed[last].end
  const orphaned = snapshot.events.some(e => e.seq <= cutoffSeq && !selected.has(e.seq)
    && e.surfaceOp?.op !== 'replace' && (e.type === 'assistant/message' || e.type === 'user/message' && e.data.source?.kind === 'user'))
  if (orphaned || (snapshot.inheritedEventCount ?? 0) > 0 && !snapshot.session.parentSession) gaps.push({ id: 'unattributed_prefix', from: null, to: null, reason: 'unavailable' })
  const originals = new Set(snapshot.events.filter(e => e.surfaceOp?.op !== 'replace').map(e => e.seq))
  const missingSummarySource = snapshot.events.some(e => e.surfaceOp?.op === 'replace'
    && (!Array.isArray(e.sourceEventSeqs) || e.sourceEventSeqs.some(seq => !originals.has(seq))))
  if (missingSummarySource) gaps.push({ id: 'summary_sources', from: null, to: null, reason: 'summary_only' })
  for (let sequence = 0; sequence <= last; sequence++) {
    const turn = closed[sequence]
    if (!turn.complete) { gaps.push({ id: `gap_${sequence}`, from: sequence, to: sequence, reason: 'unavailable' }); continue }
    const content = messages(turn.events), itemId = `history_${hash([snapshot.session.id, turn.turn, turn.end])}`
    if (content.partial) gaps.push({ id: `gap_${sequence}`, from: sequence, to: sequence, reason: 'summary_only' })
    items.push({ itemId, turnId: `turn_${turn.turn}`, sequence, contentDigest: hash(content.messages), material: content.partial ? 'summary' : 'original', status: 'completed',
      occurrence: Number.isSafeInteger(turn.start) && turn.start > 0 ? { precision: 'instant', at: turn.start } : { precision: 'unknown' } })
    refs.push({ itemId, sequences: turn.events.map(e => e.seq) })
  }
  if (last < 0 && closed.length) gaps.push({ id: 'unavailable_history', from: null, to: null, reason: 'unavailable' })
  if (items.length > 5000 || gaps.length > 100) fail('initial history exceeds the supported manifest size')
  const tail = items.at(-1)
  // Nonempty manifests use bounded ranges; unknown-prefix gaps cover the known range.
  if (tail) for (const gap of gaps) if (gap.from === null) { gap.from = 0; gap.to = tail.sequence }
  return { through: last < 0 ? -1 : closed[last].end, refs, history: {
    cutoff: tail ? { itemId: tail.itemId, turnId: tail.turnId, sequence: tail.sequence } : null,
    coverage: gaps.length ? 'partial' : 'complete', gaps, items,
  } }
}

export async function installRuntimeContext(ctx, connections, allows) {
  const enabled = connections.filter(c => c.entry.runtimeMetadata !== undefined)
  if (!enabled.length) return
  const facility = ctx.get('storageDomain'), query = ctx.get('sessionQuery')
  if (!facility?.open || !query?.readSession) fail('storageDomain and sessionQuery services are required')
  const domain = await facility.open(runtimeContextDomain), table = domain.table('histories'), turns = new WeakMap(), pending = new Map()
  let disposed = false
  ctx.effect(() => async () => { disposed = true; await Promise.allSettled([...pending.values()]); await domain.close() }, 'mcp-connector: runtime metadata')
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (!turns.has(payload.agent) || payload.step === 1 || decision.messages.some(m => m.source?.kind === 'user')) {
      turns.set(payload.agent, `turn_${hash([payload.turn, payload.step, decision.messages.filter(m => m.source?.kind === 'user').map(m => m.id ?? null)])}`)
    }
    return decision
  }), 'mcp-connector: trusted turn identity')
  const fingerprint = c => hash([c.entry.transport, c.entry.url, c.entry.command, c.entry.args, c.entry.runtimeMetadata])
  function owner(connection, agent) {
    if (disposed) fail('connector is stopping')
    if (!allows(connection, agent)) fail('server is unavailable to this agent')
    const c = claim(agent)
    if (c.temporary) fail('temporary agents cannot export conversation history')
    const key = hash([connection.entry.name, c.id]), expected = fingerprint(connection), value = table.get(key)
    if (value && (value.sessionId !== c.id || value.createdAt !== c.createdAt || value.fingerprint !== expected)) fail('history owner or endpoint changed')
    return { c, key, expected, value }
  }
  const serialized = async (key, task) => {
    const previous = pending.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => { if (disposed) fail('connector is stopping'); return task() })
    pending.set(key, next)
    try { return await next } finally { if (pending.get(key) === next) pending.delete(key) }
  }
  function history(connection, agent) {
    const { value } = owner(connection, agent)
    if (value?.state !== 'ready') fail('activate this service successfully before reading frozen history')
    return value
  }
  function metadata(connection, tool, exec, captured) {
    const { c } = owner(connection, exec?.agent), turn = turns.get(exec.agent)
    if (turn === undefined) fail('trusted active conversation is required')
    const config = connection.entry.runtimeMetadata
    const frozen = config.historyTools.includes(tool) ? captured ?? history(connection, exec.agent) : undefined
    return { [config.namespace]: { ...c, turn, ...(frozen === undefined ? {} : { history: frozen.history }) } }
  }
  for (const connection of enabled) {
    connection.recoveryRuntime = {
      fingerprint: () => fingerprint(connection),
      read: id => table.get(hash([connection.entry.name, id])),
      transform: record => ({ ...record, fingerprint: fingerprint(connection) }),
      put: (id, record) => table.put(hash([connection.entry.name, id]), historyRecord.parse(record)),
    }
    connection.runtimeInherit = async (agent, signal) => {
      const initial = owner(connection, agent)
      return serialized(initial.key, async () => {
        const { c, key, expected, value } = owner(connection, agent)
        if (value) return
        if (c.parentId === null || c.parentId === c.id) fail('verified parent conversation is required')
        const parent = table.get(hash([connection.entry.name, c.parentId]))
        const snapshot = await query.readSession(c.parentId, signal)
        signal.throwIfAborted()
        if (!parent || parent.sessionId !== c.parentId || snapshot.session.id !== c.parentId
          || snapshot.session.createdAt !== parent.createdAt || parent.fingerprint !== expected) fail('parent history ownership is unavailable')
        await table.put(key, historyRecord.parse({ ...parent, sessionId: c.id, createdAt: c.createdAt,
          source: parent.source ?? { sessionId: parent.sessionId, createdAt: parent.createdAt } }))
      })
    }
    connection.runtimeMeta = async (tool, exec) => metadata(connection, tool, exec)
    connection.runtimeCall = async (tool, args, exec, invoke) => {
      const config = connection.entry.runtimeMetadata, initial = owner(connection, exec?.agent)
      if (!config.captureTools.includes(tool)) return invoke(args, metadata(connection, tool, exec))
      return serialized(initial.key, async () => {
        let { c, key, expected, value } = owner(connection, exec.agent)
        const fresh = value === undefined
        if (fresh) {
          const snapshot = await query.readSession(c.id, exec.signal)
          exec.signal.throwIfAborted()
          if (snapshot.session.id !== c.id || snapshot.session.createdAt !== c.createdAt) fail('history observation changed owner')
          value = historyRecord.parse({ sessionId: c.id, createdAt: c.createdAt, fingerprint: expected,
            state: 'pending', ...historyFromSnapshot(snapshot) })
          await table.put(key, value)
        }
        // Persist the boundary before sending. An ambiguous transport failure must
        // never move it forward, even across a process restart.
        const result = await invoke(args, metadata(connection, tool, exec, value))
        exec.signal.throwIfAborted()
        if (value.state === 'pending' && config.captureRollback !== undefined) {
          let rejected = false
          try { rejected = readPointer(result?.structuredContent, config.captureRollback.pointer) === config.captureRollback.value } catch {}
          if (rejected) { await table.delete(key); return result }
        }
        if (result?.isError === true) return result
        if (value.state !== 'ready') await table.put(key, { ...value, state: 'ready' })
        return result
      })
    }
  }
  ctx.effect(() => ctx.tools.register({
    name: 'mcp_connector_history',
    description: 'Read the frozen completed conversation exchanges used by an enabled MCP service. Only this agent\'s own conversation is accessible. Reads original completed exchanges from the retained conversation log, including originals shadowed by compaction; replacement summaries, system prompts, private reasoning and tool output are excluded. Missing material is explicit. This never approves a remote proposal.',
    parameters: { type: 'object', properties: { server: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['server'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const connection = enabled.find(c => c.entry.name === args.server)
      if (!connection || !allows(connection, exec?.agent)) fail('history service is unavailable')
      const record = history(connection, exec.agent), offset = args.offset ?? 0, limit = args.limit ?? 5
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.refs.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('invalid history page')
      const source = record.source ?? record
      const snapshot = await query.readSession(source.sessionId, exec.signal)
      if (snapshot.session.id !== source.sessionId || snapshot.session.createdAt !== source.createdAt) fail('history owner changed')
      const bySeq = new Map(snapshot.events.filter(e => e.seq <= record.through).map(e => [e.seq, e]))
      const items = []
      let bytes = 0
      for (const ref of record.refs.slice(offset, offset + limit)) {
        const events = ref.sequences.map(seq => bySeq.get(seq))
        if (events.some(e => e === undefined)) fail('frozen history is no longer available')
        const content = messages(events).messages, item = record.history.items.find(i => i.itemId === ref.itemId)
        if (!item || hash(content) !== item.contentDigest) fail('frozen history content changed')
        const value = { ...item, messages: content }, size = Buffer.byteLength(JSON.stringify(value))
        if (size > 262144) fail('a history item exceeds the delivery limit')
        if (items.length && bytes + size > 65536) break
        items.push(value); bytes += size
      }
      const next = offset + items.length
      return { source: 'completed_conversation_log', offset, nextOffset: next < record.refs.length ? next : null, total: record.refs.length, coverage: record.history.coverage, gaps: record.history.gaps, items }
    },
  }), 'mcp-connector: scoped initial history')
}
