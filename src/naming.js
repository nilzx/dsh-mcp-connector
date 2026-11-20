/**
 * Model-facing tool names for bridged MCP tools.
 *
 * The public name is a pure function of `(serverName, rawName)` and matches the
 * `@deepseek-ai/dsh-mcp-client` algorithm exactly, so a server that has been
 * connected through either plugin keeps the same names in session history and
 * permission rules. The raw name is the only name ever sent on the wire.
 *
 * @module dsh-mcp-connector/naming
 */

import { createHash } from 'node:crypto'

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/**
 * Derive the model-facing public name for one MCP tool.
 * @param serverName - stable local namespace from configuration.
 * @param rawName - the MCP server's own tool name.
 * @returns the globally unique, model-facing tool name.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}