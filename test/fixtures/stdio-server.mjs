/**
 * Stdio MCP server fixture used by the connector tests.
 *
 * Speaks the real MCP protocol through the official server SDK over stdio, so
 * the test exercises the same handshake, listing, and call path a production
 * server would.
 */

import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const server = new McpServer({ name: 'stdio-fixture', version: '1.0.0' })

server.registerTool(
  'echo',
  { description: 'Echo the given text', inputSchema: z.object({ text: z.string() }) },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
)

server.registerTool(
  'secret_delete',
  { description: 'Deletes something (used by policy tests)', inputSchema: z.object({ id: z.string().optional() }) },
  async () => ({ content: [{ type: 'text', text: 'deleted' }] }),
)

server.registerTool(
  'ask_me',
  { description: 'Requires approval in policy tests', inputSchema: z.object({}) },
  async () => ({ content: [{ type: 'text', text: 'asked' }] }),
)

server.registerTool(
  'hidden_tool',
  { description: 'Policy "off" keeps this out of the registry', inputSchema: z.object({}) },
  async () => ({ content: [{ type: 'text', text: 'hidden' }] }),
)

server.registerTool(
  'crash',
  { description: 'Exit the server process right after answering', inputSchema: z.object({}) },
  async () => {
    setTimeout(() => process.exit(1), 10)
    return { content: [{ type: 'text', text: 'bye' }] }
  },
)

server.registerTool(
  'boom',
  { description: 'Always reports a tool-level error', inputSchema: z.object({}) },
  async () => ({ isError: true, content: [{ type: 'text', text: 'boom happened' }] }),
)

await server.connect(new StdioServerTransport())