import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))

/**
 * Load client.js the way the Web module loader does, against a fake runtime.
 * @returns the module definition registered under the package id.
 */
async function loadClientModule() {
  const source = (await readFile(clientPath, 'utf8')).replace("    return {\n      inject: ['slots', 'locale'],", "    return { __test: { serverDraft, serverConfig, ScopeFields, draftFromConfig, configFromDraft },\n      inject: ['slots', 'locale'],")
  let loaded
  const window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  const require = id => {
    if (id !== 'react') throw new Error(`unexpected module ${id}`)
    return { createElement: () => null, useCallback: fn => fn, useEffect() {}, useMemo: fn => fn(), useRef: () => ({}), useState: value => [value, () => {}] }
  }
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window)
  assert.ok(loaded !== undefined, 'client.js must register through __ModuleLoader__.load')
  return { definition: loaded, factory: loaded.factory(require) }
}

describe('client module', () => {
  it('keeps private recovery operations when unrelated panel settings change', async () => {
    const { factory } = await loadClientModule(), { draftFromConfig, configFromDraft } = factory.__test
    assert.deepEqual(configFromDraft(draftFromConfig({ servers: {} })), { servers: {} })
    const recoveries = [{ operationId: 'approved' }], draft = draftFromConfig({ servers: {}, recoveries })
    draft.openBrowser = false
    assert.deepEqual(configFromDraft(draft), { servers: {}, recoveries, openBrowser: false })
  })
  it('registers under the package id and exposes one Settings section', async () => {
    const { definition, factory } = await loadClientModule()
    assert.equal(definition.id, '@nilzx/dsh-mcp-connector')
    assert.deepEqual(factory.inject, ['slots', 'locale'])

    const registrations = []
    const dictionaries = []
    const ctx = {
      effect(fn) {
        fn()
        return () => {}
      },
      locale: {
        bind: () => key => key,
        register(ns, dict) {
          dictionaries.push({ ns, dict })
          return () => {}
        },
      },
      slots: {
        inject(owner, install) {
          install()
          return () => {}
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }
    factory.apply(ctx)

    assert.equal(dictionaries.length, 1)
    assert.equal(dictionaries[0].ns, 'mcpConnector')
    assert.equal(typeof dictionaries[0].dict.en.title, 'string')
    assert.equal(typeof dictionaries[0].dict.zh.title, 'string')

    assert.equal(registrations.length, 1)
    const [{ options, component }] = registrations
    assert.equal(options.name, 'settings.section')
    assert.equal(options.id, 'mcp-connector')
    assert.equal(typeof options.label(), 'string')
    assert.equal(typeof component, 'function')
  })

  it('round-trips delegation and renders its control', async () => {
    const { factory } = await loadClientModule()
    const { serverDraft, serverConfig, ScopeFields } = factory.__test
    const denied = serverDraft('x', { command: 'node', transport: 'stdio', delegation: 'deny' })
    assert.equal(denied.delegation, 'deny')
    assert.equal(serverConfig(denied).delegation, 'deny')
    denied.delegation = 'allow'
    assert.equal(serverConfig(denied).delegation, undefined)
    const source = await readFile(clientPath, 'utf8')
    assert.match(source, /value: server\.delegation/)
    assert.match(source, /onChange: value => update\(\{ delegation: value \}\)/)
    assert.equal(typeof ScopeFields, 'function')
  })

  it('ships a dictionary with identical keys in both languages', async () => {
    const { factory } = await loadClientModule()
    const dictionaries = []
    factory.apply({
      effect(fn) { fn(); return () => {} },
      locale: { bind: () => key => key, register: (ns, dict) => { dictionaries.push(dict); return () => {} } },
      slots: { inject: (owner, install) => { install(); return () => {} }, register: () => () => {} },
    })
    const [dict] = dictionaries
    assert.deepEqual(Object.keys(dict.en).sort(), Object.keys(dict.zh).sort())
    for (const [key, value] of Object.entries(dict.en)) {
      assert.notEqual(value.trim(), '', `empty English copy for ${key}`)
      assert.notEqual(dict.zh[key].trim(), '', `empty Chinese copy for ${key}`)
    }
  })
})
