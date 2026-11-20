import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { McpConnectorConfigError, normalizeConfig } from '../src/config.js'

describe('normalizeConfig', () => {
  it('applies defaults and infers stdio from command', () => {
    const { servers } = normalizeConfig({
      servers: { fix: { command: 'node', args: ['server.mjs'] } },
    })
    const [server] = servers
    assert.equal(server.name, 'fix')
    assert.equal(server.transport, 'stdio')
    assert.equal(server.enabled, true)
    assert.equal(server.toolCallTimeoutMs, 60_000)
    assert.equal(server.startupTimeoutMs, 30_000)
    assert.deepEqual(server.reconnect, {
      enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10,
    })
    assert.equal(server.auth.type, 'none')
    assert.deepEqual(server.tools, { default: 'allow', rules: [] })
  })

  it('infers an HTTP transport from url and normalizes the http alias', () => {
    const { servers } = normalizeConfig({
      servers: { remote: { transport: 'http', url: 'https://mcp.example.com/mcp' } },
    })
    assert.equal(servers[0].transport, 'streamable-http')
    assert.deepEqual(servers[0].headers, {})
  })

  it('normalizes an OAuth server with scopes and a callback port', () => {
    const { servers } = normalizeConfig({
      servers: {
        linear: {
          transport: 'streamable-http',
          url: 'https://mcp.linear.app/mcp',
          auth: { type: 'oauth', scopes: ['read', 'write'], callbackPort: 43123, clientId: 'abc' },
        },
      },
    })
    assert.deepEqual(servers[0].auth, {
      type: 'oauth',
      scopes: 'read write',
      clientId: 'abc',
      clientSecret: undefined,
      clientName: undefined,
      callbackPort: 43123,
      resource: undefined,
      openBrowser: undefined,
      skipIssuerMetadataValidation: false,
    })
    assert.equal(servers[0].openBrowser, true)
  })

  it('keeps a disabled server but marks it disabled', () => {
    const { servers } = normalizeConfig({ servers: { off: { enabled: false } } })
    assert.equal(servers[0].enabled, false)
  })

  it('rejects an unknown key with its configuration path', () => {
    assert.throws(
      () => normalizeConfig({ servers: { fix: { command: 'node', argz: [] } } }),
      (error) => error instanceof McpConnectorConfigError && /servers\.fix has unsupported key "argz"/.test(error.message),
    )
  })

  it('rejects a stdio server without a command', () => {
    assert.throws(
      () => normalizeConfig({ servers: { fix: { transport: 'stdio' } } }),
      /servers\.fix\.command must be a non-empty string/,
    )
  })

  it('rejects transport fields that belong to the other transport', () => {
    assert.throws(
      () => normalizeConfig({ servers: { fix: { transport: 'stdio', command: 'node', url: 'https://x.test/mcp' } } }),
      /servers\.fix\.url belongs to an HTTP transport/,
    )
    assert.throws(
      () => normalizeConfig({ servers: { web: { url: 'https://x.test/mcp', command: 'node' } } }),
      /has both "command" \(stdio\) and "url" \(HTTP\)/,
    )
    assert.throws(
      () => normalizeConfig({ servers: { web: { transport: 'streamable-http', url: 'https://x.test/mcp', command: 'node' } } }),
      /servers\.web\.command belongs to stdio/,
    )
  })

  it('rejects OAuth on stdio and bearer without a token', () => {
    assert.throws(
      () => normalizeConfig({ servers: { fix: { command: 'node', auth: { type: 'oauth' } } } }),
      /OAuth applies to HTTP transports/,
    )
    assert.throws(
      () => normalizeConfig({ servers: { web: { url: 'https://x.test/mcp', auth: { type: 'bearer' } } } }),
      /servers\.web\.auth\.token must be a non-empty string/,
    )
  })

  it('rejects a client secret without a client id', () => {
    assert.throws(
      () => normalizeConfig({
        servers: { web: { url: 'https://x.test/mcp', auth: { type: 'oauth', clientSecret: '${credential:X}' } } },
      }),
      /clientSecret requires an explicit clientId/,
    )
  })

  it('rejects malformed template expressions', () => {
    assert.throws(
      () => normalizeConfig({
        servers: { fix: { command: 'node', env: { TOKEN: '${secret:TOKEN}' } } },
      }),
      /servers\.fix\.env\.TOKEN has a malformed template/,
    )
    assert.throws(
      () => normalizeConfig({ servers: { fix: { command: 'node', env: { TOKEN: '${credential:TOKEN' } } } }),
      /unterminated template expression/,
    )
  })

  it('rejects invalid policies and patterns', () => {
    assert.throws(
      () => normalizeConfig({ servers: { fix: { command: 'node', tools: { default: 'maybe' } } } }),
      /tools\.default must be one of allow, ask, deny, off/,
    )
    assert.throws(
      () => normalizeConfig({ servers: { fix: { command: 'node', tools: { rules: { '*': 'sometimes' } } } } }),
      /tools\.rules\["\*"\] must be one of/,
    )
    assert.throws(
      () => normalizeConfig({ servers: { fix: { command: 'node', tools: { allow: true } } } }),
      /tools has unsupported key\(s\) "allow"/,
    )
  })

  it('rejects an invalid server name', () => {
    assert.throws(
      () => normalizeConfig({ servers: { 'bad name': { command: 'node' } } }),
      /a server name must match/,
    )
  })

  it('rejects a non-http URL', () => {
    assert.throws(
      () => normalizeConfig({ servers: { web: { url: 'ftp://example.com/mcp' } } }),
      /must be an absolute http\(s\) URL/,
    )
  })

  it('accepts an empty configuration', () => {
    assert.deepEqual(normalizeConfig(undefined), {
      servers: [], failOnStartupError: false, openBrowser: true,
    })
  })
})