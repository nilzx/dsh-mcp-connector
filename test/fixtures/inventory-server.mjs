import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const server = new McpServer({ name: 'inventory-fixture', version: '1' })
server.registerTool('inventory', {
  inputSchema: z.object({ cursor: z.string().optional(), reload: z.boolean().optional() }),
}, async ({ cursor, reload }) => {
  if (cursor === 'bad') return { isError: true, content: [{ type: 'text', text: 'inventory unavailable' }] }
  const first = reload || !cursor
  const next = first ? 'page2' : cursor === 'page2' ? 'end' : cursor
  return {
    content: [{ type: 'text', text: first ? 'apples' : cursor === 'page2' ? 'pears' : 'no changes' }],
    structuredContent: { cursor: next, complete: next !== 'page2', warehouse: 'warehouse-1' },
  }
})
await server.connect(new StdioServerTransport())
