/** Configured MCP initialization workflows with durable ownership and output gates. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { publicToolName } from './naming.js'
import { contentToText } from './tools.js'
import { contextMessage, readPointer, reconcileDelivery } from './turn-context.js'
import { initializationStream } from './workflow-stream.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const marker = z.object({ id: z.string(), callId: z.string().optional(), digest: z.string().length(64) }).strict()
const owner = z.object({ server: z.string(), fingerprint: z.string(), phase: z.enum(['pending', 'initializing', 'ready']),
  loaded: z.object({ generation: z.number().int().safe().nonnegative(), marker }).strict().optional() }).strict()
const sessionRecord = z.object({ sessionId: z.string(), createdAt: z.number().int().safe().nonnegative(), groups: z.record(z.string(), owner) }).strict()
export const lifecycleDomain = { name: 'mcp_connector_lifecycle', version: 1, tables: { sessions: { valueSchema: sessionRecord } } }
const fail = message => { throw new Error(`MCP initialization: ${message}`) }
const fingerprint = c => {
  const { blockedTools: _policy, requireCreationAdmission: _admissionPolicy, ...workflow } = c.entry.lifecycle
  return hash([c.entry.name, c.entry.transport, c.entry.url, c.entry.command, c.entry.args, c.entry.cwd,
    c.entry.runtimeMetadata, c.entry.turnContext, workflow])
}

export async function installLifecycle(ctx, connections, allows, logger, inScope = allows) {
  const enabled = connections.filter(c => c.entry.lifecycle !== undefined)
  if (!enabled.length) return
  const creationAdmission = ctx.get('sessions')?.preparationAdmissionVersion === 1
  if (!creationAdmission && enabled.some(c => c.entry.lifecycle.requireCreationAdmission)) fail('this workflow requires host session preparation admission version 1; no silent downgrade is allowed')
  if (typeof ctx.tools?.guard !== 'function' || !ctx.get('llm')) fail('monotonic tool guards and model stream middleware are required')
  const facility = ctx.get('storageDomain')
  if (!facility?.open) fail('durable storageDomain service is required')
  const domain = await facility.open(lifecycleDomain), table = domain.table('sessions')
  const pending = new Map(), admissions = new Map(), restrictions = new Map()
  let disposed = false
  ctx.effect(() => async () => {
    disposed = true
    for (const item of restrictions.values()) item.release()
    restrictions.clear(); admissions.clear()
    await Promise.allSettled([...pending.values()]); await domain.close()
  }, 'mcp-connector: durable initialization')
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.session?.header?.id
    if (admissions.get(id)?.agent !== agent) return
    admissions.delete(id); restrictions.get(id)?.release(); restrictions.delete(id)
  }), 'mcp-connector: release initialization admission')

  function read(agent) {
    if (disposed) fail('connector is stopping')
    const h = agent?.session?.header
    if (typeof h?.id !== 'string' || !Number.isSafeInteger(h.createdAt) || h.createdAt < 0) fail('persistent conversation is unavailable')
    if (h.origin !== undefined || (h.delegationDepth ?? 0) !== 0) fail('temporary agents cannot initialize a persistent service')
    const key = hash(h.id), value = table.get(key)
    if (value && (value.sessionId !== h.id || value.createdAt !== h.createdAt)) fail('persistent conversation identity changed')
    return { key, value, id: h.id, createdAt: h.createdAt }
  }
  async function serialized(agent, task) {
    const { key } = read(agent), previous = pending.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => { if (disposed) fail('connector is stopping'); return task() })
    pending.set(key, next)
    try { return await next } finally { if (pending.get(key) === next) pending.delete(key) }
  }
  function entries(agent) {
    const state = read(agent)
    return Object.entries(state.value?.groups ?? {}).map(([group, entry]) => {
      const c = enabled.find(c => c.entry.name === entry.server)
      if (!c || c.entry.lifecycle.group !== group || c.entry.enabled === false || !allows(c, agent) || entry.fingerprint !== fingerprint(c)) fail('an initialized service was removed, changed or restricted')
      return { group, entry, connection: c, config: c.entry.lifecycle }
    })
  }
  async function inherit(agent, signal) {
    const h = agent.session.header
    if (read(agent).value || h.parentSession === undefined) return
    if (h.parentSession === h.id) fail('a conversation cannot inherit itself')
    const query = ctx.get('sessionQuery')
    if (!query?.readSession) fail('verified parent history is unavailable')
    await serialized(agent, async () => {
      const current = read(agent)
      if (current.value) return
      const parent = table.get(hash(h.parentSession))
      const snapshot = await query.readSession(h.parentSession, signal)
      signal.throwIfAborted()
      if (!parent || parent.sessionId !== h.parentSession || snapshot.session.id !== parent.sessionId
        || snapshot.session.createdAt !== parent.createdAt) fail('parent workflow ownership is unavailable')
      const groups = {}
      for (const [group, entry] of Object.entries(parent.groups)) {
        const c = enabled.find(c => c.entry.name === entry.server)
        if (!c || !allows(c, agent) || !c.entry.enabled || c.entry.lifecycle.group !== group
          || entry.fingerprint !== fingerprint(c) || !c.runtimeInherit) fail('parent workflow configuration changed')
        await c.runtimeInherit(agent, signal)
        groups[group] = { server: entry.server, fingerprint: entry.fingerprint, phase: 'pending' }
      }
      await table.put(current.key, sessionRecord.parse({ sessionId: current.id, createdAt: current.createdAt, groups }))
    })
  }
  function loaded(entry, agent, name) {
    if (!entry.loaded) return false
    // Tool-schema/system-prompt projection may advance the surface generation
    // without removing this exact persona result. Inspect the retained marker.
    const observation = reconcileDelivery({ arguments: {}, delivery: { generation: agent.session.surface?.contentGeneration,
      pending: { marker: entry.loaded.marker, arguments: {} } } }, agent, name)
    return observation.changed && !observation.reload
  }
  function restrict(agent) {
    const id = agent.session.header.id
    const initializing = entries(agent).filter(e => e.entry.phase !== 'ready')
    const allowed = initializing.map(e => new Set([...e.config.startTools, e.config.probe, ...e.config.allowedTools]
      .map(t => publicToolName(e.connection.entry.name, t)).concat(e.config.localTools)))
    const names = allowed.length ? [...allowed[0]].filter(n => allowed.every(set => set.has(n))).sort() : undefined
    const key = JSON.stringify(names), previous = restrictions.get(id)
    if (previous?.key === key) return
    previous?.release(); restrictions.delete(id)
    if (names) restrictions.set(id, { key, release: agent.ctx.tools.restrict({ allow: names }) })
  }
  const ready = (entry, c, agent) => entry.phase === 'ready' && c.contextReady?.(agent) === true
  function permitted(c, entry, agent, publicName) {
    const config = c.entry.lifecycle
    if (config.startTools.some(t => publicToolName(c.entry.name, t) === publicName) || publicToolName(c.entry.name, config.probe) === publicName) return true
    if (entry.phase === 'ready' && publicName === publicToolName(c.entry.name, c.entry.turnContext.tool)) return true
    return loaded(entry, agent, c.entry.name) && (config.allowedTools.some(t => publicToolName(c.entry.name, t) === publicName) || config.localTools.includes(publicName))
  }
  function denial(exec) {
    // Standalone service invocations have no conversation to inherit. The
    // server scope/runtime guards still reject protected MCP calls without it.
    if (!exec.agent) return undefined
    // Unbound temporary helpers remain independent; their server-specific access
    // is handled by the normal scope guard and authenticated metadata checks.
    const h = exec.agent.session?.header
    if (h?.origin !== undefined || (h?.delegationDepth ?? 0) !== 0) return undefined
    try {
      for (const { entry, connection: c } of entries(exec.agent)) {
        if (c.entry.lifecycle.blockedTools?.includes(exec.name)) return 'This tool can transfer protected conversation context. Use a fresh helper with only the task materials.'
        const start = enabled.find(other => other.entry.lifecycle.startTools.some(t => publicToolName(other.entry.name, t) === exec.name))
        if (start && start.entry.lifecycle.group === c.entry.lifecycle.group && start.entry.name !== c.entry.name) return 'This conversation already owns another service in the same initialization group.'
        if (!ready(entry, c, exec.agent) && !permitted(c, entry, exec.agent, exec.name)) return 'Finish the active MCP initialization and admit its full context before other work.'
      }
      return undefined
    } catch { return 'MCP initialization ownership or context could not be verified.' }
  }
  ctx.effect(() => ctx.tools.guard(denial), 'mcp-connector: initialization tool guard')
  // A batch can finish permission checks before an earlier exclusive start
  // call establishes its durable state. Recheck at actual dispatch as well.
  ctx.effect(() => ctx.on('tools/execute', async (exec, next) => {
    const reason = denial(exec)
    if (reason !== undefined) fail(reason)
    return next()
  }, { prepend: true }), 'mcp-connector: initialization dispatch guard')

  // Tool gates prevent configured copy operations before their bodies run.
  // A separately created/restored seeded helper still must not reach a model.
  function checkTemporary(agent) {
    const h = agent?.session?.header
    if (h?.origin === undefined && (h?.delegationDepth ?? 0) === 0) return
    const inherited = h.isSeeded === true || (agent.session.inheritedEventCount ?? 0) > 0
    if (!inherited) return
    const parent = typeof h.parentSession === 'string' ? table.get(hash(h.parentSession)) : undefined
    if (!Object.keys(parent?.groups ?? {}).length && !enabled.some(c => c.entry.enabled !== false && inScope(c, agent))) return
    // A seeded helper has no safe neutral attestation. In particular, absence
    // of a parent sidecar is not evidence that copied content is unbound.
    fail('temporary helpers must start with fresh context; inherited transcripts are not admitted')
  }
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => checkTemporary(agent)), 'mcp-connector: fresh helper admission')

  // Host-owned synchronous metadata arrives before a destination Session is
  // constructed or returned to a persistence owner. No transcript is inspected.
  if (creationAdmission) ctx.effect(() => ctx.on('session/preparing', request => {
    if (disposed) fail('connector is stopping')
    const h = request.header, agent = { session: { header: h } }
    const current = table.get(hash(h.id))
    if (current && (current.sessionId !== h.id || current.createdAt !== h.createdAt)) fail('persistent conversation identity changed before construction')
    const parent = typeof h.parentSession === 'string' ? table.get(hash(h.parentSession)) : undefined
    const owned = Object.keys(current?.groups ?? {}).length > 0
    const parentOwned = Object.keys(parent?.groups ?? {}).length > 0
    const scoped = enabled.some(c => c.entry.enabled !== false && inScope(c, agent))
    const temporary = h.origin !== undefined || (h.delegationDepth ?? 0) !== 0
    const inherited = h.isSeeded === true || request.inheritedEventCount > 0 || (!request.restoration && request.seedEventCount > 0)
    if (temporary) {
      if (owned) fail('a persistent workflow cannot be restored as a temporary helper')
      if ((inherited || request.seedEventCount > 0) && (owned || parentOwned || scoped)) fail('temporary helpers must start with fresh context; inherited transcripts are refused before construction')
      return
    }
    if (owned) entries(agent)
    if (!inherited || owned || (!parentOwned && !scoped)) return
    if (h.parentSession === h.id || !parentOwned || parent.sessionId !== h.parentSession) fail('seeded conversation has no trusted workflow parent before construction')
    for (const [group, entry] of Object.entries(parent.groups)) {
      const c = enabled.find(c => c.entry.name === entry.server)
      if (!c || c.entry.enabled === false || !allows(c, agent) || c.entry.lifecycle.group !== group || entry.fingerprint !== fingerprint(c)) fail('parent workflow configuration changed before construction')
    }
    // Source creation time and remote ownership are still checked by inherit()
    // before any model request. The host supplies the actual fork parent id.
  }), 'mcp-connector: pre-construction workflow admission')

  for (const c of enabled) {
    c.recoveryLifecycle = {
      fingerprint: () => fingerprint(c),
      read: id => table.get(hash(id)),
      owns: record => record?.groups?.[c.entry.lifecycle.group]?.server === c.entry.name,
      transform: record => ({ ...record, groups: { ...record.groups, [c.entry.lifecycle.group]: {
        server: c.entry.name, fingerprint: fingerprint(c), phase: 'pending',
      } } }),
      put: (id, record) => table.put(hash(id), sessionRecord.parse(record)),
    }
    const persistent = agent => agent?.session?.header?.origin === undefined && (agent?.session?.header?.delegationDepth ?? 0) === 0
    c.contextOwned = agent => persistent(agent) && entries(agent).some(e => e.connection === c)
    c.contextRequired = agent => persistent(agent) && entries(agent).some(e => e.connection === c && e.entry.phase === 'ready')
    c.lifecycleCall = async (tool, args, exec, invoke) => {
      if (!allows(c, exec.agent)) fail('service is unavailable to this agent')
      const config = c.entry.lifecycle, start = config.startTools.includes(tool), pointer = config.ready[tool]
      if (!start && pointer === undefined) return invoke(args)
      return serialized(exec.agent, async () => {
        let current = read(exec.agent), existing = current.value?.groups[config.group]
        if (existing && (existing.server !== c.entry.name || existing.fingerprint !== fingerprint(c))) fail('this conversation cannot switch its initialized service')
        const fresh = existing === undefined
        if (fresh && !start) return invoke(args)
        if (fresh) {
          existing = { server: c.entry.name, fingerprint: fingerprint(c), phase: 'pending' }
          await table.put(current.key, sessionRecord.parse({ sessionId: current.id, createdAt: current.createdAt,
            groups: { ...(current.value?.groups ?? {}), [config.group]: existing } }))
          restrict(exec.agent)
        }
        const result = await invoke(args)
        exec.signal.throwIfAborted()
        const rollback = c.entry.runtimeMetadata.captureRollback
        let definitelyUnbound = false
        try { definitelyUnbound = rollback !== undefined && readPointer(result?.structuredContent, rollback.pointer) === rollback.value } catch {}
        if (existing.phase === 'pending' && definitelyUnbound) {
          current = read(exec.agent)
          const groups = { ...current.value.groups }; delete groups[config.group]
          await table.put(current.key, sessionRecord.parse({ ...current.value, groups }))
          restrict(exec.agent)
          return result
        }
        if (result?.isError === true) return result
        const canRun = readPointer(result?.structuredContent, pointer)
        if (typeof canRun !== 'boolean') fail('initialization readiness must be boolean')
        const next = { ...existing, phase: canRun ? 'ready' : 'initializing' }
        if (start || tool === config.probe) {
          const text = contentToText(result?.content ?? [], tool), generation = exec.agent.session.surface?.contentGeneration
          if (!Number.isSafeInteger(generation) || generation < 0 || !text.trim() || Buffer.byteLength(text) > config.maxBytes) fail('initialization context is invalid')
          next.loaded = { generation, marker: { id: randomUUID(), digest: hash(text), ...(typeof exec.callId === 'string' ? { callId: exec.callId } : {}) } }
        }
        current = read(exec.agent)
        await table.put(current.key, sessionRecord.parse({ ...current.value, groups: { ...current.value.groups, [config.group]: next } }))
        // Update before the next tool set is resolved; a pre-step-only release
        // would leave one stale schema step and invalidate the first delta.
        restrict(exec.agent)
        return result
      })
    }
  }

  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const h = payload.agent?.session?.header
    if (h?.origin !== undefined || (h?.delegationDepth ?? 0) !== 0) { checkTemporary(payload.agent); return decision }
    const contexts = []
    try {
      await inherit(payload.agent, payload.signal)
      const current = read(payload.agent)
      admissions.set(current.id, { agent: payload.agent, signal: payload.signal })
      for (let e of entries(payload.agent)) {
        if (e.entry.phase === 'ready') continue
        const c = e.connection, config = e.config
        if (e.entry.phase === 'pending' || payload.step === 1 || decision.messages.some(m => m.source?.kind === 'user') || !loaded(e.entry, payload.agent, c.entry.name)) {
          const name = publicToolName(c.entry.name, config.probe)
          if (c.policies.get(name) !== 'allow') fail('automatic initialization recovery requires an allowed status tool')
          const batch = await payload.agent.ctx.tools.execute({ agent: payload.agent, signal: payload.signal,
            calls: [{ type: 'tool-call', id: `mcp-lifecycle-${randomUUID()}`, name, arguments: '{}' }] })
          const result = batch.results?.[0]?.result
          if (result?.isError !== false || result.value === undefined || batch.concluded === true) fail('initialization recovery failed')
          e = entries(payload.agent).find(other => other.group === e.group)
          if (!e) continue
          const text = contentToText(result.value.content ?? [], config.probe)
          if (!e.entry.loaded || e.entry.loaded.marker.digest !== hash(text)) fail('initialization context changed before admission')
          contexts.push(contextMessage(c.entry.name, text, e.entry.loaded.marker.id), ...(batch.additionalContexts ?? []))
        }
        if (e.entry.phase !== 'ready') contexts.push(contextMessage(c.entry.name,
          'Initialization is in progress. Complete this service workflow using its initialization tools and the supplied fixed history. Ordinary replies and unrelated tools are held until the server reports ready and complete context is admitted. Continue the user request afterward.'))
      }
      restrict(payload.agent)
      return { ...decision, messages: [...decision.messages, ...contexts] }
    } catch {
      logger.warn('MCP initialization blocked a step: ownership, recovery or persistence failed')
      if (payload.signal.aborted) return { kind: 'reject' }
      fail('initialization recovery failed; restore the connection and retry the same conversation')
    }
  }), 'mcp-connector: initialization admission')

  ctx.effect(() => ctx.on('llm/stream', (options, next) => (async function* () {
    const stored = typeof options.sessionId === 'string' ? table.get(hash(options.sessionId)) : undefined
    if (!stored || !Object.keys(stored.groups).length || options.purpose !== undefined) { yield* next(); return }
    const admitted = admissions.get(options.sessionId)
    // dsh returns a fresh array on every projection read; the frozen message
    // objects, rather than their array container, retain identity.
    const surface = admitted?.agent.session.deriveMessages()
    const sameSurface = Array.isArray(options.messages) && surface !== undefined
      && options.messages.length === surface.length && options.messages.every((m, i) => m === surface[i])
    if (!admitted || admitted.signal !== options.signal || admitted.agent.session.header.id !== stored.sessionId
      || admitted.agent.session.header.createdAt !== stored.createdAt || !sameSurface) fail('model request is not the admitted persistent conversation')
    const agent = admitted.agent, states = entries(agent)
    if (states.every(e => ready(e.entry, e.connection, agent))) { yield* next(); return }
    const unchanged = hash(states.map(e => e.entry))
    yield* initializationStream(next(), { signal: options.signal, maxBytes: Math.min(...states.map(e => e.config.maxBytes)),
      allows: name => states.every(e => permitted(e.connection, e.entry, agent, name)),
      validate: () => { if (hash(entries(agent).map(e => e.entry)) !== unchanged) fail('initialization changed during generation') },
    })
  })(), { prepend: true }), 'mcp-connector: initialization output gate')
}
