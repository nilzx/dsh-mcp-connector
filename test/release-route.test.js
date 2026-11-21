import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseRoute } from '../scripts/release-route.mjs'

test('manual runs never publish, even when dispatched on a tag', () => {
  assert.deepEqual(releaseRoute({ event: 'workflow_dispatch', ref: 'refs/tags/v0.3.0-rc.1', version: '0.3.0-rc.1', channel: 'next' }), { publish: false })
})
test('pull requests only validate', () => {
  assert.deepEqual(releaseRoute({ event: 'pull_request', ref: 'refs/pull/1/merge', version: '0.3.0-rc.1', channel: 'next' }), { publish: false })
})
test('matching prerelease and stable tags route to next and latest', () => {
  assert.deepEqual(releaseRoute({ event: 'push', ref: 'refs/tags/v0.3.0-rc.1', version: '0.3.0-rc.1', channel: 'next' }), { publish: true, tag: 'next', prerelease: true })
  assert.deepEqual(releaseRoute({ event: 'push', ref: 'refs/tags/v1.2.3', version: '1.2.3', channel: 'latest' }), { publish: true, tag: 'latest', prerelease: false })
})
test('mismatched tags, unsupported events and malicious or invalid inputs fail closed', () => {
  for (const input of [
    { event: 'push', ref: 'refs/tags/v0.3.0', version: '0.3.0-rc.1', channel: 'next' },
    { event: 'schedule', ref: 'refs/tags/v1.2.3', version: '1.2.3', channel: 'latest' },
    { event: 'push', ref: 'refs/tags/v1.2.3', version: '1.2.3', channel: 'next' },
    { event: 'push', ref: 'refs/tags/v1.2.3\nlatest=true', version: '1.2.3', channel: 'latest' },
    ...['01.2.3', '1.2.3-01', '1.2.3;echo x', '1.2', 'v1.2.3', '1.2.3\n'].map(version => ({ event: 'push', ref: `refs/tags/v${version}`, version, channel: 'latest' })),
  ]) assert.throws(() => releaseRoute(input))
})

test('workflow limits publication to tag pushes and transfers the verified tarball', async () => {
  const { readFile } = await import('node:fs/promises')
  const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
  assert.match(workflow, /github\.event_name == 'push'.*needs\.package\.outputs\.publish == 'true'/)
  assert.match(workflow, /needs: package/)
  assert.match(workflow, /sha256sum -c SHA256SUMS/)
  assert.match(workflow, /npm publish \.\/dist\/candidate\.tgz --access public --tag/)
  assert.match(workflow, /args\+=\(--prerelease\)/)
})
