/**
 * Browser half of dsh-mcp-connector: the configuration panel in Settings.
 *
 * The panel renders into `settings.section` and talks to the Host half over
 * same-origin JSON routes (`/mcp-connector/api/...`). The Host validates every
 * write with the same loader used at startup and persists it through the
 * ConfigEditor, so saving here behaves exactly like editing the profile patch.
 *
 * This file is shipped as-is (no build step): the module loader provides React
 * and this module registers one lazy slot factory.
 */

window.__ModuleLoader__.load({
  id: '@nilzx/dsh-mcp-connector',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const NS = 'mcpConnector'
    const STATE_URL = '/mcp-connector/api/state'
    const CONFIG_URL = '/mcp-connector/api/config'
    const ACTION_URL = '/mcp-connector/api/action'
    const POLICIES = ['allow', 'ask', 'deny', 'off']
    const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

    /* ------------------------------------------------------------------ */
    /* Dictionaries                                                        */
    /* ------------------------------------------------------------------ */

    const en = {
      title: 'MCP connector',
      subtitle: 'Connect MCP servers and choose what each tool may do. Tools appear to the agent as mcp__<server>__<tool>.',
      addServer: 'Add server',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      refresh: 'Refresh status',
      unsaved: 'Unsaved changes',
      saved: 'Configuration saved. Reconnecting…',
      emptyTitle: 'No MCP servers yet',
      emptyBody: 'Add a local process or a remote endpoint. You can change everything here later; nothing is written until you save.',
      noEditor: 'This profile has no configuration editor. Edit the plugin configuration in cordis.patch.yml instead.',
      loadFailed: 'Could not load the configuration.',
      saveFailed: 'Could not save the configuration.',
      savedButUnverified: 'Save was sent, but the connection dropped while the plugin reloaded. Refresh to check.',
      retry: 'Retry',
      remove: 'Remove',
      removeConfirm: 'Remove this server?',
      expand: 'Show settings',
      collapse: 'Hide settings',
      enabled: 'Enabled',
      disabled: 'Disabled',
      name: 'Server name',
      nameHint: 'Letters, digits, “_” and “-”; at most 32 characters. Used in tool names.',
      transport: 'Connection',
      transportStdio: 'Local process (stdio)',
      transportHttp: 'Remote endpoint (Streamable HTTP)',
      transportSse: 'Remote endpoint (legacy SSE)',
      command: 'Command',
      commandHint: 'Executable started for this server, for example npx.',
      args: 'Arguments',
      argsHint: 'One argument per line.',
      cwd: 'Working directory',
      cwdHint: 'Optional. Empty means the Harness working directory.',
      env: 'Environment',
      envHint: 'Passed to the process. Use ${credential:NAME} to read a stored secret.',
      url: 'Endpoint URL',
      urlHint: 'The MCP endpoint, for example https://mcp.example.com/mcp.',
      headers: 'Headers',
      headersHint: 'Sent with every request. Use ${credential:NAME} for secrets.',
      auth: 'Sign-in',
      authNone: 'No sign-in',
      authBearer: 'Access token',
      authOauth: 'OAuth',
      token: 'Token',
      tokenHint: 'Sent as “Authorization: Bearer …”. Prefer ${credential:NAME}.',
      scopes: 'Scopes',
      scopesHint: 'Optional, space separated. Used by OAuth.',
      clientId: 'Client ID',
      clientIdHint: 'Optional. Leave empty to register automatically.',
      clientSecret: 'Client secret',
      clientSecretHint: 'Optional. Prefer ${credential:NAME}.',
      callbackPort: 'Callback port',
      callbackPortHint: 'Optional fixed local port for the OAuth callback.',
      resource: 'Resource',
      resourceHint: 'Optional OAuth resource indicator (RFC 8707).',
      oauthBrowser: 'Open the sign-in page automatically',
      tools: 'Tool permissions',
      toolsDefault: 'Everything else',
      toolsHint: 'Rules run in order; the first matching pattern wins. “*” matches any characters.',
      rulePattern: 'Tool name or pattern',
      rulePolicy: 'Permission',
      addRule: 'Add rule',
      add: 'Add',
      policyAllow: 'Allow',
      policyAsk: 'Ask',
      policyDeny: 'Block',
      policyOff: 'Hide',
      timeout: 'Tool call timeout (ms)',
      startupTimeout: 'Connect timeout (ms)',
      reconnect: 'Reconnect automatically',
      reconnectAttempts: 'Attempts',
      advanced: 'Advanced',
      status: 'Status',
      toolCount: '{count} tools',
      toolCountOne: '1 tool',
      noTools: 'No tools yet',
      authorize: 'Sign in',
      reauthorize: 'Sign in again',
      reconnectNow: 'Reconnect',
      logout: 'Forget sign-in',
      authUrl: 'Open the sign-in page',
      pending: 'Waiting for sign-in',
      globalOptions: 'Options',
      failOnStartup: 'Refuse to start when a server cannot connect',
      failOnStartupHint: 'Otherwise the Harness starts and the server keeps retrying in the background.',
      openBrowser: 'Open OAuth sign-in pages automatically',
      state_idle: 'Idle',
      state_connecting: 'Connecting',
      state_connected: 'Connected',
      state_authorizing: 'Needs sign-in',
      state_reconnecting: 'Reconnecting',
      state_failed: 'Failed',
      state_disconnected: 'Signed out',
      state_disabled: 'Disabled',
      state_disposed: 'Unloaded',
      state_none: 'Not saved yet',
      lastError: 'Last error',
      nameRequired: 'Every server needs a name.',
      nameInvalid: 'Server names use letters, digits, “_” and “-”, at most 32 characters.',
      nameDuplicate: 'Two servers cannot share a name.',
      commandRequired: 'A local process needs a command.',
      urlRequired: 'A remote endpoint needs a URL.',
      urlInvalid: 'The endpoint must start with http:// or https://.',
      portInvalid: 'The callback port must be a number between 0 and 65535.',
      numberInvalid: 'This value must be a positive number.',
    }

    const zh = {
      title: 'MCP 连接器',
      subtitle: '连接 MCP 服务器，并为每个工具单独设置权限。工具会以 mcp__<服务器>__<工具> 的形式提供给智能体。',
      addServer: '添加服务器',
      save: '保存',
      saving: '正在保存…',
      discard: '放弃修改',
      refresh: '刷新状态',
      unsaved: '有未保存的修改',
      saved: '配置已保存，正在重新连接…',
      emptyTitle: '还没有 MCP 服务器',
      emptyBody: '可以添加本地进程或远程端点。之后随时可以在这里修改；保存之前不会写入任何内容。',
      noEditor: '当前配置没有配置编辑器，请改为编辑 cordis.patch.yml。',
      loadFailed: '无法加载配置。',
      saveFailed: '无法保存配置。',
      savedButUnverified: '保存请求已发出，但插件重载时连接中断。请刷新确认。',
      retry: '重试',
      remove: '删除',
      removeConfirm: '确定删除这个服务器吗？',
      expand: '展开设置',
      collapse: '收起设置',
      enabled: '已启用',
      disabled: '已停用',
      name: '服务器名称',
      nameHint: '字母、数字、“_”和“-”，最多 32 个字符，会出现在工具名里。',
      transport: '连接方式',
      transportStdio: '本地进程（stdio）',
      transportHttp: '远程端点（Streamable HTTP）',
      transportSse: '远程端点（旧版 SSE）',
      command: '命令',
      commandHint: '启动服务器的可执行文件，例如 npx。',
      args: '参数',
      argsHint: '每行一个参数。',
      cwd: '工作目录',
      cwdHint: '可选，留空表示 Harness 的工作目录。',
      env: '环境变量',
      envHint: '传给子进程。可用 ${credential:名称} 读取已保存的密钥。',
      url: '端点地址',
      urlHint: 'MCP 端点，例如 https://mcp.example.com/mcp。',
      headers: '请求头',
      headersHint: '每次请求都会带上。密钥请用 ${credential:名称}。',
      auth: '登录方式',
      authNone: '不需要登录',
      authBearer: '访问令牌',
      authOauth: 'OAuth 登录',
      token: '令牌',
      tokenHint: '以“Authorization: Bearer …”发送。建议使用 ${credential:名称}。',
      scopes: '授权范围',
      scopesHint: '可选，用空格分隔，供 OAuth 使用。',
      clientId: '客户端 ID',
      clientIdHint: '可选，留空则自动注册。',
      clientSecret: '客户端密钥',
      clientSecretHint: '可选，建议使用 ${credential:名称}。',
      callbackPort: '回调端口',
      callbackPortHint: '可选，指定 OAuth 回调使用的本地端口。',
      resource: '资源标识',
      resourceHint: '可选，OAuth 的 resource 参数（RFC 8707）。',
      oauthBrowser: '自动打开登录页面',
      tools: '工具权限',
      toolsDefault: '其余工具',
      toolsHint: '规则按顺序生效，第一个匹配的规则优先；“*”可匹配任意字符。',
      rulePattern: '工具名或匹配模式',
      rulePolicy: '权限',
      addRule: '添加规则',
      add: '添加',
      policyAllow: '允许',
      policyAsk: '询问',
      policyDeny: '禁止',
      policyOff: '隐藏',
      timeout: '工具调用超时（毫秒）',
      startupTimeout: '连接超时（毫秒）',
      reconnect: '自动重连',
      reconnectAttempts: '重试次数',
      advanced: '高级选项',
      status: '状态',
      toolCount: '{count} 个工具',
      toolCountOne: '1 个工具',
      noTools: '暂无工具',
      authorize: '登录',
      reauthorize: '重新登录',
      reconnectNow: '重连',
      logout: '忘记登录',
      authUrl: '打开登录页面',
      pending: '等待登录中',
      globalOptions: '全局选项',
      failOnStartup: '有服务器连不上时拒绝启动',
      failOnStartupHint: '关闭后 Harness 仍会启动，该服务器会在后台持续重试。',
      openBrowser: '自动打开 OAuth 登录页面',
      state_idle: '空闲',
      state_connecting: '连接中',
      state_connected: '已连接',
      state_authorizing: '需要登录',
      state_reconnecting: '重连中',
      state_failed: '失败',
      state_disconnected: '已退出登录',
      state_disabled: '已停用',
      state_disposed: '已卸载',
      state_none: '尚未保存',
      lastError: '最近一次错误',
      nameRequired: '每个服务器都需要名称。',
      nameInvalid: '服务器名称只能用字母、数字、“_”和“-”，最多 32 个字符。',
      nameDuplicate: '两个服务器不能使用同一个名称。',
      commandRequired: '本地进程需要填写命令。',
      urlRequired: '远程端点需要填写地址。',
      urlInvalid: '端点地址必须以 http:// 或 https:// 开头。',
      portInvalid: '回调端口必须是 0 到 65535 之间的数字。',
      numberInvalid: '该项必须是正数。',
    }

    /* ------------------------------------------------------------------ */
    /* Small helpers                                                       */
    /* ------------------------------------------------------------------ */

    let uidCounter = 0
    const uid = () => `s${++uidCounter}`

    const clone = value => JSON.parse(JSON.stringify(value))
    const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

    /** Split a textarea value into trimmed non-empty lines. */
    const lines = text => text.split('\n').map(line => line.trim()).filter(line => line !== '')

    /** Key/value rows to an object, dropping empty keys and duplicate keys. */
    function rowsToObject(rows) {
      const result = {}
      for (const row of rows) {
        const key = row.key.trim()
        if (key === '') continue
        result[key] = row.value
      }
      return result
    }

    /** An object to key/value rows. */
    const objectToRows = value => Object.entries(isObject(value) ? value : {})
      .map(([key, entry]) => ({ key, value: String(entry) }))

    /** Number text to a number, or undefined when empty or invalid. */
    function numberText(text) {
      const trimmed = String(text).trim()
      if (trimmed === '') return undefined
      const value = Number(trimmed)
      return Number.isFinite(value) ? value : undefined
    }

    /** One normalized server draft. */
    function serverDraft(name, value) {
      const source = isObject(value) ? value : {}
      const auth = isObject(source.auth) ? source.auth : {}
      const tools = isObject(source.tools) ? source.tools : {}
      const rules = isObject(tools.rules) ? tools.rules : {}
      const reconnect = isObject(source.reconnect) ? source.reconnect : {}
      return {
        key: uid(),
        name,
        originalName: name,
        original: clone(source),
        expanded: false,
        advanced: false,
        enabled: source.enabled !== false,
        transport: source.transport === 'stdio' ? 'stdio' : source.transport === 'sse' ? 'sse' : 'streamable-http',
        command: typeof source.command === 'string' ? source.command : '',
        argsText: Array.isArray(source.args) ? source.args.join('\n') : '',
        cwd: typeof source.cwd === 'string' ? source.cwd : '',
        envRows: objectToRows(source.env),
        url: typeof source.url === 'string' ? source.url : '',
        headerRows: objectToRows(source.headers),
        authType: auth.type === 'bearer' || auth.type === 'oauth' ? auth.type : 'none',
        token: typeof auth.token === 'string' ? auth.token : '',
        scopes: Array.isArray(auth.scopes) ? auth.scopes.join(' ') : typeof auth.scopes === 'string' ? auth.scopes : '',
        clientId: typeof auth.clientId === 'string' ? auth.clientId : '',
        clientSecret: typeof auth.clientSecret === 'string' ? auth.clientSecret : '',
        callbackPort: auth.callbackPort === undefined ? '' : String(auth.callbackPort),
        resource: typeof auth.resource === 'string' ? auth.resource : '',
        oauthBrowser: auth.openBrowser !== false,
        toolsDefault: POLICIES.includes(tools.default) ? tools.default : 'allow',
        rules: Object.entries(rules).map(([pattern, policy]) => ({ key: uid(), pattern, policy })),
        toolCallTimeout: source.toolCallTimeoutMs === undefined ? '' : String(source.toolCallTimeoutMs),
        startupTimeout: source.startupTimeoutMs === undefined ? '' : String(source.startupTimeoutMs),
        reconnectEnabled: reconnect.enabled !== false,
        reconnectAttempts: reconnect.maxAttempts === undefined ? '' : String(reconnect.maxAttempts),
      }
    }

    /** Whole-config draft. */
    function draftFromConfig(config) {
      const servers = isObject(config?.servers) ? config.servers : {}
      return {
        failOnStartupError: config?.failOnStartupError === true,
        openBrowser: config?.openBrowser !== false,
        servers: Object.entries(servers).map(([name, value]) => serverDraft(name, value)),
      }
    }

    /** One server draft back to configuration, preserving fields the form does not show. */
    function serverConfig(draft) {
      const value = clone(draft.original)
      value.enabled = draft.enabled
      value.transport = draft.transport
      for (const key of ['command', 'args', 'env', 'cwd', 'url', 'headers', 'auth']) delete value[key]

      if (draft.transport === 'stdio') {
        value.command = draft.command.trim()
        const args = lines(draft.argsText)
        if (args.length > 0) value.args = args
        const env = rowsToObject(draft.envRows)
        if (Object.keys(env).length > 0) value.env = env
        if (draft.cwd.trim() !== '') value.cwd = draft.cwd.trim()
      } else {
        value.url = draft.url.trim()
        const headers = rowsToObject(draft.headerRows)
        if (Object.keys(headers).length > 0) value.headers = headers
        if (draft.authType === 'bearer') {
          value.auth = { type: 'bearer', token: draft.token.trim() }
        } else if (draft.authType === 'oauth') {
          const auth = { type: 'oauth' }
          const scopes = lines(draft.scopes.replace(/,/g, '\n')).join(' ')
          if (scopes !== '') auth.scopes = scopes
          if (draft.clientId.trim() !== '') auth.clientId = draft.clientId.trim()
          if (draft.clientSecret.trim() !== '') auth.clientSecret = draft.clientSecret.trim()
          const port = numberText(draft.callbackPort)
          if (port !== undefined) auth.callbackPort = port
          if (draft.resource.trim() !== '') auth.resource = draft.resource.trim()
          if (!draft.oauthBrowser) auth.openBrowser = false
          value.auth = auth
        }
      }

      const tools = { default: draft.toolsDefault }
      const rules = {}
      for (const rule of draft.rules) {
        const pattern = rule.pattern.trim()
        if (pattern === '') continue
        rules[pattern] = rule.policy
      }
      if (Object.keys(rules).length > 0) tools.rules = rules
      value.tools = tools

      const timeout = numberText(draft.toolCallTimeout)
      if (timeout !== undefined) value.toolCallTimeoutMs = timeout
      else delete value.toolCallTimeoutMs
      const startup = numberText(draft.startupTimeout)
      if (startup !== undefined) value.startupTimeoutMs = startup
      else delete value.startupTimeoutMs

      const reconnect = isObject(value.reconnect) ? { ...value.reconnect } : {}
      reconnect.enabled = draft.reconnectEnabled
      const attempts = numberText(draft.reconnectAttempts)
      if (attempts !== undefined) reconnect.maxAttempts = attempts
      else delete reconnect.maxAttempts
      if (Object.keys(reconnect).length > 0) value.reconnect = reconnect
      else delete value.reconnect

      return value
    }

    /** Whole draft back to configuration. */
    function configFromDraft(draft) {
      const servers = {}
      for (const server of draft.servers) {
        servers[server.name.trim()] = serverConfig(server)
      }
      const config = { servers }
      if (draft.failOnStartupError) config.failOnStartupError = true
      if (!draft.openBrowser) config.openBrowser = false
      return config
    }

    /** Client-side validation; returns the first message or null. */
    function validateDraft(draft, t) {
      const seen = new Set()
      for (const server of draft.servers) {
        const name = server.name.trim()
        if (name === '') return t('nameRequired')
        if (!SERVER_NAME.test(name)) return t('nameInvalid')
        const folded = name.toLowerCase()
        if (seen.has(folded)) return t('nameDuplicate')
        seen.add(folded)
        if (server.transport === 'stdio' && server.command.trim() === '') return t('commandRequired')
        if (server.transport !== 'stdio') {
          const url = server.url.trim()
          if (url === '') return t('urlRequired')
          if (!/^https?:\/\/\S+$/i.test(url)) return t('urlInvalid')
        }
        if (server.authType === 'oauth' && server.callbackPort.trim() !== '') {
          const port = numberText(server.callbackPort)
          if (port === undefined || port < 0 || port > 65535) return t('portInvalid')
        }
      }
      return null
    }

    /* ------------------------------------------------------------------ */
    /* Host API                                                            */
    /* ------------------------------------------------------------------ */

    /** Fetch JSON, with a readable error for non-2xx answers. */
    async function api(url, init) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok || body?.ok === false) {
        const message = body?.error ?? `HTTP ${response.status}`
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      return body
    }

    /** Read the panel state, retrying briefly while the plugin reloads. */
    async function loadState({ attempts = 5 } = {}) {
      let lastError
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await api(STATE_URL)
        } catch (error) {
          lastError = error
          if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 300 + attempt * 250))
        }
      }
      throw lastError
    }

    /* ------------------------------------------------------------------ */
    /* Components                                                          */
    /* ------------------------------------------------------------------ */

    /** One labelled form control. */
    function Field({ id, label, hint, children }) {
      return h('div', { className: 'mcx-field' },
        h('label', { className: 'mcx-label', htmlFor: id }, label),
        children,
        hint === undefined ? null : h('p', { className: 'mcx-hint' }, hint))
    }

    /** A text input bound to a getter/setter. */
    function TextInput({ id, value, onChange, placeholder, disabled, mono, inputMode }) {
      return h('input', {
        id,
        type: 'text',
        className: `mcx-input${mono ? ' mcx-mono' : ''}`,
        value,
        placeholder,
        disabled,
        inputMode,
        onChange: event => onChange(event.target.value),
        spellCheck: false,
      })
    }

    /** A select bound to a getter/setter. */
    function Select({ id, value, onChange, options, disabled }) {
      return h('select', {
        id,
        className: 'mcx-input mcx-select',
        value,
        disabled,
        onChange: event => onChange(event.target.value),
      }, options.map(option => h('option', { key: option.value, value: option.value }, option.label)))
    }

    /** A checkbox row. */
    function Check({ checked, onChange, label, disabled }) {
      return h('label', { className: 'mcx-check' },
        h('input', { type: 'checkbox', checked, disabled, onChange: event => onChange(event.target.checked) }),
        h('span', {}, label))
    }

    /** A key/value editor for env and header maps. */
    function RowsEditor({ rows, onChange, t, disabled, keyPlaceholder, valuePlaceholder }) {
      const update = (key, patch) => onChange(rows.map(row => (row.key === key ? { ...row, ...patch } : row)))
      return h('div', { className: 'mcx-rows' }, rows.map(row => h('div', { className: 'mcx-row', key: row.key },
        h('input', {
          className: 'mcx-input mcx-mono mcx-row-key',
          value: row.key,
          placeholder: keyPlaceholder,
          disabled,
          spellCheck: false,
          onChange: event => update(row.key, { key: event.target.value }),
        }),
        h('input', {
          className: 'mcx-input mcx-mono mcx-row-value',
          value: row.value,
          placeholder: valuePlaceholder,
          disabled,
          spellCheck: false,
          onChange: event => update(row.key, { value: event.target.value }),
        }),
        h('button', {
          type: 'button',
          className: 'mcx-icon',
          title: t('remove'),
          'aria-label': t('remove'),
          disabled,
          onClick: () => onChange(rows.filter(candidate => candidate.key !== row.key)),
        }, '×'))),
      h('button', {
        type: 'button',
        className: 'mcx-link-button',
        disabled,
        onClick: () => onChange([...rows, { key: uid(), value: '' }]),
      }, `+ ${t('add')}`))
    }

    /** A status pill. */
    function StatePill({ state, t }) {
      const key = `state_${state ?? 'none'}`
      const label = t(key) === key ? state : t(key)
      const tone = state === 'connected' ? 'ok'
        : state === 'authorizing' ? 'warn'
          : state === 'failed' ? 'bad'
            : state === 'reconnecting' || state === 'connecting' ? 'busy'
              : 'idle'
      return h('span', { className: `mcx-pill mcx-pill-${tone}` }, label)
    }

    /** The tool-permission rules editor. */
    function RulesEditor({ server, update, t, disabled }) {
      const policyOptions = [
        { value: 'allow', label: t('policyAllow') },
        { value: 'ask', label: t('policyAsk') },
        { value: 'deny', label: t('policyDeny') },
        { value: 'off', label: t('policyOff') },
      ]
      return h('div', { className: 'mcx-rules' },
        h(Field, { id: `mcx-default-${server.key}`, label: t('toolsDefault'), hint: t('toolsHint') },
          h(Select, {
            id: `mcx-default-${server.key}`,
            value: server.toolsDefault,
            options: policyOptions,
            disabled,
            onChange: value => update({ toolsDefault: value }),
          })),
        server.rules.map(rule => h('div', { className: 'mcx-rule', key: rule.key },
          h('input', {
            className: 'mcx-input mcx-mono',
            value: rule.pattern,
            placeholder: 'delete_*',
            disabled,
            spellCheck: false,
            'aria-label': t('rulePattern'),
            onChange: event => update({
              rules: server.rules.map(candidate => (candidate.key === rule.key ? { ...candidate, pattern: event.target.value } : candidate)),
            }),
          }),
          h('select', {
            className: 'mcx-input mcx-select',
            value: rule.policy,
            disabled,
            'aria-label': t('rulePolicy'),
            onChange: event => update({
              rules: server.rules.map(candidate => (candidate.key === rule.key ? { ...candidate, policy: event.target.value } : candidate)),
            }),
          }, policyOptions.map(option => h('option', { key: option.value, value: option.value }, option.label))),
          h('button', {
            type: 'button',
            className: 'mcx-icon',
            title: t('remove'),
            'aria-label': t('remove'),
            disabled,
            onClick: () => update({ rules: server.rules.filter(candidate => candidate.key !== rule.key) }),
          }, '×'))),
        h('button', {
          type: 'button',
          className: 'mcx-link-button',
          disabled,
          onClick: () => update({ rules: [...server.rules, { key: uid(), pattern: '', policy: 'allow' }] }),
        }, `+ ${t('addRule')}`))
    }

    /** The identity row: name and connection style. */
    function IdentityFields({ server, update, t, disabled, id }) {
      return h('div', { className: 'mcx-grid' },
        h(Field, { id: id('name'), label: t('name'), hint: t('nameHint') },
          h(TextInput, {
            id: id('name'),
            value: server.name,
            mono: true,
            disabled,
            onChange: value => update({ name: value }),
          })),
        h(Field, { id: id('transport'), label: t('transport') },
          h(Select, {
            id: id('transport'),
            value: server.transport,
            options: [
              { value: 'streamable-http', label: t('transportHttp') },
              { value: 'stdio', label: t('transportStdio') },
              { value: 'sse', label: t('transportSse') },
            ],
            disabled,
            onChange: value => update({ transport: value }),
          })))
    }

    /** Local-process fields. */
    function ProcessFields({ server, update, t, disabled, id }) {
      return h('div', { className: 'mcx-grid' },
        h(Field, { id: id('command'), label: t('command'), hint: t('commandHint') },
          h(TextInput, {
            id: id('command'),
            value: server.command,
            mono: true,
            disabled,
            placeholder: 'npx',
            onChange: value => update({ command: value }),
          })),
        h(Field, { id: id('cwd'), label: t('cwd'), hint: t('cwdHint') },
          h(TextInput, {
            id: id('cwd'),
            value: server.cwd,
            mono: true,
            disabled,
            onChange: value => update({ cwd: value }),
          })),
        h(Field, { id: id('args'), label: t('args'), hint: t('argsHint') },
          h('textarea', {
            id: id('args'),
            className: 'mcx-input mcx-mono mcx-textarea',
            value: server.argsText,
            disabled,
            rows: 3,
            spellCheck: false,
            placeholder: '-y\n@modelcontextprotocol/server-github',
            onChange: event => update({ argsText: event.target.value }),
          })),
        h(Field, { id: id('env'), label: t('env'), hint: t('envHint') },
          h(RowsEditor, {
            rows: server.envRows,
            t,
            disabled,
            keyPlaceholder: 'NAME',
            valuePlaceholder: '${credential:NAME}',
            onChange: rows => update({ envRows: rows }),
          })))
    }

    /** Remote-endpoint fields. */
    function EndpointFields({ server, update, t, disabled, id }) {
      return h('div', { className: 'mcx-grid' },
        h(Field, { id: id('url'), label: t('url'), hint: t('urlHint') },
          h(TextInput, {
            id: id('url'),
            value: server.url,
            mono: true,
            disabled,
            placeholder: 'https://mcp.example.com/mcp',
            onChange: value => update({ url: value }),
          })),
        h(Field, { id: id('headers'), label: t('headers'), hint: t('headersHint') },
          h(RowsEditor, {
            rows: server.headerRows,
            t,
            disabled,
            keyPlaceholder: 'X-Header',
            valuePlaceholder: 'value',
            onChange: rows => update({ headerRows: rows }),
          })))
    }

    /** Sign-in fields for an HTTP endpoint. */
    function AuthFields({ server, update, t, disabled, id }) {
      const oauth = server.authType === 'oauth'
      return h('div', { className: 'mcx-panel' },
        h(Field, { id: id('auth'), label: t('auth') },
          h(Select, {
            id: id('auth'),
            value: server.authType,
            options: [
              { value: 'none', label: t('authNone') },
              { value: 'bearer', label: t('authBearer') },
              { value: 'oauth', label: t('authOauth') },
            ],
            disabled,
            onChange: value => update({ authType: value }),
          })),
        server.authType === 'bearer'
          ? h(Field, { id: id('token'), label: t('token'), hint: t('tokenHint') },
              h(TextInput, {
                id: id('token'),
                value: server.token,
                mono: true,
                disabled,
                placeholder: '${credential:MCP_TOKEN}',
                onChange: value => update({ token: value }),
              }))
          : null,
        oauth
          ? h('div', { className: 'mcx-grid' },
              h(Field, { id: id('scopes'), label: t('scopes'), hint: t('scopesHint') },
                h(TextInput, {
                  id: id('scopes'),
                  value: server.scopes,
                  mono: true,
                  disabled,
                  onChange: value => update({ scopes: value }),
                })),
              h(Field, { id: id('clientId'), label: t('clientId'), hint: t('clientIdHint') },
                h(TextInput, {
                  id: id('clientId'),
                  value: server.clientId,
                  mono: true,
                  disabled,
                  onChange: value => update({ clientId: value }),
                })),
              h(Field, { id: id('clientSecret'), label: t('clientSecret'), hint: t('clientSecretHint') },
                h(TextInput, {
                  id: id('clientSecret'),
                  value: server.clientSecret,
                  mono: true,
                  disabled,
                  onChange: value => update({ clientSecret: value }),
                })),
              h(Field, { id: id('callbackPort'), label: t('callbackPort'), hint: t('callbackPortHint') },
                h(TextInput, {
                  id: id('callbackPort'),
                  value: server.callbackPort,
                  inputMode: 'numeric',
                  disabled,
                  onChange: value => update({ callbackPort: value }),
                })),
              h(Field, { id: id('resource'), label: t('resource'), hint: t('resourceHint') },
                h(TextInput, {
                  id: id('resource'),
                  value: server.resource,
                  mono: true,
                  disabled,
                  onChange: value => update({ resource: value }),
                })),
              h('div', { className: 'mcx-field' },
                h(Check, {
                  checked: server.oauthBrowser,
                  disabled,
                  label: t('oauthBrowser'),
                  onChange: value => update({ oauthBrowser: value }),
                })))
          : null)
    }

    /** Timeouts and reconnect policy. */
    function AdvancedFields({ server, update, t, disabled, id }) {
      if (!server.advanced) return null
      return h('div', { className: 'mcx-grid mcx-grid-3' },
        h(Field, { id: id('toolTimeout'), label: t('timeout') },
          h(TextInput, {
            id: id('toolTimeout'),
            value: server.toolCallTimeout,
            inputMode: 'numeric',
            disabled,
            placeholder: '60000',
            onChange: value => update({ toolCallTimeout: value }),
          })),
        h(Field, { id: id('startupTimeout'), label: t('startupTimeout') },
          h(TextInput, {
            id: id('startupTimeout'),
            value: server.startupTimeout,
            inputMode: 'numeric',
            disabled,
            placeholder: '30000',
            onChange: value => update({ startupTimeout: value }),
          })),
        h('div', { className: 'mcx-field' },
          h(Check, {
            checked: server.reconnectEnabled,
            disabled,
            label: t('reconnect'),
            onChange: value => update({ reconnectEnabled: value }),
          }),
          h(Field, { id: id('attempts'), label: t('reconnectAttempts') },
            h(TextInput, {
              id: id('attempts'),
              value: server.reconnectAttempts,
              inputMode: 'numeric',
              disabled,
              placeholder: '10',
              onChange: value => update({ reconnectAttempts: value }),
            }))))
    }

    /** Live status of a saved server, with its runtime actions. */
    function RuntimePanel({ server, runtime, t, editable, act, busy }) {
      if (runtime === undefined) return null
      const oauth = server.authType === 'oauth'
      return h('div', { className: 'mcx-runtime' },
        h('div', { className: 'mcx-runtime-head' },
          h('span', { className: 'mcx-runtime-label' }, t('status')),
          h(StatePill, { state: runtime.state, t }),
          runtime.serverVersion === undefined ? null : h('span', { className: 'mcx-meta-text' }, runtime.serverVersion)),
        runtime.lastError === undefined ? null : h('p', { className: 'mcx-error-text' }, `${t('lastError')}: ${runtime.lastError}`),
        runtime.authorizationUrl === undefined ? null : h('p', { className: 'mcx-runtime-row' },
          h('a', {
            className: 'mcx-link',
            href: runtime.authorizationUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
          }, t('authUrl'))),
        h('div', { className: 'mcx-runtime-actions' },
          oauth
            ? h('button', {
                type: 'button',
                className: 'mcx-button',
                disabled: !editable || busy,
                onClick: () => act('authorize', server.originalName),
              }, runtime.state === 'authorizing' ? t('reauthorize') : t('authorize'))
            : null,
          h('button', {
            type: 'button',
            className: 'mcx-button',
            disabled: !editable || busy,
            onClick: () => act('reconnect', server.originalName),
          }, t('reconnectNow')),
          oauth
            ? h('button', {
                type: 'button',
                className: 'mcx-button mcx-danger',
                disabled: !editable || busy,
                onClick: () => act('logout', server.originalName),
              }, t('logout'))
            : null))
    }

    /** One server card. */
    function ServerCard({ server, runtime, update, remove, t, editable, act, busy, dupe }) {
      const id = suffix => `mcx-${server.key}-${suffix}`
      const disabled = !editable
      const stdio = server.transport === 'stdio'
      const toolCount = runtime?.toolCount ?? 0
      return h('section', { className: `mcx-card${server.enabled ? '' : ' mcx-card-off'}` },
        h('header', { className: 'mcx-card-head' },
          h('button', {
            type: 'button',
            className: 'mcx-disclosure',
            'aria-expanded': server.expanded,
            title: server.expanded ? t('collapse') : t('expand'),
            onClick: () => update({ expanded: !server.expanded }),
          }, server.expanded ? '▾' : '▸'),
          h('div', { className: 'mcx-card-title' },
            h('span', { className: 'mcx-name' }, server.name.trim() === '' ? t('name') : server.name),
            h('span', { className: 'mcx-meta' },
              h('span', { className: 'mcx-pill mcx-pill-idle' }, stdio ? 'stdio' : server.transport === 'sse' ? 'sse' : 'http'),
              h(StatePill, { state: runtime?.state ?? 'none', t }),
              h('span', { className: 'mcx-meta-text' },
                toolCount === 0 ? t('noTools') : toolCount === 1 ? t('toolCountOne') : t('toolCount', { count: toolCount })))),
          h('div', { className: 'mcx-card-actions' },
            dupe ? h('span', { className: 'mcx-inline-error' }, t('nameDuplicate')) : null,
            server.enabled ? null : h('span', { className: 'mcx-state-text' }, t('disabled')),
            h(Check, {
              checked: server.enabled,
              disabled,
              label: t('enabled'),
              onChange: value => update({ enabled: value }),
            }),
            h('button', {
              type: 'button',
              className: 'mcx-button mcx-danger',
              disabled,
              onClick: () => {
                if (window.confirm(t('removeConfirm'))) remove()
              },
            }, t('remove')))),
        server.expanded
          ? h('div', { className: 'mcx-card-body' },
              h(IdentityFields, { server, update, t, disabled, id }),
              stdio
                ? h(ProcessFields, { server, update, t, disabled, id })
                : h(EndpointFields, { server, update, t, disabled, id }),
              stdio ? null : h(AuthFields, { server, update, t, disabled, id }),
              h('div', { className: 'mcx-panel' },
                h(Field, { id: id('tools'), label: t('tools') },
                  h(RulesEditor, { server, update, t, disabled }))),
              h('button', {
                type: 'button',
                className: 'mcx-link-button',
                'aria-expanded': server.advanced,
                onClick: () => update({ advanced: !server.advanced }),
              }, `${server.advanced ? '▾' : '▸'} ${t('advanced')}`),
              h(AdvancedFields, { server, update, t, disabled, id }),
              h(RuntimePanel, { server, runtime, t, editable, act, busy }))
          : null)
    }

    /* ------------------------------------------------------------------ */
    /* Panel                                                               */
    /* ------------------------------------------------------------------ */

    const CSS = `
.mcx { display: flex; flex-direction: column; gap: 16px; padding-bottom: 40px; max-width: 860px; }
.mcx-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.mcx-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; color: var(--dsw-alias-label-primary); }
.mcx-subtitle { margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); max-width: 60ch; }
.mcx-head-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.mcx-button { height: 30px; padding: 0 12px; border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l4); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.mcx-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.mcx-button:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.mcx-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); border-color: transparent; }
.mcx-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-fill); opacity: .9; }
.mcx-danger { color: var(--dsw-alias-state-error-primary); border-color: transparent; }
.mcx-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.mcx-icon { width: 28px; height: 28px; flex: none; border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 16px; line-height: 1; cursor: pointer; }
.mcx-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.mcx-link-button { align-self: flex-start; padding: 0; border: none; background: transparent; color: var(--dsw-alias-link); font: inherit; font-size: 13px; cursor: pointer; }
.mcx-link-button:hover { text-decoration: underline; }
.mcx-card { border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-md); overflow: hidden; }
.mcx-card-off { opacity: .72; }
.mcx-card-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
.mcx-disclosure { width: 24px; height: 24px; flex: none; border: none; background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 12px; cursor: pointer; border-radius: var(--dsw-radius-md); }
.mcx-disclosure:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mcx-card-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; }
.mcx-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcx-meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mcx-meta-text { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mcx-card-actions { display: flex; align-items: center; gap: 10px; flex: none; }
.mcx-card-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 16px 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.mcx-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; align-items: start; }
.mcx-grid-3 { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.mcx-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mcx-label { font-size: 12px; font-weight: 500; line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.mcx-hint { margin: 0; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-tertiary); }
.mcx-input { width: 100%; box-sizing: border-box; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.mcx-input:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.mcx-input:disabled { color: var(--dsw-alias-label-tertiary); }
.mcx-select { appearance: none; padding-right: 26px; background-image: linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-tertiary) 50%), linear-gradient(135deg, var(--dsw-alias-label-tertiary) 50%, transparent 50%); background-position: calc(100% - 14px) 14px, calc(100% - 9px) 14px; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
.mcx-textarea { height: auto; padding: 7px 10px; resize: vertical; line-height: 1.5; }
.mcx-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.mcx-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
.mcx-check input { width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); }
.mcx-panel { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); }
.mcx-rows { display: flex; flex-direction: column; gap: 6px; }
.mcx-row { display: flex; align-items: center; gap: 6px; }
.mcx-row-key { flex: 0 1 42%; }
.mcx-row-value { flex: 1 1 auto; }
.mcx-rules { display: flex; flex-direction: column; gap: 8px; }
.mcx-rule { display: flex; align-items: center; gap: 8px; }
.mcx-rule .mcx-input:first-child { flex: 1 1 auto; }
.mcx-pill { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11px; line-height: 1; white-space: nowrap; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.mcx-pill-ok { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.mcx-pill-bad { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.mcx-pill-warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.mcx-pill-busy { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.mcx-pill-idle { color: var(--dsw-alias-label-tertiary); }
.mcx-state-text { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.mcx-inline-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.mcx-runtime { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.mcx-runtime-head { display: flex; align-items: center; gap: 8px; }
.mcx-runtime-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.mcx-runtime-row { margin: 0; font-size: 13px; }
.mcx-runtime-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.mcx-error-text { margin: 0; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.mcx-notice { padding: 8px 12px; border-radius: var(--dsw-radius-md); font-size: 13px; line-height: 1.45; }
.mcx-notice-ok { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.mcx-notice-bad { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.mcx-notice-warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.mcx-empty { display: flex; flex-direction: column; gap: 6px; padding: 28px 20px; border: 0.5px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); text-align: center; }
.mcx-empty-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.mcx-empty-body { margin: 0 auto; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); max-width: 52ch; }
.mcx-options { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-md); }
.mcx-options-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.mcx-footer { display: flex; align-items: center; gap: 10px; }
.mcx-dirty { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
.mcx-link { color: var(--dsw-alias-link); text-decoration: none; }
.mcx-link:hover { text-decoration: underline; }
`

    /** The Settings page. */
    function Panel(props) {
      const injected = typeof props?.t === 'function' ? props.t : undefined
      const localT = useMemo(() => {
        const locale = (typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('zh')) ? 'zh' : 'en'
        const dictionary = locale === 'zh' ? zh : en
        return (key, vars) => {
          const text = dictionary[key] ?? en[key] ?? key
          return vars === undefined ? text : Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text)
        }
      }, [])
      const t = injected ?? localT

      const [snapshot, setSnapshot] = useState({ loading: true, error: null, editable: true, reason: undefined, servers: [] })
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const dirtyRef = useRef(false)
      const draftRef = useRef(null)
      dirtyRef.current = dirty
      draftRef.current = draft

      const applyState = useCallback((state, { force }) => {
        setSnapshot({ loading: false, error: null, editable: state.editable, reason: state.reason, servers: state.servers ?? [] })
        if (force || !dirtyRef.current) {
          const next = draftFromConfig(state.config)
          // Refreshing must not collapse a card the user opened; only the
          // configuration is replaced, not the disclosure state.
          const previous = draftRef.current
          if (previous !== null) {
            for (const server of next.servers) {
              const before = previous.servers.find(candidate => candidate.originalName === server.originalName)
              if (before !== undefined) {
                server.expanded = before.expanded
                server.advanced = before.advanced
              }
            }
          }
          setDraft(next)
          setDirty(false)
        }
      }, [])

      const load = useCallback(async ({ force = false, attempts = 5 } = {}) => {
        try {
          const state = await loadState({ attempts })
          applyState(state, { force })
          return state
        } catch (error) {
          setSnapshot(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }))
          return undefined
        }
      }, [applyState])

      useEffect(() => { void load({ attempts: 2 }) }, [load])

      // Keep the runtime status fresh without touching a draft being edited.
      useEffect(() => {
        const timer = setInterval(() => { void load({ attempts: 1 }) }, 8000)
        return () => clearInterval(timer)
      }, [load])

      const update = useCallback((serverKey, patch) => {
        setDraft(current => current === null ? current : {
          ...current,
          servers: current.servers.map(server => (server.key === serverKey ? { ...server, ...patch } : server)),
        })
        setDirty(true)
        setNotice(null)
      }, [])

      const removeServer = useCallback((serverKey) => {
        setDraft(current => current === null ? current : { ...current, servers: current.servers.filter(server => server.key !== serverKey) })
        setDirty(true)
        setNotice(null)
      }, [])

      const addServer = useCallback(() => {
        setDraft(current => current === null ? current : {
          ...current,
          servers: [...current.servers, { ...serverDraft(`mcp-server-${current.servers.length + 1}`, {}), expanded: true }],
        })
        setDirty(true)
        setNotice(null)
      }, [])

      const save = useCallback(async () => {
        if (draftRef.current === null) return
        const validation = validateDraft(draftRef.current, t)
        if (validation !== null) {
          setNotice({ tone: 'bad', text: validation })
          return
        }
        setSaving(true)
        setNotice(null)
        const config = configFromDraft(draftRef.current)
        let applied = false
        let lost = false
        try {
          await api(CONFIG_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config }),
          })
          applied = true
        } catch (error) {
          // Applying the config restarts this plugin, so the response can be
          // lost even though the write committed; read the config back.
          lost = true
          try {
            const state = await loadState({ attempts: 6 })
            applied = JSON.stringify(state.config) === JSON.stringify(config)
            if (applied) applyState(state, { force: true })
          } catch {
            applied = false
          }
          if (!applied) {
            setNotice({ tone: 'bad', text: `${t('saveFailed')} ${error instanceof Error ? error.message : String(error)}` })
          }
        }
        if (applied) {
          setDirty(false)
          setNotice({ tone: lost ? 'warn' : 'ok', text: lost ? t('savedButUnverified') : t('saved') })
          await load({ force: true, attempts: 6 })
        }
        setSaving(false)
      }, [applyState, load, t])

      const discard = useCallback(async () => {
        setNotice(null)
        await load({ force: true, attempts: 3 })
      }, [load])

      const act = useCallback(async (action, serverName) => {
        if (typeof serverName !== 'string') return
        setBusy(true)
        setNotice(null)
        try {
          const result = await api(ACTION_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, server: serverName }),
          })
          if (action === 'authorize' && result.server?.authorizationUrl) {
            setNotice({ tone: 'warn', text: `${t('pending')} — ${result.server.authorizationUrl}` })
          }
          await load({ force: false, attempts: 3 })
        } catch (error) {
          setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }, [load, t])

      const runtimeByName = useMemo(() => {
        const map = new Map()
        for (const server of snapshot.servers) map.set(server.name, server)
        return map
      }, [snapshot.servers])

      const duplicates = useMemo(() => {
        if (draft === null) return new Set()
        const counts = new Map()
        for (const server of draft.servers) {
          const name = server.name.trim().toLowerCase()
          counts.set(name, (counts.get(name) ?? 0) + 1)
        }
        return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name))
      }, [draft])

      const styles = h('style', {}, CSS)

      if (snapshot.loading && draft === null) {
        return h('div', { className: 'mcx' }, styles, h('p', { className: 'mcx-hint' }, '…'))
      }
      if (snapshot.error !== null && draft === null) {
        return h('div', { className: 'mcx' }, styles,
          h('p', { className: 'mcx-error-text' }, `${t('loadFailed')} ${snapshot.error}`),
          h('button', { type: 'button', className: 'mcx-button', onClick: () => { void load({ force: true }) } }, t('retry')))
      }
      if (draft === null) return h('div', { className: 'mcx' }, styles)
      if (!snapshot.editable) {
        return h('div', { className: 'mcx' }, styles,
          h('h3', { className: 'mcx-title' }, t('title')),
          h('p', { className: 'mcx-subtitle' }, snapshot.reason === undefined ? t('noEditor') : snapshot.reason))
      }

      return h('div', { className: 'mcx' }, styles,
        h('div', { className: 'mcx-head' },
          h('div', null,
            h('h3', { className: 'mcx-title' }, t('title')),
            h('p', { className: 'mcx-subtitle' }, t('subtitle'))),
          h('div', { className: 'mcx-head-actions' },
            h('button', { type: 'button', className: 'mcx-button', disabled: saving, onClick: () => { void load({ force: true }) } }, t('refresh')),
            h('button', { type: 'button', className: 'mcx-button', disabled: !dirty || saving, onClick: () => { void discard() } }, t('discard')),
            h('button', { type: 'button', className: 'mcx-button mcx-primary', disabled: !dirty || saving, onClick: () => { void save() } }, saving ? t('saving') : t('save')))),

        notice === null ? null : h('div', { className: `mcx-notice mcx-notice-${notice.tone}` }, notice.text),

        dirty ? h('span', { className: 'mcx-dirty' }, t('unsaved')) : null,

        h('div', { className: 'mcx-options' },
          h('h4', { className: 'mcx-options-title' }, t('globalOptions')),
          h('div', { className: 'mcx-grid' },
            h('div', { className: 'mcx-field' },
              h(Check, {
                checked: draft.failOnStartupError,
                label: t('failOnStartup'),
                onChange: value => { setDraft(current => ({ ...current, failOnStartupError: value })); setDirty(true) },
              }),
              h('p', { className: 'mcx-hint' }, t('failOnStartupHint'))),
            h('div', { className: 'mcx-field' },
              h(Check, {
                checked: draft.openBrowser,
                label: t('openBrowser'),
                onChange: value => { setDraft(current => ({ ...current, openBrowser: value })); setDirty(true) },
              })))),

        draft.servers.length === 0
          ? h('div', { className: 'mcx-empty' },
              h('p', { className: 'mcx-empty-title' }, t('emptyTitle')),
              h('p', { className: 'mcx-empty-body' }, t('emptyBody')))
          : draft.servers.map(server => h(ServerCard, {
              key: server.key,
              server,
              runtime: runtimeByName.get(server.originalName),
              update: patch => update(server.key, patch),
              remove: () => removeServer(server.key),
              t,
              editable: snapshot.editable && !saving,
              act,
              busy,
              dupe: duplicates.has(server.name.trim().toLowerCase()),
            })),

        h('div', { className: 'mcx-footer' },
          h('button', { type: 'button', className: 'mcx-button', disabled: saving, onClick: addServer }, `+ ${t('addServer')}`),
          dirty ? h('span', { className: 'mcx-dirty' }, t('unsaved')) : null))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'mcp-connector: dictionaries')
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-connector',
          order: 25,
          label: () => t('title'),
          locale: NS,
        }, Panel)), 'mcp-connector: settings page')
      },
    }
  },
})