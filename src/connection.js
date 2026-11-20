/**
 * Connection supervision for one configured MCP server.
 *
 * Each server owns one generation at a time: a transport, a client, and the
 * tools registered from that client's listing. A failed attempt is replaced on
 * the configured backoff schedule; a server that needs a human keeps the
 * generation empty and waits in `authorizing` instead of burning retries. Tool
 * names stay stable across reconnects, so history and permission rules survive.
 *
 * @module dsh-mcp-connector/connection
 */

import { Client, UnauthorizedError } from '@modelcontextprotocol/client'
import { createTransport } from './transport.js'
import { createToolDefinition } from './tools.js'
import { publicToolName } from './naming.js'
import { resolveToolPolicy } from './policy.js'
import { expandServerTemplates } from './templates.js'
import { OAuthFlow } from './oauth/flow.js'
import { compactJson } from './json.js'

/** How long a pending authorization URL is reused by repeated calls (10 minutes). */
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000

/** Identity this connector announces in the MCP `initialize` handshake. */
const CLIENT_INFO = Object.freeze({ name: 'dsh-mcp-connector', version: '0.1.0' })

/**
 * Whether one error means "this request needs user authorization".
 * @param error - the thrown value.
 * @returns true for the SDK's UnauthorizedError brand.
 */
function isUnauthorized(error) {
  return error instanceof UnauthorizedError
    || (typeof error === 'object' && error !== null && error.name === 'UnauthorizedError')
}

/**
 * Human-readable text for any thrown value.
 * @param error - the thrown value.
 * @returns the diagnostic text.
 */
export function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Wait for a fixed delay. @param ms - milliseconds. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}

/**
 * Bound one cleanup promise so an unresponsive transport cannot block unload.
 * @param promise - cleanup operation.
 * @param ms - budget in milliseconds.
 * @returns a promise that settles either way.
 */
function bounded(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    sleep(ms),
  ])
}

/**
 * One supervised MCP server.
 */
export class ServerConnection {
  /**
   * @param options - `{ ctx, entry, credentials, scope, logger }`.
   */
  constructor({ ctx, entry, credentials, scope, logger }) {
    this.ctx = ctx
    this.entry = entry
    this.credentials = credentials
    this.scope = scope
    this.logger = logger
    this.status = {
      state: entry.enabled ? 'idle' : 'disabled',
      toolCount: 0,
      connectedAt: undefined,
      lastError: undefined,
      authorizationUrl: undefined,
      serverVersion: undefined,
      nextRetryAt: undefined,
    }
    /** @type {Map<string, { dispose: () => void, policy: string, rawName: string }>} */
    this.tools = new Map()
    /** @type {Map<string, string>} public tool name to policy. */
    this.policies = new Map()
    /** Notified after the registered tool set changes, so scopes can re-apply. */
    this.onToolsChanged = undefined
    this.instructions = ''
    this.client = undefined
    this.transport = undefined
    this.flow = undefined
    this.redact = text => String(text)
    this.attempt = 0
    this.generation = 0
    /** When the current authorization URL was produced, for reuse within a window. */
    this.pendingSince = undefined
    this.reconnectTimer = undefined
    this.inflight = undefined
    /** First failure of the initial attempt, surfaced when failOnStartupError is set. */
    this.startupError = undefined
    this.disposed = false
    this.lifecycle = new AbortController()
  }

  /** @returns the public name of every tool this server currently registers. */
  get toolNames() {
    return [...this.tools.keys()]
  }

  /**
   * Connect once; a needed authorization leaves the server in `authorizing`.
   * @returns nothing when the attempt settled (connected or waiting).
   */
  async start() {
    if (!this.entry.enabled) return
    await this.#connect('startup')
  }

  /**
   * Prepare the OAuth flow and template-expanded entry (idempotent).
   * @returns the expanded entry.
   */
  async #prepare() {
    // Re-expand on every attempt so a rotated credential applies without a
    // configuration edit; the OAuth flow itself keeps its first registration.
    const expanded = await expandServerTemplates(this.entry, { credentials: this.credentials })
    this.redact = expanded.redact
    if (this.entry.auth.type === 'oauth' && this.flow === undefined) {
      if (this.credentials === undefined) {
        throw new Error(`server "${this.entry.name}" uses OAuth, but this profile does not mount the credentials service`)
      }
      this.flow = new OAuthFlow({
        entry: expanded.entry,
        credentials: this.credentials,
        scope: this.scope,
        logger: this.logger,
      })
      this.flow.onAuthorized = async () => {
        if (this.disposed) return
        this.logger.info(`server "${this.entry.name}": authorization received, reconnecting`)
        await this.reconnect()
      }
      this.flow.onAuthorizationFailed = () => {
        this.status.authorizationUrl = undefined
        this.pendingSince = undefined
      }
    }
    return expanded.entry
  }

  /**
   * Run one connection attempt, serialized per server.
   * @param mode - `'startup'`, `'reconnect'`, or `'manual'`.
   */
  async #connect(mode) {
    if (this.disposed) return
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.#attempt(mode).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  /**
   * One attempt: authorize, connect, discover, register.
   * @param mode - attempt origin, which changes the failure policy.
   */
  async #attempt(mode) {
    if (this.disposed) return
    this.#clearTimer()
    this.status.state = 'connecting'
    this.status.nextRetryAt = undefined
    const generation = ++this.generation
    const stale = () => this.disposed || generation !== this.generation
    try {
      const entry = await this.#prepare()
      if (this.entry.auth.type === 'oauth') {
        // The loopback listener must exist before any request can redirect, but
        // authorization itself starts only after the server answers 401: the
        // challenge carries the resource-metadata URL many servers rely on for
        // discovery, so authorizing before connecting dead-ends on servers that
        // publish no well-known metadata.
        await this.flow.ready()
      }
      this.status.authorizationUrl = undefined
      const transport = createTransport(entry, { provider: this.flow?.provider })
      const client = new Client(CLIENT_INFO, {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => { void this.#onToolListChanged(client) },
          },
        },
      })
      // Install the drop handler before connecting so a close during the
      // handshake cannot leave the server marked connected forever.
      client.onclose = () => {
        if (stale() || this.client !== client) return
        this.logger.warn(`server "${this.entry.name}": connection closed`)
        this.instructions = ''
        this.client = undefined
        this.transport = undefined
        this.status.state = 'reconnecting'
        this.#scheduleReconnect()
      }
      client.onerror = error => {
        this.logger.warn(`server "${this.entry.name}": ${this.redact(describeError(error))}`)
      }
      try {
        await client.connect(transport, {
          timeout: this.entry.startupTimeoutMs,
          signal: AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(this.entry.startupTimeoutMs)]),
        })
      } catch (error) {
        await bounded(transport.close(), this.entry.closeTimeoutMs)
        throw error
      }
      if (stale()) {
        await bounded(client.close(), this.entry.closeTimeoutMs)
        return
      }
      this.client = client
      this.transport = transport
      const rawInstructions = client.getInstructions?.()?.trimEnd() ?? ''
      const instructions = rawInstructions ? `### MCP server: ${this.entry.name}\n\n${rawInstructions}` : ''
      if (Buffer.byteLength(instructions, 'utf8') > 32768) {
        throw new Error('MCP server instructions exceed the 32768-byte limit')
      }
      await this.#sync(client)
      if (stale() || this.client !== client) {
        this.#unregisterTools()
        await bounded(client.close(), this.entry.closeTimeoutMs)
        return
      }
      this.attempt = 0
      this.instructions = instructions
      this.status.state = 'connected'
      this.status.toolCount = this.tools.size
      this.status.connectedAt = Date.now()
      this.status.lastError = undefined
      this.status.reason = undefined
      this.pendingSince = undefined
      const identity = client.getServerVersion?.()
      this.status.serverVersion = identity === undefined ? undefined : `${identity.name} ${identity.version}`
      this.logger.info(
        `server "${this.entry.name}" connected (${this.tools.size} tool${this.tools.size === 1 ? '' : 's'})`,
      )
    } catch (error) {
      const connected = this.client
      const transport = this.transport
      this.instructions = ''
      this.client = undefined
      this.transport = undefined
      if (connected !== undefined) await bounded(connected.close(), this.entry.closeTimeoutMs)
      if (transport !== undefined) await bounded(transport.close(), this.entry.closeTimeoutMs)
      if (stale()) return
      if (isUnauthorized(error) && this.flow !== undefined) {
        if (this.flow.authorizationUrl === undefined) {
          // The transport usually starts the authorization itself; when it did
          // not, start it here so the user still gets a link.
          try {
            const authorization = await this.flow.authorize({ signal: this.lifecycle.signal })
            if (authorization.status === 'redirect') this.flow.authorizationUrl = authorization.url
          } catch (discoveryError) {
            this.status.lastError = `sign-in could not start: ${this.redact(describeError(discoveryError))}`
          }
        }
        this.status.state = 'authorizing'
        this.status.authorizationUrl = this.flow.authorizationUrl
        this.status.lastError = this.flow.authorizationUrl === undefined
          ? (this.status.lastError ?? 'authorization required')
          : `authorization required: open ${this.flow.authorizationUrl}`
        this.pendingSince ??= Date.now()
        return
      }
      const message = this.redact(describeError(error))
      this.status.lastError = message
      this.startupError ??= error
      this.logger.warn(`server "${this.entry.name}" ${mode === 'startup' ? 'failed to start' : 'connection failed'}: ${message}`)
      this.#scheduleReconnect()
    }
  }

  /** Schedule the next attempt, or stop and withdraw tools when the budget is spent. */
  #scheduleReconnect() {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const policy = this.entry.reconnect
    if (!policy.enabled) {
      this.status.state = 'failed'
      this.status.reason = 'reconnect-disabled'
      this.#unregisterTools()
      return
    }
    if (this.attempt >= policy.maxAttempts) {
      this.status.state = 'failed'
      this.status.reason = 'gave-up'
      this.status.lastError = `${this.status.lastError ?? 'connection lost'} (gave up after ${policy.maxAttempts} attempts)`
      this.logger.warn(
        `server "${this.entry.name}": giving up after ${policy.maxAttempts} reconnect attempts; its tools are withdrawn`,
      )
      this.#unregisterTools()
      return
    }
    this.attempt += 1
    const delay = Math.min(policy.initialDelayMs * (2 ** (this.attempt - 1)), policy.maxDelayMs)
    this.status.state = 'reconnecting'
    this.status.nextRetryAt = Date.now() + delay
    this.#clearTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.#connect('reconnect')
    }, delay)
    this.reconnectTimer.unref?.()
  }

  /**
   * Re-list tools after the server announced a change.
   * @param client - the generation that announced it.
   */
  async #onToolListChanged(client) {
    if (this.disposed || this.client !== client) return
    try {
      await this.#resync(client)
    } catch (error) {
      this.logger.warn(`server "${this.entry.name}": tool re-sync failed: ${this.redact(describeError(error))}`)
    }
  }

  /** Cancel a pending reconnect timer. */
  #clearTimer() {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  /**
   * Re-read the tool list and swap the registered generation.
   * @param client - the connected client to list from.
   */
  async #resync(client) {
    if (this.client !== client) return
    await this.#sync(client)
    this.status.toolCount = this.tools.size
    this.logger.info(`server "${this.entry.name}": tool list refreshed (${this.tools.size} tools)`)
  }

  /**
   * Fetch and register one tool generation.
   * @param client - the connected client.
   */
  async #sync(client) {
    const capabilities = client.getServerCapabilities?.()
    const response = capabilities?.tools === undefined
      ? { tools: [] }
      : await client.listTools(undefined, { cacheMode: 'refresh', signal: this.lifecycle.signal })
    const next = new Map()
    for (const tool of response.tools ?? []) {
      const publicName = publicToolName(this.entry.name, tool.name)
      if (next.has(publicName)) {
        throw new Error(`the server listed tool "${tool.name}" more than once — invalid tool list`)
      }
      const policy = resolveToolPolicy(this.entry.tools, tool.name, publicName)
      if (policy === 'off') continue
      next.set(publicName, { tool, policy })
    }

    this.#unregisterTools()
    const registered = []
    try {
      for (const [publicName, { tool, policy }] of next) {
        const definition = createToolDefinition({
          publicName,
          rawName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          redact: text => this.redact(text),
          call: async (args, exec) => {
            const connected = this.client
            if (connected === undefined) {
              throw new Error(`MCP server "${this.entry.name}" is not connected; retrying in the background`)
            }
            if (this.runtimeMeta !== undefined && Object.hasOwn(args, '_meta')) throw new Error('MCP runtime metadata cannot be supplied by tool arguments')
            const call = (arguments_, metadata) => connected.callTool(
              { name: tool.name, arguments: arguments_, ...(metadata === undefined ? {} : { _meta: metadata }) },
              {
                timeout: this.entry.toolCallTimeoutMs,
                signal: AbortSignal.any([exec.signal, this.lifecycle.signal]),
              },
            )
            const invoke = arguments_ => this.runtimeCall === undefined ? call(arguments_)
              : this.runtimeCall(tool.name, arguments_, exec, call)
            return this.contextCall === undefined ? invoke(args) : this.contextCall(tool.name, args, exec, invoke)
          },
        })
        const dispose = this.ctx.tools.register(definition)
        registered.push([publicName, { dispose, policy, rawName: tool.name }])
      }
    } catch (error) {
      for (const [, record] of registered) record.dispose()
      throw error
    }
    for (const [publicName, record] of registered) {
      this.tools.set(publicName, record)
      this.policies.set(publicName, record.policy)
    }
    this.onToolsChanged?.()
  }

  /** Unregister every tool this generation owns. */
  #unregisterTools() {
    for (const record of this.tools.values()) record.dispose()
    this.tools.clear()
    this.policies.clear()
  }

  /**
   * Reconnect now, resetting the attempt budget.
   * @returns `{ state, authorizationUrl }` after the attempt.
   */
  async reconnect() {
    if (this.disposed) return { state: 'disposed' }
    this.attempt = 0
    this.#clearTimer()
    const client = this.client
    const transport = this.transport
    this.instructions = ''
    this.client = undefined
    this.transport = undefined
    if (client !== undefined) await bounded(client.close(), this.entry.closeTimeoutMs)
    if (transport !== undefined) await bounded(transport.close(), this.entry.closeTimeoutMs)
    await this.#connect('manual')
    return { state: this.status.state, authorizationUrl: this.status.authorizationUrl }
  }

  /**
   * Start or resume the interactive authorization and optionally wait for it.
   * @param options - `{ waitMs }` upper bound on waiting for the browser callback.
   * @returns the status snapshot after the call.
   */
  async authorize({ waitMs = 0 } = {}) {
    if (this.entry.auth.type !== 'oauth') {
      throw new Error(`server "${this.entry.name}" does not use OAuth; it authenticates with ${this.entry.auth.type}`)
    }
    if (this.entry.url === undefined) throw new Error(`server "${this.entry.name}" has no URL`)
    if (this.status.state === 'connected') {
      return { ...this.snapshot(), alreadyAuthorized: true }
    }
    const pending = this.status.authorizationUrl
    const pendingFresh = pending !== undefined && this.pendingSince !== undefined && Date.now() - this.pendingSince < PENDING_AUTHORIZATION_TTL_MS
    if (!pendingFresh) {
      // A repeated call reuses a fresh pending URL: starting over would
      // invalidate the link the user may already have open.
      await this.#prepare()
      const result = await this.flow.authorize({ signal: this.lifecycle.signal })
      if (result.status === 'redirect') {
        this.status.state = 'authorizing'
        this.status.authorizationUrl = result.url
        this.status.lastError = `authorization required: open ${result.url}`
        this.pendingSince = Date.now()
      }
    }
    if (waitMs > 0) {
      const deadline = Date.now() + Math.min(waitMs, 120_000)
      while (Date.now() < deadline) {
        if (this.status.state === 'connected') break
        await sleep(250)
      }
    }
    return this.snapshot()
  }

  /**
   * Forget stored OAuth tokens and disconnect.
   * @returns the status snapshot.
   */
  async logout() {
    if (this.flow === undefined) {
      throw new Error(`server "${this.entry.name}" does not use OAuth`)
    }
    await this.flow.logout()
    await this.#disconnect()
    this.status.state = 'idle'
    this.status.authorizationUrl = undefined
    this.status.lastError = undefined
    this.status.toolCount = 0
    this.status.connectedAt = undefined
    this.pendingSince = undefined
    this.#unregisterTools()
    return this.snapshot()
  }

  /** Close the live generation without scheduling a reconnect. */
  async #disconnect() {
    this.#clearTimer()
    this.generation += 1
    const client = this.client
    const transport = this.transport
    this.instructions = ''
    this.client = undefined
    this.transport = undefined
    if (client !== undefined) await bounded(client.close(), this.entry.closeTimeoutMs)
    if (transport !== undefined) await bounded(transport.close(), this.entry.closeTimeoutMs)
  }

  /**
   * Current status for diagnostics and the management tools.
   * @returns a JSON-serializable snapshot.
   */
  snapshot() {
    return compactJson({
      name: this.entry.name,
      transport: this.entry.transport,
      auth: this.entry.auth.type,
      enabled: this.entry.enabled,
      state: this.status.state,
      reason: this.status.reason,
      toolCount: this.tools.size,
      connectedAt: this.status.connectedAt,
      lastError: this.status.lastError,
      authorizationUrl: this.status.authorizationUrl,
      nextRetryAt: this.status.nextRetryAt,
      serverVersion: this.status.serverVersion,
      ...(this.entry.turnContext === undefined ? {} : { turnContext: {
        mode: 'after-first-call', tool: this.entry.turnContext.tool, failure: 'block-step',
      } }),
      tools: [...this.tools.entries()].map(([name, record]) => ({
        name,
        remoteName: record.rawName,
        policy: record.policy,
      })),
    })
  }

  /** Stop reconnecting, close the transport, and unregister every tool. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.abort(new Error('mcp-connector: server disposed'))
    this.#clearTimer()
    this.#unregisterTools()
    const client = this.client
    const transport = this.transport
    this.instructions = ''
    this.client = undefined
    this.transport = undefined
    if (client !== undefined) await bounded(client.close(), this.entry.closeTimeoutMs)
    if (transport !== undefined) await bounded(transport.close(), this.entry.closeTimeoutMs)
    await this.flow?.dispose()
    this.status.state = 'disposed'
  }
}
