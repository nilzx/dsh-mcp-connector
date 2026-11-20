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

const GLOBAL_KEYS = new Set(['servers', 'failOnStartupError', 'openBrowser'])
const SERVER_KEYS = new Set([
  'transport', 'enabled', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'auth',
  'toolCallTimeoutMs', 'startupTimeoutMs', 'closeTimeoutMs', 'reconnect', 'tools', 'scope',
])
const AUTH_KEYS = new Set([
  'type', 'token', 'scopes', 'clientId', 'clientSecret', 'clientName', 'callbackPort',
  'resource', 'openBrowser', 'skipIssuerMetadataValidation',
])
const RECONNECT_KEYS = new Set(['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'])
const SCOPE_KEYS = new Set(['mode', 'paths'])
const TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse'])

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
    openBrowser: auth.type === 'oauth'
      ? (auth.openBrowser ?? globalOpenBrowser)
      : false,
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
  return {
    servers,
    failOnStartupError: input.failOnStartupError === undefined
      ? false
      : requireBoolean(input.failOnStartupError, 'failOnStartupError'),
    openBrowser: globalOpenBrowser,
  }
}