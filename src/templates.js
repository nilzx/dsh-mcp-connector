/**
 * Runtime templates and secret redaction.
 *
 * Transport strings accept `${credential:NAME}` (resolved through the Host
 * credentials service) and `${env:NAME}` (the Host process environment). Raw
 * plugin configuration keeps the template text, so configuration files never
 * contain the secret; every value this module resolves is remembered and
 * removed from diagnostics and tool-call failures.
 *
 * @module dsh-mcp-connector/templates
 */

const TEMPLATE = /\$\{(credential|env):([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Placeholder written instead of a resolved secret in diagnostic text. */
export const REDACTED = '[redacted]'

/**
 * Every string in one normalized server entry that may carry a template.
 * @param entry - normalized server.
 * @returns the transport strings.
 */
function transportStrings(entry) {
  if (entry.transport === 'stdio') {
    return [entry.command, ...entry.args, entry.cwd, ...Object.values(entry.env)]
  }
  const values = [entry.url, ...Object.values(entry.headers)]
  if (entry.auth.type === 'bearer' && entry.auth.token !== undefined) values.push(entry.auth.token)
  if (entry.auth.type === 'oauth' && entry.auth.clientSecret !== undefined) values.push(entry.auth.clientSecret)
  return values
}

/**
 * Resolve every credential reference used by one server entry.
 * @param values - transport strings.
 * @param credentials - the Host credentials service, or undefined.
 * @returns a map from reference name to resolved value.
 */
async function resolveCredentials(values, credentials) {
  const refs = new Set()
  for (const value of values) {
    if (typeof value !== 'string') continue
    for (const match of value.matchAll(TEMPLATE)) {
      if (match[1] === 'credential') refs.add(match[2])
    }
  }
  if (refs.size === 0) return new Map()
  if (credentials === undefined) {
    throw new Error(
      `\${credential:${[...refs][0]}} needs the credentials service, which this profile does not mount`,
    )
  }
  const entries = await Promise.all([...refs].map(async (ref) => {
    const resolved = await credentials.resolve(ref)
    if (resolved === undefined || resolved.value === '') {
      throw new Error(`the credential "${ref}" is not configured in this profile`)
    }
    return [ref, resolved.value]
  }))
  return new Map(entries)
}

/**
 * Expand every transport string of one normalized server entry.
 * @param entry - normalized server from {@link import('./config.js').normalizeConfig}.
 * @param options - `{ credentials, env }`.
 * @returns `{ entry, redact }` where `entry` is a shallow-expanded copy.
 */
export async function expandServerTemplates(entry, { credentials, env = process.env } = {}) {
  const values = transportStrings(entry)
  const resolved = await resolveCredentials(values, credentials)
  const secrets = new Set(resolved.values())
  const expand = (value) => value.replace(TEMPLATE, (_match, kind, name) => {
    if (kind === 'credential') return resolved.get(name)
    const ambient = env[name]
    if (ambient === undefined || ambient === '') {
      throw new Error(`the env template \${env:${name}} has no value in the Host environment`)
    }
    return ambient
  })

  const expanded = { ...entry, auth: { ...entry.auth } }
  if (entry.transport === 'stdio') {
    expanded.command = expand(entry.command)
    expanded.args = entry.args.map(expand)
    if (entry.cwd !== '') expanded.cwd = expand(entry.cwd)
    expanded.env = Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, expand(value)]))
  } else {
    expanded.url = expand(entry.url)
    expanded.headers = Object.fromEntries(Object.entries(entry.headers).map(([key, value]) => [key, expand(value)]))
  }
  if (entry.auth.type === 'bearer' && entry.auth.token !== undefined) {
    expanded.auth.token = expand(entry.auth.token)
  }
  if (entry.auth.type === 'oauth' && entry.auth.clientSecret !== undefined) {
    expanded.auth.clientSecret = expand(entry.auth.clientSecret)
  }

  return {
    entry: expanded,
    /** Remove every resolved secret from one diagnostic string. */
    redact(text) {
      let out = String(text)
      for (const secret of secrets) {
        if (secret === '') continue
        out = out.split(secret).join(REDACTED)
        const encoded = encodeURIComponent(secret)
        if (encoded !== secret) out = out.split(encoded).join(REDACTED)
      }
      return out
    },
  }
}