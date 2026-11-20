/**
 * The interactive OAuth 2.1 flow for one MCP server.
 *
 * `authorize()` runs discovery and either proves the stored token still works
 * or produces the URL the user must open. The redirect lands on a loopback
 * listener, whose callback validates `state`, redeems the code with PKCE, and
 * notifies the owning connection so it can reconnect. Nothing here blocks a
 * model turn: an authorization that needs a human leaves the server in
 * `authorizing` until the browser comes back.
 *
 * @module dsh-mcp-connector/oauth/flow
 */

import { spawn } from 'node:child_process'
import { auth } from '@modelcontextprotocol/client'
import { startLoopbackServer } from './loopback.js'
import { ConnectorOAuthProvider, clientMetadataFor } from './provider.js'
import { OAuthRecordStore, recordIdForServer } from './store.js'

/**
 * Open a URL in the platform's default browser.
 * @param url - the authorization URL.
 * @param logger - diagnostic sink.
 */
export function openInBrowser(url, logger) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', error => logger.warn(`could not open a browser automatically: ${error.message}`))
    child.unref()
  } catch (error) {
    logger.warn(`could not open a browser automatically: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * One server's OAuth state machine.
 */
export class OAuthFlow {
  /**
   * @param options - `{ entry, credentials, scope, logger, fetchFn }`.
   */
  constructor({ entry, credentials, scope, logger, fetchFn = globalThis.fetch }) {
    this.entry = entry
    this.logger = logger
    this.fetchFn = fetchFn
    this.store = new OAuthRecordStore({
      credentials,
      scope,
      id: recordIdForServer(entry.name),
      serverName: entry.name,
    })
    this.loopback = undefined
    this.provider = undefined
    this.readyPromise = undefined
    this.authorizationUrl = undefined
    /** Notified after a callback redeems the code; the connection reconnects. */
    this.onAuthorized = undefined
  }

  /**
   * Start the loopback listener and build the provider (idempotent).
   * @returns the provider.
   */
  async ready() {
    if (this.provider !== undefined) return this.provider
    this.readyPromise ??= this.#createProvider()
    return this.readyPromise
  }

  /**
   * Build the loopback listener and provider once.
   * @returns the provider.
   */
  async #createProvider() {
    const stored = await this.store.read()
    const preferred = this.entry.auth.callbackPort || stored?.callbackPort || 0
    let loopback
    let redirectChanged = false
    try {
      loopback = await startLoopbackServer({
        port: preferred,
        onCallback: params => this.#handleCallback(params),
      })
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || preferred === 0) throw error
      this.logger.warn(`loopback port ${preferred} is busy; using an ephemeral port for this authorization`)
      loopback = await startLoopbackServer({ port: 0, onCallback: params => this.#handleCallback(params) })
      redirectChanged = true
    }
    this.loopback = loopback
    if (redirectChanged || stored?.callbackPort !== loopback.port) {
      await this.store.update(current => ({
        ...current,
        callbackPort: loopback.port,
        // A changed redirect URI invalidates the dynamic registration.
        ...(redirectChanged ? { clientInformation: undefined } : {}),
      }))
    }
    const authConfig = this.entry.auth
    this.provider = new ConnectorOAuthProvider({
      store: this.store,
      redirectUrl: loopback.url,
      clientId: authConfig.clientId,
      clientSecret: authConfig.clientSecret,
      clientMetadata: clientMetadataFor({
        redirectUrl: loopback.url,
        clientName: authConfig.clientName,
        scopes: authConfig.scopes,
        hasSecret: authConfig.clientSecret !== undefined,
      }),
      onAuthorization: (url) => {
        this.authorizationUrl = url.toString()
        this.logger.warn(`authorization required; open this URL to sign in: ${this.authorizationUrl}`)
        if (this.entry.openBrowser) openInBrowser(this.authorizationUrl, this.logger)
      },
    })
    return this.provider
  }

  /**
   * Ensure an access token exists, starting the interactive flow when needed.
   * @param options - `{ signal }` for cancellation.
   * @returns `{ status: 'authorized' }` or `{ status: 'redirect', url }`.
   */
  async authorize({ signal } = {}) {
    signal?.throwIfAborted()
    const provider = await this.ready()
    const authOptions = {
      serverUrl: this.entry.url,
      scope: this.entry.auth.scopes,
      fetchFn: this.fetchFn,
      skipIssuerMetadataValidation: this.entry.auth.skipIssuerMetadataValidation,
    }
    const result = await auth(provider, authOptions)
    signal?.throwIfAborted()
    if (result === 'AUTHORIZED') return { status: 'authorized' }
    if (this.authorizationUrl === undefined) {
      throw new Error('the authorization server asked for a redirect but produced no authorization URL')
    }
    return { status: 'redirect', url: this.authorizationUrl }
  }

  /**
   * Redeem an authorization callback (loopback or a manually supplied code).
   * @param params - callback search params carrying `code`, `state`, `iss`.
   * @returns `{ status: 'authorized' }`.
   */
  async complete(params) {
    const payload = await this.store.read()
    const expectedState = payload?.state
    const receivedState = params.get('state')
    if (expectedState === undefined) throw new Error('no authorization request is pending for this server')
    if (receivedState !== expectedState) throw new Error('the authorization response state does not match the pending request')
    const error = params.get('error')
    if (error !== null) {
      const description = params.get('error_description') ?? ''
      throw new Error(`the authorization server returned "${error}"${description === '' ? '' : `: ${description}`}`)
    }
    const code = params.get('code')
    if (code === null || code === '') throw new Error('the authorization response carries no code')
    const issuer = params.get('iss') ?? undefined
    const provider = await this.ready()
    const result = await auth(provider, {
      serverUrl: this.entry.url,
      authorizationCode: code,
      iss: issuer,
      scope: this.entry.auth.scopes,
      fetchFn: this.fetchFn,
      skipIssuerMetadataValidation: this.entry.auth.skipIssuerMetadataValidation,
    })
    if (result !== 'AUTHORIZED') throw new Error('the token exchange did not complete')
    this.authorizationUrl = undefined
    this.logger.info('authorization complete; tokens are stored')
    return { status: 'authorized' }
  }

  /**
   * Handle one browser callback and notify the owning connection.
   * @param params - callback search params.
   * @returns page outcome.
   */
  async #handleCallback(params) {
    try {
      const result = await this.complete(params)
      await this.onAuthorized?.(result)
      return {
        ok: true,
        message: 'DeepSeek Harness now has an access token for this server. You can close this window and return to the app.',
      }
    } catch (error) {
      this.logger.warn(`authorization callback failed: ${error instanceof Error ? error.message : String(error)}`)
      return {
        ok: false,
        message: `${error instanceof Error ? error.message : String(error)} — return to DeepSeek Harness and start the authorization again.`,
      }
    }
  }

  /**
   * Whether a stored token set exists.
   * @returns true when tokens are stored.
   */
  async hasTokens() {
    const payload = await this.store.read()
    return payload?.tokens !== undefined
  }

  /** Forget the stored authorization. */
  async logout() {
    await this.store.clear()
    this.authorizationUrl = undefined
  }

  /** Release the loopback listener. */
  async dispose() {
    const loopback = this.loopback
    this.loopback = undefined
    this.provider = undefined
    this.readyPromise = undefined
    this.readyPromise = undefined
    if (loopback !== undefined) await loopback.close()
  }
}