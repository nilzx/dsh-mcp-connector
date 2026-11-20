/**
 * Transport construction.
 *
 * Three connection styles are supported:
 *
 * - `stdio` — spawn a local process and speak MCP over its stdin/stdout.
 * - `streamable-http` — the current HTTP transport (also reachable as `http`).
 * - `sse` — the legacy HTTP+SSE transport for servers that never shipped
 *   Streamable HTTP.
 *
 * HTTP transports receive the OAuth provider when the server uses OAuth, so the
 * SDK attaches the bearer token, refreshes it, and starts a new authorization
 * only when the authorization server actually requires one.
 *
 * @module dsh-mcp-connector/transport
 */

import { SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'

/**
 * Build one MCP transport.
 * @param entry - a template-expanded server entry.
 * @param options - `{ provider }`, the OAuth provider for HTTP transports.
 * @returns a transport instance ready for `Client.connect`.
 */
export function createTransport(entry, { provider } = {}) {
  if (entry.transport === 'stdio') {
    return new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      // Inherit only the SDK's small safe set; configured env wins. Ambient
      // secrets (tokens, keys, DSH_*) never reach an MCP child process.
      env: { ...getDefaultEnvironment(), ...entry.env },
      ...(entry.cwd === '' ? {} : { cwd: entry.cwd }),
      stderr: 'inherit',
    })
  }

  const headers = { ...entry.headers }
  if (entry.auth.type === 'bearer' && entry.auth.token !== undefined) {
    headers.Authorization = `Bearer ${entry.auth.token}`
  }
  const url = new URL(entry.url)
  const options = {
    requestInit: { headers },
    ...(provider === undefined ? {} : { authProvider: provider }),
  }
  return entry.transport === 'sse'
    ? new SSEClientTransport(url, options)
    : new StreamableHTTPClientTransport(url, options)
}