/**
 * Tool definitions for bridged MCP tools.
 *
 * The canonical value keeps the MCP protocol content so programmatic callers
 * see exactly what the server returned, while `render` produces the text the
 * model reads. Images, audio and embedded resources are projected as explicit
 * text diagnostics: this connector does not admit attachments, so a binary
 * payload never silently disappears from a result.
 *
 * @module dsh-mcp-connector/tools
 */

/**
 * @typedef {object} McpToolValue
 * @property {unknown[]} content - MCP content blocks, in server order.
 * @property {unknown} [structuredContent] - advertised structured output.
 */

/**
 * Flatten MCP content blocks into model-facing text.
 * @param blocks - MCP content blocks.
 * @param rawName - upstream tool name used in diagnostics.
 * @returns the joined text.
 */
export function contentToText(blocks, rawName) {
  const parts = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) {
      parts.push(String(block))
      continue
    }
    switch (block.type) {
      case 'text':
        parts.push(String(block.text ?? ''))
        break
      case 'image':
        parts.push(`[image ${block.mimeType ?? 'unknown type'} from "${rawName}"; binary content is not attached in this connector]`)
        break
      case 'audio':
        parts.push(`[audio ${block.mimeType ?? 'unknown type'} from "${rawName}"; binary content is not attached in this connector]`)
        break
      case 'resource_link':
        parts.push(`[resource ${block.name ?? ''} <${block.uri ?? ''}>]`)
        break
      case 'resource': {
        const resource = block.resource
        if (typeof resource === 'object' && resource !== null && typeof resource.text === 'string') {
          parts.push(resource.text)
        } else {
          parts.push(`[embedded resource ${resource?.uri ?? ''}]`)
        }
        break
      }
      default:
        parts.push(`[${String(block.type)} content]`)
    }
  }
  return parts.join('\n')
}

/**
 * Build the model-facing text for one canonical value.
 * @param value - canonical MCP value.
 * @param rawName - upstream tool name.
 * @returns text for `render`.
 */
function renderText(value, rawName) {
  const text = contentToText(Array.isArray(value?.content) ? value.content : [], rawName)
  if (text.trim() !== '') return text
  if (value?.structuredContent !== undefined) return JSON.stringify(value.structuredContent, null, 2)
  return `Tool "${rawName}" returned no content.`
}

/**
 * Create one DSH tool definition for an MCP tool.
 * @param options - `{ publicName, rawName, description, inputSchema, outputSchema, call, redact }`.
 * @param options.publicName - registered model-facing name.
 * @param options.rawName - upstream name sent on the wire.
 * @param options.description - model-facing description.
 * @param options.inputSchema - upstream JSON input schema.
 * @param options.outputSchema - advertised structured output schema, when present.
 * @param options.call - obtains the raw MCP result for one call.
 * @param options.redact - removes resolved secrets from failure text.
 * @returns the unregistered tool definition.
 */
export function createToolDefinition({ publicName, rawName, description, inputSchema, outputSchema, call, redact }) {
  const properties = { content: { type: 'array', items: {} } }
  if (outputSchema !== undefined) properties.structuredContent = {}
  return {
    name: publicName,
    description: typeof description === 'string' && description !== '' ? description : `MCP tool "${rawName}"`,
    parameters: sanitizeInputSchema(inputSchema),
    output: {
      schema: {
        type: 'object',
        properties,
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: renderText(value, rawName) }]
      },
    },
    async execute(args, exec) {
      const argsObject = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
      let result
      try {
        result = await call(argsObject, exec)
      } catch (error) {
        throw new Error(redact(error instanceof Error ? error.message : String(error)), { cause: error })
      }
      const content = Array.isArray(result?.content) ? result.content : []
      if (result?.isError === true) throw new Error(redact(contentToText(content, rawName)))
      return {
        content,
        ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      }
    },
  }
}

/**
 * Keep the upstream input schema usable as a DSH parameter object.
 * @param schema - upstream JSON schema.
 * @returns an object schema with `type: object`.
 */
function sanitizeInputSchema(schema) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {}, additionalProperties: true }
  }
  return {
    ...schema,
    type: 'object',
    properties: typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {},
    ...(schema.additionalProperties === undefined ? { additionalProperties: true } : {}),
  }
}