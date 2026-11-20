/**
 * Management API for the browser configuration panel.
 *
 * The panel is a Client plugin that renders inside Settings; this module is the
 * Host half it talks to over same-origin HTTP. Every route passes the Host's
 * connection trust fence first, then reads or rewrites the plugin row's config
 * through the ConfigEditor, which persists into the user's profile patch and
 * restarts this plugin so the new server set connects.
 *
 * @module dsh-mcp-connector/api
 */

import { normalizeConfig } from './config.js'

/** Route paths owned by the panel. */
export const API_PATHS = Object.freeze({
  state: '/mcp-connector/api/state',
  config: '/mcp-connector/api/config',
  action: '/mcp-connector/api/action',
})

/** Upper bound for one request body; the panel sends small JSON documents. */
const MAX_BODY_BYTES = 512 * 1024

/**
 * Write a JSON response.
 * @param res - the Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Read a bounded JSON request body.
 * @param req - the Node request.
 * @returns the parsed body, or `undefined` when it is too large or not JSON.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Describe the editable configuration currently in force.
 * @param options - accessors supplied by the plugin entry.
 * @returns `{ config, editable, reason? }`.
 */
function readConfig(options) {
  const { editor, entry, rawConfig } = options
  if (editor === undefined || entry === undefined) {
    return { config: rawConfig, editable: false, reason: 'This profile has no configuration editor; edit cordis.patch.yml instead.' }
  }
  try {
    const row = editor.configuration().find(candidate => candidate.entry === entry)
    if (row === undefined) {
      return { config: rawConfig, editable: false, reason: 'The connector row is not addressable in this profile.' }
    }
    return { config: { ...row.inherited, ...row.override }, editable: true }
  } catch {
    return { config: rawConfig, editable: true }
  }
}

/**
 * Register the panel's routes on the Host web server.
 * @param ctx - plugin context.
 * @param options - `{ rawConfig, connections, find, logger }`.
 */
export function registerApi(ctx, options) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  const { connections, find, logger } = options
  let rawConfig = options.rawConfig

  /**
   * Apply the Host's trust fence; true when the request was already rejected.
   * @param req - incoming request.
   * @param res - response used for the rejection.
   * @returns whether the request was rejected.
   */
  const rejected = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined) {
      sendJson(res, 503, { ok: false, error: 'This profile has no browser connection service.' })
      return true
    }
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    sendJson(res, rejection, { ok: false, error: rejection === 403 ? 'Request rejected by the Host/Origin fence.' : 'Not authenticated.' })
    return true
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API_PATHS.state,
    handler: (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      const current = readConfig({ editor, entry, rawConfig })
      sendJson(res, 200, {
        ok: true,
        editable: current.editable,
        reason: current.reason,
        config: current.config,
        servers: connections.map(connection => connection.snapshot()),
      })
    },
  }), 'mcp-connector: GET state')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API_PATHS.config,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const body = await readJson(req)
      if (body === undefined || typeof body !== 'object' || body === null || typeof body.config !== 'object') {
        sendJson(res, 400, { ok: false, error: 'Expected a JSON body of the form { "config": { ... } }.' })
        return
      }
      try {
        normalizeConfig(body.config)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error), kind: 'validation' })
        return
      }
      if (editor === undefined || entry === undefined) {
        sendJson(res, 409, { ok: false, error: 'This profile has no configuration editor; edit cordis.patch.yml instead.' })
        return
      }
      try {
        await editor.edit(entry, () => body.config)
        rawConfig = body.config
        sendJson(res, 200, { ok: true, config: body.config })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`saving configuration failed: ${message}`)
        sendJson(res, 409, { ok: false, error: message })
      }
    },
  }), 'mcp-connector: POST config')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: API_PATHS.action,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const body = await readJson(req)
      if (body === undefined || typeof body !== 'object' || body === null) {
        sendJson(res, 400, { ok: false, error: 'Expected a JSON action body.' })
        return
      }
      try {
        const connection = find(body.server)
        if (body.action === 'authorize') {
          const waitMs = typeof body.waitSeconds === 'number' ? Math.max(0, Math.min(120, body.waitSeconds)) * 1000 : 0
          sendJson(res, 200, { ok: true, server: await connection.authorize({ waitMs }) })
          return
        }
        if (body.action === 'logout') {
          sendJson(res, 200, { ok: true, server: await connection.logout() })
          return
        }
        if (body.action === 'reconnect') {
          const result = await connection.reconnect()
          sendJson(res, 200, { ok: true, server: { ...connection.snapshot(), ...result } })
          return
        }
        sendJson(res, 400, { ok: false, error: `Unknown action "${String(body.action)}".` })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'mcp-connector: POST action')
}