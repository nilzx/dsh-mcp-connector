/** Buffer initialization output and release only complete, permitted tool calls. */
export async function* initializationStream(source, { allows, signal, maxBytes = 1048576, validate = () => {} }) {
  const blocks = new Map(), calls = [], ids = new Set()
  let bytes = 0, finish, usage
  for await (const chunk of source) {
    signal?.throwIfAborted()
    if (finish !== undefined) throw new Error('MCP initialization stream continued after its terminal result')
    bytes += Buffer.byteLength(JSON.stringify(chunk))
    if (bytes > maxBytes) throw new Error('MCP initialization output exceeds its configured limit')
    if (chunk.type === 'usage') { usage = chunk; continue }
    if (chunk.type === 'finish') { finish = chunk; continue }
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) throw new Error('Invalid initialization block index')
    if (chunk.type === 'block-start') {
      if (blocks.has(chunk.index) || blocks.size >= 64 || !['text', 'reasoning', 'tool-call'].includes(chunk.blockType)) throw new Error('Invalid initialization block')
      blocks.set(chunk.index, { type: chunk.blockType, ended: false })
      continue
    }
    const state = blocks.get(chunk.index)
    if (!state || state.ended) throw new Error('Initialization block is missing or already complete')
    if (chunk.type === 'block-end') {
      if (chunk.block?.type !== state.type) throw new Error('Initialization block type changed')
      state.ended = true
      if (state.type === 'tool-call') {
        const block = chunk.block
        if (typeof block.id !== 'string' || !block.id || ids.has(block.id) || typeof block.name !== 'string' || !allows(block.name)
          || typeof block.arguments !== 'string') throw new Error('Initialization requested an unavailable tool')
        let args
        try { args = JSON.parse(block.arguments) } catch { throw new Error('Initialization tool arguments are incomplete') }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Initialization tool arguments must be an object')
        ids.add(block.id); calls.push({ ...block })
      }
      continue
    }
    const expected = { 'text-delta': 'text', 'reasoning-delta': 'reasoning', 'tool-call-delta': 'tool-call' }[chunk.type]
    if (expected !== state.type) throw new Error('Invalid initialization stream event')
  }
  signal?.throwIfAborted()
  if (!finish || !['stop', 'tool-calls'].includes(finish.reason?.kind) || !calls.length || [...blocks.values()].some(b => !b.ended)) {
    throw new Error('MCP initialization requires a complete permitted tool call; no ordinary answer was released')
  }
  // Check the owning workflow again after asynchronous generation, before
  // emitting even the first chunk. Private replay state describes the original
  // block layout and cannot be retained after filtering.
  validate()
  if (calls.some(block => !allows(block.name))) throw new Error('Initialization tool authorization changed')
  for (const [index, block] of calls.entries()) {
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments }
    yield { type: 'block-end', index, block }
  }
  if (usage) yield usage
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
