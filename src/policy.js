/**
 * Per-tool authorization policies.
 *
 * Each MCP tool resolves to one policy:
 *
 * - `allow` — the call runs without an extra prompt (other plugins' gates still run).
 * - `ask`   — the call pauses for the session's approval channel; rejection, a
 *             missing approval service, or the `never` policy denies it.
 * - `deny`  — the call is refused before dispatch; the model sees the reason.
 * - `off`   — the tool is not registered at all, so the model never sees it.
 *
 * Rules are glob patterns matched against the raw MCP tool name and the
 * server-qualified public name, in the order they appear in configuration. The
 * first match wins; `default` applies when nothing matched.
 *
 * @module dsh-mcp-connector/policy
 */

/** Every accepted per-tool policy. */
export const TOOL_POLICIES = Object.freeze(['allow', 'ask', 'deny', 'off'])

/** Escape one literal character for a regular expression body. */
function escapeRegExp(char) {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/**
 * Compile one glob pattern: `*` matches any run of characters, `?` exactly one.
 * @param pattern - the configured pattern.
 * @returns an anchored, case-sensitive regular expression.
 */
export function globToRegExp(pattern) {
  let body = ''
  for (const char of pattern) {
    if (char === '*') body += '.*'
    else if (char === '?') body += '.'
    else body += escapeRegExp(char)
  }
  return new RegExp(`^${body}$`)
}

/**
 * Compile a server's `tools` configuration.
 * @param input - `{ default?: policy, rules?: Record<string, policy> }`, or undefined.
 * @param where - configuration path used in error messages.
 * @returns `{ default, rules: Array<{ pattern, policy, test }> }`.
 * @throws {TypeError} when a policy or pattern is invalid.
 */
export function compileToolPolicy(input, where) {
  if (input === undefined || input === null) return { default: 'allow', rules: [] }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${where} must be an object with optional "default" and "rules"`)
  }
  const unknown = Object.keys(input).filter(key => key !== 'default' && key !== 'rules')
  if (unknown.length > 0) {
    throw new TypeError(`${where} has unsupported key(s) ${unknown.map(key => JSON.stringify(key)).join(', ')}; use "default" and "rules"`)
  }
  const fallback = input.default ?? 'allow'
  if (!TOOL_POLICIES.includes(fallback)) {
    throw new TypeError(`${where}.default must be one of ${TOOL_POLICIES.join(', ')}`)
  }
  const rawRules = input.rules ?? {}
  if (typeof rawRules !== 'object' || rawRules === null || Array.isArray(rawRules)) {
    throw new TypeError(`${where}.rules must be an object mapping a tool-name pattern to a policy`)
  }
  const rules = []
  for (const [pattern, policy] of Object.entries(rawRules)) {
    if (pattern.trim() === '') throw new TypeError(`${where}.rules has an empty pattern`)
    if (!TOOL_POLICIES.includes(policy)) {
      throw new TypeError(`${where}.rules[${JSON.stringify(pattern)}] must be one of ${TOOL_POLICIES.join(', ')}`)
    }
    rules.push({ pattern, policy, regex: globToRegExp(pattern) })
  }
  return { default: fallback, rules }
}

/**
 * Resolve the policy for one discovered tool.
 * @param compiled - value returned by {@link compileToolPolicy}.
 * @param rawName - the MCP server's own tool name.
 * @param publicName - the server-qualified registered name.
 * @returns one of {@link TOOL_POLICIES}.
 */
export function resolveToolPolicy(compiled, rawName, publicName) {
  for (const rule of compiled.rules) {
    if (rule.regex.test(rawName) || rule.regex.test(publicName)) return rule.policy
  }
  return compiled.default
}

/**
 * Build the pre-execute decision for a policy.
 * @param policy - resolved policy (`allow` already returned `next()` upstream).
 * @param publicName - the tool being called.
 * @returns a Cordis `PreToolDecision`, or `undefined` for `allow`/`off`.
 */
export function policyDecision(policy, publicName) {
  if (policy === 'deny') {
    return {
      kind: 'deny',
      reason: `Tool "${publicName}" is blocked by this MCP server's per-tool policy (deny).`,
      info: { name: 'McpConnectorPolicyError', code: 'MCP_CONNECTOR_TOOL_DENIED' },
    }
  }
  if (policy === 'ask') {
    return {
      kind: 'ask',
      reason: `approval required by the MCP connector's per-tool policy for "${publicName}"`,
      displayReason: {
        en: `Run the MCP tool "${publicName}"? Its per-tool policy asks for approval.`,
        zh: `是否运行 MCP 工具“${publicName}”？该工具的授权策略为“询问”。`,
      },
    }
  }
  return undefined
}