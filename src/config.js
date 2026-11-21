/**
 * Configuration normalization and validation.
 *
 * Validation is deliberately strict: an unknown key is a typo that would
 * otherwise silently disable a setting, so it fails at plugin load with the
 * exact configuration path. Defaults are applied here so the rest of the plugin
 * never has to ask whether a field is present.
 *
 * @module dsh-mcp-connector/config
 */

import { compileToolPolicy } from './policy.js'
import { normalizeRecoveries } from './recovery-config.js'

/** Valid server namespace; kept below the public tool-name budget. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Template forms resolved at connect time. */
export const TEMPLATE_PATTERN = /\$\{(credential|env):([A-Za-z_][A-Za-z0-9_]*)\}/g

/** A configuration error that names the offending path. */
export class McpConnectorConfigError extends Error {
  /** @param message - human-readable, path-qualified explanation. */
  constructor(message) {
    super(message)
    this.name = 'McpConnectorConfigError'
  }
}

const GLOBAL_KEYS = new Set(['servers', 'failOnStartupError', 'openBrowser', 'recoveries'])
const SERVER_KEYS = new Set([
  'transport', 'enabled', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'auth',
  'toolCallTimeoutMs', 'startupTimeoutMs', 'closeTimeoutMs', 'reconnect', 'tools', 'scope', 'delegation', 'turnContext', 'runtimeMetadata', 'lifecycle', 'capabilityProfile',
])
const AUTH_KEYS = new Set([
  'type', 'token', 'scopes', 'clientId', 'clientSecret', 'clientName', 'callbackPort',
  'resource', 'openBrowser', 'skipIssuerMetadataValidation',
])
const RECONNECT_KEYS = new Set(['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'])
const SCOPE_KEYS = new Set(['mode', 'paths'])
const TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse'])

function normalizeLifecycle(value, where, server) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpConnectorConfigError(`${where} must be an object`)
  onlyKeys(value, new Set(['group', 'startTools', 'allowedTools', 'localTools', 'blockedTools', 'requireCreationAdmission', 'ready', 'probe', 'maxBytes']), where)
  if (!server.runtimeMetadata || !server.turnContext?.delivery || server.delegation !== 'deny') throw new McpConnectorConfigError(`${where} requires runtimeMetadata, turnContext.delivery and delegation: deny`)
  const group = requireString(value.group, `${where}.group`)
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(group)) throw new McpConnectorConfigError(`${where}.group must be a bounded identifier`)
  const names = key => {
    const list = value[key] ?? []
    if (!Array.isArray(list) || list.length > 32 || list.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(n)) || new Set(list).size !== list.length) throw new McpConnectorConfigError(`${where}.${key} must be unique tool names`)
    return [...list]
  }
  const startTools = names('startTools'), allowedTools = names('allowedTools'), localTools = names('localTools'), blockedTools = names('blockedTools')
  if (value.requireCreationAdmission !== undefined && typeof value.requireCreationAdmission !== 'boolean') throw new McpConnectorConfigError(`${where}.requireCreationAdmission must be a boolean`)
  const ready = value.ready, probe = requireString(value.probe, `${where}.probe`)
  if (!startTools.length || startTools.some(t => !server.runtimeMetadata.captureTools.includes(t))) throw new McpConnectorConfigError(`${where}.startTools must be explicit history capture tools`)
  if (!server.runtimeMetadata.captureTools.includes(probe)) throw new McpConnectorConfigError(`${where}.probe must be an explicit history capture tool to recover an uncertain activation`)
  if (!ready || typeof ready !== 'object' || Array.isArray(ready) || Object.keys(ready).length > 32 || [...startTools, probe].some(t => !Object.hasOwn(ready, t))) throw new McpConnectorConfigError(`${where}.ready must map start and probe tools to readiness pointers`)
  for (const [name, pointer] of Object.entries(ready)) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name) || typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 512 || /~(?![01])/.test(pointer) || pointer.split('/').some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw new McpConnectorConfigError(`${where}.ready contains an invalid tool or JSON pointer`)
    if (![...startTools, probe, ...allowedTools].includes(name)) throw new McpConnectorConfigError(`${where}.ready tool must be allowed during initialization`)
  }
  if (localTools.some(t => t !== 'mcp_connector_history')) throw new McpConnectorConfigError(`${where}.localTools supports only the scoped connector history reader`)
  return { group, startTools, allowedTools, localTools, ...(blockedTools.length ? { blockedTools } : {}), ...(value.requireCreationAdmission === true ? { requireCreationAdmission: true } : {}), ready: { ...ready }, probe,
    maxBytes: value.maxBytes === undefined ? 1048576 : requireNumber(value.maxBytes, `${where}.maxBytes`, { min: 1024, max: 4194304, integer: true }) }
}

function normalizeRuntimeMetadata(value, where) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpConnectorConfigError(`${where} must be an object`)
  onlyKeys(value, new Set(['namespace', 'historyTools', 'captureTools', 'captureRollback']), where)
  const namespace = requireString(value.namespace, `${where}.namespace`)
  if (namespace.length > 200 || !/^[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+$/.test(namespace) || namespace.startsWith('io.modelcontextprotocol/')) throw new McpConnectorConfigError(`${where}.namespace must be a non-reserved namespaced metadata key`)
  const names = key => {
    const list = value[key] ?? []
    if (!Array.isArray(list) || list.length > 16 || list.some(v => typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(v)) || new Set(list).size !== list.length) throw new McpConnectorConfigError(`${where}.${key} must list at most 16 unique tool names`)
    return [...list]
  }
  const historyTools = names('historyTools'), captureTools = names('captureTools')
  if (historyTools.length && !captureTools.length) throw new McpConnectorConfigError(`${where}.captureTools is required for frozen history`)
  let captureRollback
  if (value.captureRollback !== undefined) {
    const r = value.captureRollback
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new McpConnectorConfigError(`${where}.captureRollback must be an object`)
    onlyKeys(r, new Set(['pointer', 'value']), `${where}.captureRollback`)
    const pointer = requireString(r.pointer, `${where}.captureRollback.pointer`)
    if (!pointer.startsWith('/') || pointer.length > 512 || /~(?![01])/.test(pointer) || pointer.split('/').some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) throw new McpConnectorConfigError(`${where}.captureRollback.pointer must be a safe non-root JSON pointer`)
    if (!(r.value === null || typeof r.value === 'boolean' || typeof r.value === 'string' && r.value.length <= 4096 || typeof r.value === 'number' && Number.isFinite(r.value))) throw new McpConnectorConfigError(`${where}.captureRollback.value must be a bounded scalar`)
    if (!captureTools.length) throw new McpConnectorConfigError(`${where}.captureRollback requires captureTools`)
    captureRollback = { pointer, value: r.value }
  }
  return { namespace, historyTools, captureTools, ...(captureRollback === undefined ? {} : { captureRollback }) }
}

/** Validate the opt-in generic context tool and structured state mappings. */
function normalizeTurnContext(value, where) {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new McpConnectorConfigError(`${where} must be an object`)
  onlyKeys(value, new Set(['tool', 'arguments', 'state', 'pins', 'maxBytes', 'pagination', 'delivery']), where)
  const pointer = (v, path) => {
    requireString(v, path)
    if (!v.startsWith('/') || v.length > 512 || /~(?![01])/.test(v)
      || v.split('/').some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) {
      throw new McpConnectorConfigError(`${path} must be a safe non-root JSON pointer`)
    }
    return v
  }
  const state = value.state ?? {}
  if (typeof state !== 'object' || state === null || Array.isArray(state) || Object.keys(state).length > 16) throw new McpConnectorConfigError(`${where}.state must map at most 16 argument names to JSON pointers`)
  for (const [key, path] of Object.entries(state)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype'].includes(key)) throw new McpConnectorConfigError(`${where}.state has an invalid argument name`)
    pointer(path, `${where}.state.${key}`)
  }
  const pins = value.pins ?? []
  if (!Array.isArray(pins) || pins.length > 16) throw new McpConnectorConfigError(`${where}.pins must contain at most 16 JSON pointers`)
  pins.forEach((p, i) => pointer(p, `${where}.pins[${i}]`))
  const args = value.arguments ?? {}
  if (typeof args !== 'object' || args === null || Array.isArray(args)
    || Object.keys(args).some(k => ['__proto__', 'constructor', 'prototype'].includes(k) || Object.hasOwn(state, k))
    || Object.values(args).some(v => !(v === null || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 4096) || (typeof v === 'number' && Number.isFinite(v))))
    || Object.keys(args).length > 32) throw new McpConnectorConfigError(`${where}.arguments must contain bounded scalar values and cannot override managed state`)
  let pagination, delivery
  if (value.pagination !== undefined) {
    const p = value.pagination
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new McpConnectorConfigError(`${where}.pagination must be an object`)
    onlyKeys(p, new Set(['complete', 'maxPages']), `${where}.pagination`)
    if (!Object.keys(state).length) throw new McpConnectorConfigError(`${where}.pagination requires managed state`)
    pagination = { complete: pointer(p.complete, `${where}.pagination.complete`), maxPages: p.maxPages === undefined ? 128 : requireNumber(p.maxPages, `${where}.pagination.maxPages`, { min: 1, max: 512, integer: true }) }
  }
  if (value.delivery !== undefined) {
    const d = value.delivery
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new McpConnectorConfigError(`${where}.delivery must be an object`)
    onlyKeys(d, new Set(['reloadArguments']), `${where}.delivery`)
    const r = d.reloadArguments
    if (!r || typeof r !== 'object' || Array.isArray(r) || !Object.keys(r).length || Object.keys(r).length > 16 || Object.keys(r).some(k => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k) || ['__proto__', 'constructor', 'prototype'].includes(k) || Object.hasOwn(state, k)) || Object.values(r).some(v => !(v === null || typeof v === 'boolean' || typeof v === 'string' && v.length <= 4096 || typeof v === 'number' && Number.isFinite(v)))) throw new McpConnectorConfigError(`${where}.delivery.reloadArguments must be bounded scalars outside managed state`)
    delivery = { reloadArguments: { ...r } }
  }
  return { tool: requireString(value.tool, `${where}.tool`), arguments: { ...args }, state: { ...state }, pins: [...pins], ...(pagination === undefined ? {} : { pagination }), ...(delivery === undefined ? {} : { delivery }),
    maxBytes: value.maxBytes === undefined ? 131072 : requireNumber(value.maxBytes, `${where}.maxBytes`, { min: 1, max: 1048576, integer: true }) }
}

/**
 * Reject keys the schema does not define.
 * @param value - object being validated.
 * @param allowed - accepted key names.
 * @param where - configuration path.
 */
function onlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new McpConnectorConfigError(
        `${where} has unsupported key "${key}"; supported keys are ${[...allowed].sort().join(', ')}`,
      )
    }
  }
}

/**
 * Require a non-empty string.
 * @param value - candidate value.
 * @param where - configuration path.
 * @returns the value.
 */
function requireString(value, where) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new McpConnectorConfigError(`${where} must be a non-empty string`)
  }
  return value
}

/**
 * Require a string record with template-checked values.
 * @param value - candidate map.
 * @param where - configuration path.
 * @returns a plain string map.
 */
function requireStringMap(value, where) {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpConnectorConfigError(`${where} must be an object of string values`)
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new McpConnectorConfigError(`${where}.${key} must be a string (use \${credential:NAME} for secrets)`)
    }
    assertTemplateSyntax(entry, `${where}.${key}`)
    out[key] = entry
  }
  return out
}

/**
 * Reject malformed `${...}` expressions inside one transport string.
 * @param value - the configured string.
 * @param where - configuration path.
 */
export function assertTemplateSyntax(value, where) {
  let index = 0
  for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
    index = match.index + match[0].length
    if (!/^(credential|env):[A-Za-z_][A-Za-z0-9_]*$/.test(match[1])) {
      throw new McpConnectorConfigError(
        `${where} has a malformed template "${match[0]}"; use \${credential:NAME} or \${env:NAME}`,
      )
    }
  }
  const open = value.lastIndexOf('${')
  if (open !== -1 && open >= index) {
    throw new McpConnectorConfigError(`${where} has an unterminated template expression`)
  }
}

/**
 * Validate one number with bounds.
 * @param value - candidate.
 * @param where - path.
 * @param options - `{ min, max, integer }`.
 * @returns the number.
 */
function requireNumber(value, where, { min, max, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new McpConnectorConfigError(`${where} must be a finite number`)
  }
  if (integer && !Number.isInteger(value)) throw new McpConnectorConfigError(`${where} must be an integer`)
  if (min !== undefined && value < min) throw new McpConnectorConfigError(`${where} must be at least ${min}`)
  if (max !== undefined && value > max) throw new McpConnectorConfigError(`${where} must be at most ${max}`)
  return value
}

/**
 * Validate one boolean.
 * @param value - candidate.
 * @param where - path.
 * @returns the boolean.
 */
function requireBoolean(value, where) {
  if (typeof value !== 'boolean') throw new McpConnectorConfigError(`${where} must be true or false`)
  return value
}

/**
 * Normalize the `reconnect` section.
 * @param value - configured object, or undefined.
 * @param where - path.
 * @returns the resolved policy.
 */
function normalizeReconnect(value, where) {
  const defaults = { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 }
  if (value === undefined) return defaults
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpConnectorConfigError(`${where} must be an object`)
  }
  onlyKeys(value, RECONNECT_KEYS, where)
  return {
    enabled: value.enabled === undefined ? defaults.enabled : requireBoolean(value.enabled, `${where}.enabled`),
    initialDelayMs: value.initialDelayMs === undefined
      ? defaults.initialDelayMs
      : requireNumber(value.initialDelayMs, `${where}.initialDelayMs`, { min: 1, max: 3_600_000 }),
    maxDelayMs: value.maxDelayMs === undefined
      ? defaults.maxDelayMs
      : requireNumber(value.maxDelayMs, `${where}.maxDelayMs`, { min: 1, max: 3_600_000 }),
    maxAttempts: value.maxAttempts === undefined
      ? defaults.maxAttempts
      : requireNumber(value.maxAttempts, `${where}.maxAttempts`, { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true }),
  }
}

/**
 * Normalize the `scope` section: where a server's tools are visible.
 * @param value - configured object, or undefined.
 * @param where - path.
 * @returns `{ mode: 'global' }` or `{ mode: 'workspaces', paths }`.
 */
function normalizeScope(value, where) {
  if (value === undefined || value === null) return { mode: 'global' }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpConnectorConfigError(`${where} must be an object such as { mode: global }`)
  }
  onlyKeys(value, SCOPE_KEYS, where)
  const mode = value.mode ?? 'global'
  if (mode === 'global') return { mode: 'global' }
  if (mode !== 'workspaces') {
    throw new McpConnectorConfigError(`${where}.mode must be global or workspaces`)
  }
  const paths = value.paths
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new McpConnectorConfigError(`${where}.paths must list at least one workspace directory`)
  }
  const normalized = paths.map((entry, index) => {
    const path = requireString(entry, `${where}.paths[${index}]`)
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)) {
      throw new McpConnectorConfigError(`${where}.paths[${index}] must be an absolute directory path`)
    }
    return path.replace(/[\\/]+$/, '') || path
  })
  return { mode: 'workspaces', paths: normalized }
}

/**
 * Normalize the `auth` section.
 * @param value - configured object, or undefined.
 * @param transport - resolved transport name.
 * @param where - path.
 * @returns `{ type: 'none' | 'bearer' | 'oauth', ... }`.
 */
function normalizeAuth(value, transport, where) {
  if (value === undefined || value === null) return { type: 'none' }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpConnectorConfigError(`${where} must be an object such as { type: oauth }`)
  }
  onlyKeys(value, AUTH_KEYS, where)
  const type = value.type ?? 'none'
  if (type === 'none') return { type: 'none' }
  if (type === 'bearer') {
    if (transport === 'stdio') throw new McpConnectorConfigError(`${where}.type "bearer" applies only to HTTP transports`)
    return { type: 'bearer', token: requireString(value.token, `${where}.token`) }
  }
  if (type !== 'oauth') {
    throw new McpConnectorConfigError(`${where}.type must be one of none, bearer, oauth`)
  }
  if (transport === 'stdio') {
    throw new McpConnectorConfigError(`${where}: OAuth applies to HTTP transports; a stdio server receives credentials through "env"`)
  }
  if (value.token !== undefined) throw new McpConnectorConfigError(`${where}.token belongs to auth.type "bearer"`)
  const scopes = value.scopes === undefined
    ? undefined
    : Array.isArray(value.scopes)
      ? value.scopes.map((scope, index) => requireString(scope, `${where}.scopes[${index}]`)).join(' ')
      : requireString(value.scopes, `${where}.scopes`)
  const clientId = value.clientId === undefined ? undefined : requireString(value.clientId, `${where}.clientId`)
  const clientSecret = value.clientSecret === undefined ? undefined : requireString(value.clientSecret, `${where}.clientSecret`)
  if (clientSecret !== undefined) assertTemplateSyntax(clientSecret, `${where}.clientSecret`)
  if (clientSecret !== undefined && clientId === undefined) {
    throw new McpConnectorConfigError(`${where}.clientSecret requires an explicit clientId`)
  }
  const callbackPort = value.callbackPort === undefined
    ? 0
    : requireNumber(value.callbackPort, `${where}.callbackPort`, { min: 0, max: 65_535, integer: true })
  return {
    type: 'oauth',
    scopes,
    clientId,
    clientSecret,
    clientName: value.clientName === undefined ? undefined : requireString(value.clientName, `${where}.clientName`),
    callbackPort,
    resource: value.resource === undefined ? undefined : requireString(value.resource, `${where}.resource`),
    openBrowser: value.openBrowser === undefined ? undefined : requireBoolean(value.openBrowser, `${where}.openBrowser`),
    skipIssuerMetadataValidation: value.skipIssuerMetadataValidation === undefined
      ? false
      : requireBoolean(value.skipIssuerMetadataValidation, `${where}.skipIssuerMetadataValidation`),
  }
}

/**
 * Normalize one server entry.
 * @param name - the map key.
 * @param value - configured entry.
 * @param globalOpenBrowser - global default for opening the authorization URL.
 * @returns the normalized server.
 */
function normalizeServer(name, value, globalOpenBrowser) {
  const where = `servers.${name}`
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new McpConnectorConfigError(
      `${where}: a server name must match ${String(SERVER_NAME_PATTERN)} (letters, digits, "_" and "-", at most 32 characters)`,
    )
  }
  if (value === undefined || value === null) return { name, enabled: false, skipReason: 'no configuration' }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpConnectorConfigError(`${where} must be an object`)
  }
  onlyKeys(value, SERVER_KEYS, where)

  const enabled = value.enabled === undefined ? true : requireBoolean(value.enabled, `${where}.enabled`)
  if (!enabled && value.transport === undefined && value.command === undefined && value.url === undefined) {
    // A disabled stub keeps its name in the configuration without connecting.
    return {
      name,
      enabled: false,
      skipReason: 'disabled without settings',
      transport: 'none',
      auth: { type: 'none' },
      reconnect: normalizeReconnect(undefined, `${where}.reconnect`),
      tools: compileToolPolicy(undefined, `${where}.tools`),
      scope: { mode: 'global' },
      delegation: 'allow',
      openBrowser: false,
    }
  }
  const declared = value.transport
  if (declared === undefined && value.command !== undefined && value.url !== undefined) {
    throw new McpConnectorConfigError(`${where} has both "command" (stdio) and "url" (HTTP); set "transport" explicitly`)
  }
  const inferred = declared ?? (value.command !== undefined ? 'stdio' : value.url !== undefined ? 'streamable-http' : undefined)
  if (inferred === undefined) {
    throw new McpConnectorConfigError(`${where} needs either "transport" or enough fields to infer one ("command" or "url")`)
  }
  const transport = inferred === 'http' ? 'streamable-http' : inferred
  if (!TRANSPORTS.has(transport)) {
    throw new McpConnectorConfigError(`${where}.transport must be one of stdio, streamable-http (http), sse`)
  }
  if (transport === 'stdio') {
    for (const key of ['url', 'headers']) {
      if (value[key] !== undefined) throw new McpConnectorConfigError(`${where}.${key} belongs to an HTTP transport, not stdio`)
    }
  } else {
    for (const key of ['command', 'args', 'env', 'cwd']) {
      if (value[key] !== undefined) throw new McpConnectorConfigError(`${where}.${key} belongs to stdio, not ${transport}`)
    }
  }

  if (value.delegation !== undefined && !['allow', 'deny'].includes(value.delegation)) {
    throw new McpConnectorConfigError(`${where}.delegation must be allow or deny`)
  }
  const auth = normalizeAuth(value.auth, transport, `${where}.auth`)
  const common = {
    name,
    enabled,
    transport,
    auth,
    toolCallTimeoutMs: value.toolCallTimeoutMs === undefined
      ? 60_000
      : requireNumber(value.toolCallTimeoutMs, `${where}.toolCallTimeoutMs`, { min: 1, max: 3_600_000 }),
    startupTimeoutMs: value.startupTimeoutMs === undefined
      ? 30_000
      : requireNumber(value.startupTimeoutMs, `${where}.startupTimeoutMs`, { min: 1, max: 3_600_000 }),
    closeTimeoutMs: value.closeTimeoutMs === undefined
      ? 5_000
      : requireNumber(value.closeTimeoutMs, `${where}.closeTimeoutMs`, { min: 1, max: 60_000 }),
    reconnect: normalizeReconnect(value.reconnect, `${where}.reconnect`),
    tools: compileToolPolicy(value.tools, `${where}.tools`),
    scope: normalizeScope(value.scope, `${where}.scope`),
    delegation: value.delegation ?? 'allow',
    ...(value.runtimeMetadata === undefined ? {} : { runtimeMetadata: normalizeRuntimeMetadata(value.runtimeMetadata, `${where}.runtimeMetadata`) }),
    ...(value.turnContext === undefined ? {} : { turnContext: normalizeTurnContext(value.turnContext, `${where}.turnContext`) }),
    openBrowser: auth.type === 'oauth'
      ? (auth.openBrowser ?? globalOpenBrowser)
      : false,
  }

  if (value.lifecycle !== undefined) common.lifecycle = normalizeLifecycle(value.lifecycle, `${where}.lifecycle`, common)
  if (value.capabilityProfile !== undefined) {
    const profile = value.capabilityProfile, at = `${where}.capabilityProfile`
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new McpConnectorConfigError(`${at} must be an object`)
    onlyKeys(profile, new Set(['version', 'tier']), at)
    if (profile.version !== 1) throw new McpConnectorConfigError(`${at}.version must be 1`)
    if (!['turn-sync', 'trusted-lifecycle'].includes(profile.tier)) throw new McpConnectorConfigError(`${at}.tier must be turn-sync or trusted-lifecycle`)
    const turn = common.turnContext
    if (!turn?.pagination || !turn.delivery || !Object.keys(turn.state).length || !turn.pins.length) throw new McpConnectorConfigError(`${at} requires turnContext pagination, delivery, non-empty state and pins`)
    if (profile.tier === 'trusted-lifecycle' && (!common.runtimeMetadata?.captureTools.length || !common.runtimeMetadata.historyTools.length || !common.lifecycle?.requireCreationAdmission || common.delegation !== 'deny')) throw new McpConnectorConfigError(`${at} trusted-lifecycle requires runtimeMetadata captureTools and historyTools, lifecycle.requireCreationAdmission: true and delegation: deny`)
    common.capabilityProfile = { version: 1, tier: profile.tier }
  }

  if (transport === 'stdio') {
    const command = requireString(value.command, `${where}.command`)
    assertTemplateSyntax(command, `${where}.command`)
    const args = value.args === undefined ? [] : value.args
    if (!Array.isArray(args)) throw new McpConnectorConfigError(`${where}.args must be an array of strings`)
    args.forEach((arg, index) => {
      if (typeof arg !== 'string') throw new McpConnectorConfigError(`${where}.args[${index}] must be a string`)
      assertTemplateSyntax(arg, `${where}.args[${index}]`)
    })
    const cwd = value.cwd === undefined ? '' : requireString(value.cwd, `${where}.cwd`)
    assertTemplateSyntax(cwd, `${where}.cwd`)
    return { ...common, command, args: [...args], env: requireStringMap(value.env, `${where}.env`), cwd }
  }

  const url = requireString(value.url, `${where}.url`)
  assertTemplateSyntax(url, `${where}.url`)
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new McpConnectorConfigError(`${where}.url must be an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpConnectorConfigError(`${where}.url must be an absolute http(s) URL`)
  }
  return { ...common, url, headers: requireStringMap(value.headers, `${where}.headers`) }
}

/**
 * Normalize and validate the plugin's complete configuration.
 * @param raw - the Loader row's config, or undefined.
 * @returns `{ servers, failOnStartupError, openBrowser }`.
 * @throws {McpConnectorConfigError} naming the first invalid value.
 */
export function normalizeConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new McpConnectorConfigError('mcp-connector: config must be an object with a "servers" map')
  }
  onlyKeys(input, GLOBAL_KEYS, 'mcp-connector config')
  const globalOpenBrowser = input.openBrowser === undefined
    ? true
    : requireBoolean(input.openBrowser, 'openBrowser')
  const serversInput = input.servers ?? {}
  if (typeof serversInput !== 'object' || serversInput === null || Array.isArray(serversInput)) {
    throw new McpConnectorConfigError('servers must be an object mapping a server name to its settings')
  }
  const servers = Object.entries(serversInput).map(([name, value]) => normalizeServer(name, value, globalOpenBrowser))
  let recoveries
  try { recoveries = normalizeRecoveries(input.recoveries) } catch { throw new McpConnectorConfigError('recoveries must contain exact, unique operator-approved recovery operations') }
  return {
    servers,
    ...(input.recoveries === undefined ? {} : { recoveries }),
    failOnStartupError: input.failOnStartupError === undefined
      ? false
      : requireBoolean(input.failOnStartupError, 'failOnStartupError'),
    openBrowser: globalOpenBrowser,
  }
}
