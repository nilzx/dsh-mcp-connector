/**
 * OAuth 2.1 client provider backed by a credential record.
 *
 * Implements the MCP SDK's `OAuthClientProvider` contract: discovery, dynamic
 * client registration, PKCE, token refresh, issuer binding, and invalidation
 * all run inside the SDK; this class only supplies persistence and the one
 * interactive step — telling the caller which URL the user must open.
 *
 * @module dsh-mcp-connector/oauth/provider
 */

import { randomBytes } from 'node:crypto'

/** Default client name shown on the authorization server's consent screen. */
const DEFAULT_CLIENT_NAME = 'DeepSeek Harness MCP connector'

/**
 * Build the OAuth client metadata for one server.
 * @param options - `{ redirectUrl, clientName, scopes, hasSecret }`.
 * @returns the client metadata the SDK registers and sends.
 */
export function clientMetadataFor({ redirectUrl, clientName, scopes, hasSecret }) {
  return {
    client_name: clientName ?? DEFAULT_CLIENT_NAME,
    redirect_uris: [String(redirectUrl)],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: hasSecret ? 'client_secret_post' : 'none',
    ...(scopes === undefined ? {} : { scope: scopes }),
  }
}

/**
 * Persisted OAuth client state for one MCP server.
 */
export class ConnectorOAuthProvider {
  /**
   * @param options - `{ store, redirectUrl, clientMetadata, clientId, clientSecret, onAuthorization }`.
   */
  constructor({ store, redirectUrl, clientMetadata, clientId, clientSecret, onAuthorization }) {
    this.store = store
    this.url = redirectUrl
    this.metadata = clientMetadata
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.onAuthorization = onAuthorization
    this.pendingState = undefined
  }

  /** @returns the loopback callback URL registered with the authorization server. */
  get redirectUrl() {
    return this.url
  }

  /** @returns the metadata sent to dynamic client registration. */
  get clientMetadata() {
    return this.metadata
  }

  /**
   * Generate the CSRF `state` value for one authorization request.
   * @returns an unguessable value; persisted with the PKCE verifier.
   */
  state() {
    this.pendingState = randomBytes(16).toString('base64url')
    return this.pendingState
  }

  /**
   * Return the registered client, either configured or dynamically registered.
   * @returns stored client information, or undefined before registration.
   */
  async clientInformation() {
    if (this.clientId !== undefined) {
      return this.clientSecret === undefined
        ? { client_id: this.clientId }
        : { client_id: this.clientId, client_secret: this.clientSecret }
    }
    const payload = await this.store.read()
    return payload?.clientInformation
  }

  /**
   * Persist a dynamic client registration.
   * @param info - the registration result.
   */
  async saveClientInformation(info) {
    if (this.clientId !== undefined) return
    await this.store.update(current => ({ ...current, clientInformation: info }))
  }

  /** @returns the stored token set, if any. */
  async tokens() {
    const payload = await this.store.read()
    return payload?.tokens
  }

  /**
   * Persist a token set and finish the pending interactive step.
   * @param tokens - the exchanged tokens.
   */
  async saveTokens(tokens) {
    await this.store.update(current => ({
      ...current,
      tokens,
      codeVerifier: undefined,
      state: undefined,
      authorizationUrl: undefined,
    }))
  }

  /**
   * Persist the PKCE verifier for the callback leg.
   * @param verifier - the code verifier.
   */
  async saveCodeVerifier(verifier) {
    await this.store.update(current => ({ ...current, codeVerifier: verifier, state: this.pendingState }))
  }

  /** @returns the PKCE verifier saved for the pending authorization. */
  async codeVerifier() {
    const payload = await this.store.read()
    if (payload?.codeVerifier === undefined) {
      throw new Error('no PKCE code verifier is stored for this server; restart the authorization flow')
    }
    return payload.codeVerifier
  }

  /**
   * Record the URL the user must open and notify the owning connection.
   * @param url - the authorization URL built by the SDK.
   */
  async redirectToAuthorization(url) {
    await this.store.update(current => ({ ...current, authorizationUrl: url.toString() }))
    this.onAuthorization?.(url)
  }

  /**
   * Drop credentials the authorization server declared invalid.
   * @param scope - which stored material to invalidate.
   */
  async invalidateCredentials(scope) {
    await this.store.invalidate(scope)
  }

  /** @returns the cached discovery snapshot, when one is stored. */
  async discoveryState() {
    const payload = await this.store.read()
    return payload?.discoveryState
  }

  /**
   * Persist the discovery snapshot used to bind the callback leg to one issuer.
   * @param state - the snapshot from the SDK.
   */
  async saveDiscoveryState(state) {
    await this.store.update(current => ({ ...current, discoveryState: state }))
  }

  /**
   * Remember the RFC 8707 resource indicator.
   * @param resource - the resource URL.
   */
  async saveResourceUrl(resource) {
    await this.store.update(current => ({ ...current, resourceUrl: resource }))
  }

  /** @returns the last RFC 8707 resource indicator. */
  async resourceUrl() {
    const payload = await this.store.read()
    return payload?.resourceUrl
  }

  /**
   * Remember the authorization-server issuer (deprecated by the SDK; kept for
   * providers that read it back).
   * @param issuer - the issuer identifier.
   */
  async saveAuthorizationServerUrl(issuer) {
    await this.store.update(current => ({ ...current, issuer }))
  }

  /** @returns the remembered issuer. */
  async authorizationServerUrl() {
    const payload = await this.store.read()
    return payload?.issuer
  }
}