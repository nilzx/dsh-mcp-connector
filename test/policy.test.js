import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compileToolPolicy, globToRegExp, policyDecision, resolveToolPolicy } from '../src/policy.js'

describe('globToRegExp', () => {
  it('matches literal names exactly', () => {
    const pattern = globToRegExp('read_file')
    assert.equal(pattern.test('read_file'), true)
    assert.equal(pattern.test('read_file_v2'), false)
    assert.equal(pattern.test('xread_file'), false)
  })

  it('expands * and ? and escapes regex metacharacters', () => {
    assert.equal(globToRegExp('delete_*').test('delete_issue'), true)
    assert.equal(globToRegExp('delete_*').test('remove_issue'), false)
    assert.equal(globToRegExp('a?c').test('abc'), true)
    assert.equal(globToRegExp('a?c').test('ac'), false)
    assert.equal(globToRegExp('a.b').test('a.b'), true)
    assert.equal(globToRegExp('a.b').test('axb'), false)
  })
})

describe('compileToolPolicy', () => {
  it('defaults to allow with no rules', () => {
    assert.deepEqual(compileToolPolicy(undefined, 'x'), { default: 'allow', rules: [] })
  })

  it('keeps rule order', () => {
    const compiled = compileToolPolicy({ default: 'deny', rules: { 'get_*': 'allow', get_secret: 'deny' } }, 'x')
    assert.equal(resolveToolPolicy(compiled, 'get_public', 'mcp__s__get_public'), 'allow')
    assert.equal(resolveToolPolicy(compiled, 'get_secret', 'mcp__s__get_secret'), 'allow')
    assert.equal(resolveToolPolicy(compiled, 'create', 'mcp__s__create'), 'deny')
  })

  it('matches against the public name as well as the raw name', () => {
    const compiled = compileToolPolicy({ rules: { 'mcp__s__*': 'ask' } }, 'x')
    assert.equal(resolveToolPolicy(compiled, 'anything', 'mcp__s__anything'), 'ask')
  })
})

describe('policyDecision', () => {
  it('denies with a structured error', () => {
    const decision = policyDecision('deny', 'mcp__s__t')
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.info.code, 'MCP_CONNECTOR_TOOL_DENIED')
    assert.match(decision.reason, /blocked/)
  })

  it('asks with localized display text', () => {
    const decision = policyDecision('ask', 'mcp__s__t')
    assert.equal(decision.kind, 'ask')
    assert.equal(typeof decision.displayReason.en, 'string')
    assert.equal(typeof decision.displayReason.zh, 'string')
  })

  it('returns nothing for allow and off', () => {
    assert.equal(policyDecision('allow', 'mcp__s__t'), undefined)
    assert.equal(policyDecision('off', 'mcp__s__t'), undefined)
  })
})