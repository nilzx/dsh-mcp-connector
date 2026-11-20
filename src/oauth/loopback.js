/**
 * Loopback OAuth callback listener.
 *
 * The OAuth redirect target is a short-lived HTTP server bound to 127.0.0.1, not
 * the Harness web server: it works in Desktop and headless profiles, needs no
 * session cookie, and keeps the authorization response on the loopback
 * interface. The port is stable across restarts because it is persisted with the
 * client registration; a redirect URI the authorization server already knows
 * keeps working.
 *
 * @module dsh-mcp-connector/oauth/loopback
 */

import { createServer } from 'node:http'

/** Default callback path on the loopback listener. */
export const CALLBACK_PATH = '/callback'

/**
 * Render the small result page shown in the browser after the redirect.
 * @param title - page title.
 * @param message - explanatory paragraph.
 * @returns a complete HTML document.
 */
function page(title, message) {
  const escape = html => String(html).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
 :root { color-scheme: light dark; }
 body { margin: 0; min-height: 100vh; display: grid; place-items: center;
   font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
   background: #f6f7f9; color: #1b1d21; }
 main { max-width: 30rem; padding: 2.5rem; background: #fff; border-radius: 14px;
   box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 28px rgba(0,0,0,.08); }
 h1 { margin: 0 0 .6rem; font-size: 1.15rem; }
 p { margin: 0; color: #555b66; }
 @media (prefers-color-scheme: dark) {
   body { background: #16181c; color: #eceef2; }
   main { background: #1e2126; box-shadow: 0 1px 2px rgba(0,0,0,.4); }
   p { color: #a9afba; }
 }
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`
}

/**
 * Start one loopback listener.
 * @param options - `{ port, path, onCallback }`.
 * @param options.port - preferred TCP port on 127.0.0.1; `0` picks a free one.
 * @param options.path - callback pathname.
 * @param options.onCallback - receives the callback's search params; resolves the page text.
 * @returns `{ port, url, close }`.
 */
export async function startLoopbackServer({ port = 0, path = CALLBACK_PATH, onCallback }) {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== path) {
        res.statusCode = 404
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('not found')
        return
      }
      let outcome
      try {
        outcome = await onCallback(url.searchParams)
      } catch (error) {
        outcome = { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      res.statusCode = outcome.ok === false ? 400 : 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(page(
        outcome.ok === false ? 'Authorization failed' : 'Authorization complete',
        outcome.message,
      ))
    })()
  })
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  await listening
  server.unref()
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  let closed = false
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}${path}`,
    async close() {
      if (closed) return
      closed = true
      await new Promise(resolve => server.close(() => resolve()))
    },
  }
}