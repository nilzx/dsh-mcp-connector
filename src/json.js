/**
 * JSON hygiene for tool results.
 *
 * The Harness validates a tool's canonical value as lossless JSON, which
 * rejects `undefined` object members that `JSON.stringify` would silently drop.
 * Status snapshots are built from optional fields, so they pass through here
 * before they reach a tool result.
 *
 * @module dsh-mcp-connector/json
 */

/**
 * Recursively drop `undefined` members and replace non-finite numbers with null.
 * @param value - any JSON-shaped value.
 * @returns a value that survives a lossless JSON round trip.
 */
export function compactJson(value) {
  if (Array.isArray(value)) return value.map(compactJson)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      out[key] = compactJson(entry)
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}