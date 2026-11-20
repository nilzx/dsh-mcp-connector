/**
 * Legacy HTTP+SSE MCP server fixture (protocol 2024-11-05).
 *
 * MCP's SSE transport is gone from the v2 server SDK, so this fixture speaks the
 * small wire subset the connector needs: the endpoint event, JSON-RPC requests
 * posted to `/messages`, and responses streamed back over the open SSE channel.
 * It exists to prove the connector's `sse` transport path still works with
 * servers that never shipped Streamable HTTP.
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

/** Tool list served by this fixture. */
const TOOLS = [
  {
    name: 'sse_echo',
    description: 'Echo the given text over SSE',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
]

/** Read a request body as UTF-8 text. */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** Write one JSON-RPC message to an SSE stream. */
function send(stream, message) {
  stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
}

/**
 * Answer one JSON-RPC message.
 * @param message - parsed request or notification.
 * @returns the response, or undefined for notifications.
 */
function respond(message) {
  const id = message.id
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sse-fixture', version: '1.0.0' },
      },
    }
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (name === 'sse_echo') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `sse:${String(args.text ?? '')}` }] },
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${String(name)}` } }
  }
  if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (id === undefined) return undefined
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(message.method)}` } }
}

/**
 * Start the fixture.
 * @returns `{ url, close }`.
 */
export async function startSseMcpServer() {
  const streams = new Map()
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/sse') {
        const id = randomUUID()
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write('event: endpoint\ndata: /messages\n\n')
        streams.set(id, res)
        req.on('close', () => streams.delete(id))
        return
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const body = await readBody(req)
        res.writeHead(202, { 'content-type': 'text/plain' }).end('Accepted')
        const stream = [...streams.values()].at(-1)
        if (stream === undefined) return
        const parsed = JSON.parse(body)
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
          const response = respond(message)
          if (response !== undefined) send(stream, response)
        }
        return
      }
      res.writeHead(404).end()
    })()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    url: `${origin}/sse`,
    async close() {
      for (const stream of streams.values()) stream.end()
      await new Promise(resolve => server.close(() => resolve()))
    },
  }
}