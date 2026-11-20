/**
 * dsh-mcp-connector — a general-purpose MCP connector for DeepSeek Harness.
 *
 * One plugin instance owns any number of MCP servers. Each server is one of:
 *
 * - `stdio` — a local child process;
 * - `streamable-http` (`http`) — the current HTTP transport;
 * - `sse` — the legacy HTTP+SSE transport.
 *
 * HTTP servers can authenticate with a static bearer token or with a full OAuth
 * 2.1 authorization-code flow (discovery, dynamic client registration, PKCE,
 * refresh, issuer binding) whose tokens are stored as a Host credential record.
 * Every discovered tool resolves to its own authorization policy — `allow`,
 * `ask`, `deny`, or `off` — enforced before dispatch through
 * `tools/pre-execute`.
 *
 * @module dsh-mcp-connector
 */

import { normalizeConfig } from './src/config.js'
import { ServerConnection } from './src/connection.js'
import { policyDecision } from './src/policy.js'
import { registerApi } from './src/api.js'
import { compactJson } from './src/json.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-connector'

/** Services required by this plugin. */
export const inject = ['tools']

/** Credential-record scope owned by this plugin. */
const SCOPE = 'mcp-connector'

/**
 * Build the plugin's logger from the ambient Cordis logger service.
 * @param ctx - plugin context.
 * @returns a logger with the four severity methods.
 */
function createLogger(ctx) {
  const service = ctx.logger
  const log = typeof service === 'function' ? service('mcp-connector') : service
  return {
    debug: (...args) => log.debug?.(...args),
    info: (...args) => log.info?.(...args),
    warn: (...args) => log.warn?.(...args),
    error: (...args) => log.error?.(...args),
  }
}

/** Resolve after `ms` without keeping the process alive. @param ms - delay. */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}

/**
 * Render a value as pretty JSON for the model.
 * @param value - JSON-serializable value.
 * @returns one text content block.
 */
function jsonContent(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build the management tool definitions bound to one connector.
 * @param options - `{ connections, find }`.
 * @returns the tool definitions.
 */
function managementTools({ connections, find }) {
  return [
    {
      name: 'mcp_connector_status',
      description:
        'Report every configured MCP server: transport, connection state, discovered tools with their per-tool authorization policy, '
        + 'pending authorization URL, and the last error. Use it before calling MCP tools or when a server looks disconnected.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { servers: { type: 'array', items: {} } },
          required: ['servers'],
          additionalProperties: false,
        },
        render: (_args, value) => jsonContent(value),
      },
      async execute() {
        return compactJson({ servers: connections.map(connection => connection.snapshot()) })
      },
    },
    {
      name: 'mcp_connector_authorize',
      description:
        'Start or resume OAuth for one MCP server. Returns the URL the user must open in a browser and, with waitSeconds, waits for '
        + 'the browser callback before returning. Use it when a server reports "authorizing" or "authorization required".',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Configured server name.' },
          waitSeconds: {
            type: 'number',
            description: 'Seconds to wait for the user to finish signing in (0 returns the URL immediately; at most 120).',
          },
        },
        required: ['server'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => jsonContent(value),
      },
      async execute(args) {
        const connection = find(args?.server)
        const waitSeconds = typeof args?.waitSeconds === 'number' ? Math.max(0, Math.min(120, args.waitSeconds)) : 0
        return connection.authorize({ waitMs: waitSeconds * 1000 })
      },
    },
    {
      name: 'mcp_connector_logout',
      description:
        'Forget the stored OAuth tokens for one MCP server and disconnect it. The next authorization starts a fresh sign-in.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'Configured server name.' } },
        required: ['server'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => jsonContent(value),
      },
      async execute(args) {
        const connection = find(args?.server)
        return connection.logout()
      },
    },
    {
      name: 'mcp_connector_reconnect',
      description:
        'Reconnect one MCP server now and reset its retry budget. Use it after fixing a server, or when a server gave up reconnecting.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'Configured server name.' } },
        required: ['server'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => jsonContent(value),
      },
      async execute(args) {
        const connection = find(args?.server)
        const result = await connection.reconnect()
        return compactJson({ server: connection.entry.name, ...result, toolCount: connection.tools.size })
      },
    },
  ]
}

/**
 * Mount the connector: one supervised connection per configured server, the
 * per-tool policy gate, and the management tools.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - the Loader row's configuration.
 * @returns startup readiness after the first connection round settles.
 */
export async function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  const credentials = ctx.get('credentials')
  const log = createLogger(ctx)

  const connections = normalized.servers.map(entry => new ServerConnection({
    ctx,
    entry,
    credentials,
    scope: SCOPE,
    logger: log,
  }))

  /** Look up one configured connection by name. @param serverName - server key. */
  const find = (serverName) => {
    if (typeof serverName !== 'string' || serverName === '') {
      throw new Error(`a server name is required; configured servers: ${connections.map(c => c.entry.name).join(', ') || '(none)'}`)
    }
    const connection = connections.find(candidate => candidate.entry.name === serverName)
    if (connection === undefined) {
      throw new Error(
        `unknown MCP server "${serverName}"; configured servers: ${connections.map(c => c.entry.name).join(', ') || '(none)'}`,
      )
    }
    return connection
  }

  ctx.effect(() => async () => {
    for (const dispose of scopeRestrictions.values()) {
      try { dispose() } catch { /* the agent scope may already be gone */ }
    }
    scopeRestrictions.clear()
    await Promise.allSettled(connections.map(connection => connection.dispose()))
  }, 'mcp-connector: server connections')

  // ---- Workspace scope -------------------------------------------------
  // A server scoped to workspaces keeps its tools registered globally and hides
  // them from every agent whose session runs elsewhere; the scope is the set of
  // workspace directories the user selected.
  const agents = ctx.get('agents')
  const workingDirectory = ctx.get('workingDirectory')
  /** @type {Map<string, () => void>} agent id to its live restriction. */
  const scopeRestrictions = new Map()

  /**
   * The directory an agent's session runs in.
   * @param agent - live agent.
   * @returns the absolute directory, or undefined when unknown.
   */
  const sessionDirectory = (agent) => {
    try {
      const directory = workingDirectory?.get?.(agent.session)
      if (typeof directory === 'string' && directory !== '') return directory
    } catch { /* fall back to the session header */ }
    const header = agent.session?.header
    return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
  }

  /**
   * Whether one server is visible to a session in this directory.
   * @param connection - the server.
   * @param directory - the session's directory.
   * @returns true when the server applies there.
   */
  const scopeAllows = (connection, directory) => {
    const scope = connection.entry.scope
    if (scope.mode === 'global') return true
    if (typeof directory !== 'string' || directory === '') return false
    const normalized = directory.replace(/[\\/]+$/, '') || directory
    return scope.paths.includes(normalized)
  }

  /**
   * Recompute one agent's hidden tool set.
   * @param agent - live agent.
   */
  const applyAgentScope = (agent) => {
    if (agent?.ctx === undefined || agent?.session === undefined) return
    const directory = sessionDirectory(agent)
    const denied = []
    for (const connection of connections) {
      if (scopeAllows(connection, directory)) continue
      denied.push(...connection.toolNames)
    }
    const previous = scopeRestrictions.get(agent.id)
    if (previous !== undefined) {
      try { previous() } catch { /* scope already disposed */ }
      scopeRestrictions.delete(agent.id)
    }
    if (denied.length === 0) return
    try {
      scopeRestrictions.set(agent.id, agent.ctx.tools.restrict({ deny: denied }))
    } catch (error) {
      log.warn(`could not apply a workspace scope to session ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Recompute every live agent's scope. */
  const applyAgentScopes = () => {
    for (const agent of agents?.list?.() ?? []) applyAgentScope(agent)
  }

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    applyAgentScope(agent)
  }), 'mcp-connector: workspace scope')

  for (const connection of connections) connection.onToolsChanged = applyAgentScopes

  // Per-tool authorization: a policy match short-circuits with ask/deny; an
  // allow result delegates so other plugins' gates still run.
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    for (const connection of connections) {
      const policy = connection.policies.get(exec.name)
      if (policy === undefined) continue
      const decision = policyDecision(policy, exec.name)
      return decision === undefined ? next() : decision
    }
    return next()
  }, { prepend: true }), 'mcp-connector: per-tool policy')

  for (const definition of managementTools({ connections, find })) {
    ctx.effect(() => ctx.tools.register(definition), `mcp-connector: ${definition.name}`)
  }

  // Host half of the browser configuration panel (Settings → MCP connector).
  registerApi(ctx, { rawConfig: config ?? {}, connections, find, logger: log })

  if (connections.length === 0) {
    log.info('no MCP servers configured; add them under "servers" in this plugin\'s config')
    return
  }
  log.info(`connecting ${connections.length} MCP server(s): ${connections.map(c => c.entry.name).join(', ')}`)

  await Promise.all(connections.map(async (connection) => {
    if (!connection.entry.enabled) return
    const started = connection.start()
    // Never let one unreachable server hold plugin activation forever; the
    // attempt continues in the background and publishes its status.
    const timedOut = delay(connection.entry.startupTimeoutMs + 5_000).then(() => 'timeout')
    const outcome = await Promise.race([started.then(() => 'settled'), timedOut])
    if (outcome === 'timeout') {
      log.warn(`server "${connection.entry.name}" is still starting; continuing without waiting for it`)
    }
  }))

  applyAgentScopes()

  if (normalized.failOnStartupError) {
    const failed = connections.find(connection => connection.startupError !== undefined)
    if (failed !== undefined) {
      throw new Error(
        `mcp-connector: server "${failed.entry.name}" failed to start: ${failed.status.lastError ?? String(failed.startupError)}`,
        { cause: failed.startupError },
      )
    }
  }
}