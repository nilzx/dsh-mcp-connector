/**
 * Streamable HTTP MCP server fixture with a real OAuth 2.1 authorization server.
 *
 * One loopback origin serves:
 *
 * - `/.well-known/oauth-protected-resource[...]` — RFC 9728 resource metadata;
 * - `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`
 *   — RFC 8414 authorization-server metadata;
 * - `POST /register` — dynamic client registration;
 * - `GET /authorize` — authorization-code + PKCE redirect;
 * - `POST /token` — code exchange and refresh;
 * - `/mcp` — the MCP endpoint, gated on the issued bearer token.
 *
 * This is enough for the SDK's OAuth client to run end to end, which is what the
 * connector's OAuth test asserts.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { z } from 'zod'

/** Write a JSON response. */
function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Write an OAuth error response. */
function oauthError(res, error, description, status = 400) {
  json(res, status, { error, ...(description === undefined ? {} : { error_description: description }) })
}

/** Read a request body as UTF-8 text. */
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** Build the MCP server used by the HTTP fixture. */
function buildServer() {
  const server = new McpServer({ name: 'oauth-fixture', version: '1.0.0' })
  server.registerTool(
    'whoami',
    { description: 'Report that the caller is authenticated', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: 'authorized' }] }),
  )
  server.registerTool(
    'echo',
    { description: 'Echo the given text', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
  )
  return server
}

/**
 * Start the fixture.
 * @param options - `{ requireToken }`.
 * @returns the fixture handle.
 */
export async function startOAuthMcpServer({ requireToken = true, challengeOnly = false } = {}) {
  const state = {
    clients: new Map(),
    codes: new Map(),
    accessTokens: new Set(),
    refreshTokens: new Map(),
    registrations: 0,
    tokenRequests: 0,
    tokenGrants: [],
    authorizations: 0,
    lastAuthorizationHeader: undefined,
    lastMcpAuthorizationHeader: undefined,
  }

  let origin = ''
  const handler = toNodeHandler(createMcpHandler(() => buildServer()))

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin)
      const path = url.pathname

      if (path === '/mcp') {
        state.lastMcpAuthorizationHeader = req.headers.authorization
        if (requireToken) {
          const header = req.headers.authorization ?? ''
          const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
          if (!state.accessTokens.has(token)) {
            res.statusCode = 401
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader(
              'www-authenticate',
              `Bearer resource_metadata="${origin}${challengeOnly ? '/custom/resource-metadata' : '/.well-known/oauth-protected-resource'}"`,
            )
            res.end(JSON.stringify({ error: 'unauthorized' }))
            return
          }
        }
        await handler(req, res)
        return
      }

      const metadataPath = challengeOnly ? '/custom/resource-metadata' : undefined
      if (challengeOnly ? path === metadataPath : path === '/.well-known/oauth-protected-resource' || path.startsWith('/.well-known/oauth-protected-resource/')) {
        json(res, 200, {
          resource: origin,
          authorization_servers: [origin],
          scopes_supported: ['mcp'],
          bearer_methods_supported: ['header'],
          resource_name: 'OAuth MCP fixture',
        })
        return
      }

      if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          scopes_supported: ['mcp'],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        })
        return
      }

      if (path === '/register' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        state.registrations += 1
        const clientId = `client-${state.registrations}`
        state.clients.set(clientId, { redirect_uris: body.redirect_uris ?? [], metadata: body })
        json(res, 201, {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: body.redirect_uris ?? [],
          token_endpoint_auth_method: 'none',
          grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
          response_types: body.response_types ?? ['code'],
          client_name: body.client_name,
        })
        return
      }

      if (path === '/authorize' && req.method === 'GET') {
        state.authorizations += 1
        const clientId = url.searchParams.get('client_id') ?? ''
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        const challenge = url.searchParams.get('code_challenge') ?? ''
        const client = state.clients.get(clientId)
        if (client === undefined) {
          oauthError(res, 'invalid_client', `unknown client ${clientId}`)
          return
        }
        if (!client.redirect_uris.includes(redirectUri)) {
          oauthError(res, 'invalid_request', `redirect_uri ${redirectUri} is not registered`)
          return
        }
        if (challenge === '') {
          oauthError(res, 'invalid_request', 'PKCE code_challenge is required')
          return
        }
        const code = `code-${randomBytes(12).toString('hex')}`
        state.codes.set(code, {
          challenge,
          redirectUri,
          clientId,
          scope: url.searchParams.get('scope') ?? 'mcp',
        })
        const location = new URL(redirectUri)
        location.searchParams.set('code', code)
        const callbackState = url.searchParams.get('state')
        if (callbackState !== null) location.searchParams.set('state', callbackState)
        location.searchParams.set('iss', origin)
        res.statusCode = 302
        res.setHeader('location', location.toString())
        res.end()
        return
      }

      if (path === '/token' && req.method === 'POST') {
        state.tokenRequests += 1
        const body = new URLSearchParams(await readBody(req))
        const grantType = body.get('grant_type')
        state.tokenGrants.push(grantType)
        if (grantType === 'authorization_code') {
          const code = body.get('code') ?? ''
          const record = state.codes.get(code)
          if (record === undefined) {
            oauthError(res, 'invalid_grant', 'unknown or used code')
            return
          }
          const verifier = body.get('code_verifier') ?? ''
          const computed = createHash('sha256').update(verifier).digest('base64url')
          if (computed !== record.challenge) {
            oauthError(res, 'invalid_grant', 'PKCE verification failed')
            return
          }
          state.codes.delete(code)
          const accessToken = `at-${randomBytes(12).toString('hex')}`
          const refreshToken = `rt-${randomBytes(12).toString('hex')}`
          state.accessTokens.add(accessToken)
          state.refreshTokens.set(refreshToken, accessToken)
          json(res, 200, {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refreshToken,
            scope: record.scope,
          })
          return
        }
        if (grantType === 'refresh_token') {
          const refreshToken = body.get('refresh_token') ?? ''
          if (!state.refreshTokens.has(refreshToken)) {
            oauthError(res, 'invalid_grant', 'unknown refresh token')
            return
          }
          const accessToken = `at-${randomBytes(12).toString('hex')}`
          state.accessTokens.add(accessToken)
          json(res, 200, {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refreshToken,
          })
          return
        }
        oauthError(res, 'unsupported_grant_type', grantType ?? 'missing grant_type')
        return
      }

      json(res, 404, { error: 'not_found', path })
    })().catch((error) => {
      if (!res.headersSent) json(res, 500, { error: 'server_error', message: String(error) })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    url: `${origin}/mcp`,
    state,
    async close() {
      await new Promise(resolve => server.close(() => resolve()))
    },
  }
}