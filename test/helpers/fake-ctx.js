/**
 * A minimal fake Cordis context for exercising the plugin outside the Harness.
 *
 * It implements exactly the surface the connector uses: `logger`, `get`,
 * `effect`, `on('tools/pre-execute')`, and `tools.register`. Everything is
 * inspectable, so tests can assert on registrations and dispatches.
 */

/**
 * Create one fake context.
 * @param options - `{ services }` provides `ctx.get(name)` lookups.
 * @returns the context plus inspection helpers.
 */
export function createFakeContext({ services = {} } = {}) {
  /** @type {Map<string, any>} */
  const tools = new Map()
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const effects = []
  const sections = new Map()
  const debug = process.env.DSH_MCP_CONNECTOR_DEBUG === '1'
  const log = (...args) => {
    if (debug) console.log('[ctx]', ...args)
  }
  const logger = Object.assign((name) => {
    const scoped = (...args) => log(`[${name}]`, ...args)
    return Object.assign(scoped, { info: scoped, warn: scoped, error: scoped, debug: scoped })
  }, { info: log, warn: log, error: log, debug: log })

  const ctx = {
    logger,
    inject(_names, callback) { return callback(ctx) },
    systemPrompt: {
      getSectionOrder() { return 0 },
      section(section) {
        sections.set(section.name, section)
        return () => sections.delete(section.name)
      },
    },
    get: (name) => services[name],
    effect(fn, label) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      effects.push({ label, disposer })
      return () => {}
    },
    on(event, listener, options) {
      const list = listeners.get(event) ?? []
      if (options?.prepend === true) list.unshift(listener)
      else list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index !== -1) current.splice(index, 1)
      }
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool "${definition.name}"`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }

  /**
   * Run one tool body the way the executor would.
   * @param name - registered tool name.
   * @param args - model arguments.
   * @returns the canonical value.
   */
  async function callTool(name, args = {}, agent) {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`no such tool "${name}"`)
    return definition.execute(args, {
      callId: 'call-1',
      name,
      arguments: args,
      agent,
      signal: AbortSignal.timeout(10_000),
    })
  }

  /**
   * Run the `tools/pre-execute` waterfall for one call.
   * @param name - tool name.
   * @param args - model arguments.
   * @returns the resolved decision.
   */
  async function preExecute(name, args = {}, agent) {
    const list = [...(listeners.get('tools/pre-execute') ?? [])]
    const exec = {
      callId: 'call-1',
      name,
      arguments: args,
      agent,
      signal: AbortSignal.timeout(10_000),
    }
    let index = 0
    const next = async () => {
      const listener = list[index++]
      if (listener === undefined) return { kind: 'allow' }
      return listener(exec, next)
    }
    return next()
  }

  /** Dispose every effect, as plugin unload does. */
  async function dispose() {
    for (const effect of effects.reverse()) {
      if (typeof effect.disposer === 'function') await effect.disposer()
    }
  }

  return { ctx, tools, listeners, effects, sections, callTool, preExecute, dispose }
}

/** Reject values the real credential store cannot persist. */
function assertJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number in credential record')
    return
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('cyclic credential record')
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) assertJsonValue(nested, seen)
      seen.delete(value)
      return
    }
  }
  throw new TypeError('credential record holds a value JSON cannot represent')
}

/**
 * Create an in-memory credentials service plus writable references.
 * @param options - `{ values, records }` initial contents.
 * @returns the service and its backing maps.
 */
export function createCredentialStore({ values = {}, records = {} } = {}) {
  const references = new Map(Object.entries(values))
  const stored = new Map(Object.entries(records))
  return {
    references,
    records: stored,
    async resolve(ref) {
      const value = references.get(ref)
      return value === undefined ? undefined : { value, source: 'test' }
    },
    async readRecord(key) {
      return stored.get(key)
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(stored.get(key))
      // Mirror credentials-local: a record must survive a lossless JSON round
      // trip, so undefined members and class instances are rejected.
      if (next !== undefined) {
        assertJsonValue(next)
        stored.set(key, next)
      }
      return next
    },
    async deleteRecord(key) {
      stored.delete(key)
    },
  }
}

/**
 * Poll until a predicate holds.
 * @param fn - checked every interval.
 * @param options - `{ timeoutMs, intervalMs, what }`.
 * @returns the truthy value.
 */
export async function waitFor(fn, { timeoutMs = 8_000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting for ${what}`)
}
/**
 * Create a fake Host web carrier plus a trust-fenced connection service.
 * @param options - `{ authenticated }`.
 * @returns route lookup and the two services.
 */
export function createWebHarness({ authenticated = true } = {}) {
  const routes = new Map()
  const webServer = {
    protocol: 'http:',
    host: '127.0.0.1:3080',
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const connection = {
    requestRejection: request => (authenticated && request.headers?.authorization === 'Bearer test' ? undefined : 401),
  }
  return { routes, webServer, connection }
}

/**
 * Invoke one registered route with a synthetic request.
 * @param route - the registered route.
 * @param options - `{ method, body, headers }`.
 * @returns `{ status, headers, body }` with a parsed JSON body when possible.
 */
export async function invokeRoute(route, { method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    headers: { authorization: 'Bearer test', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
    resume() {},
  }
  const chunks = []
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)) },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed
  try { parsed = text === '' ? undefined : JSON.parse(text) } catch { parsed = text }
  return { status: res.statusCode, headers: res.headers, body: parsed }
}
