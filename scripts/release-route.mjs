import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// SemVer 2.0.0, including prerelease numeric identifier leading-zero rules.
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function releaseRoute({ event, ref, version, channel }) {
  const match = typeof version === 'string' && semver.exec(version)
  if (!match || match[0] !== version) throw new Error('package version must be strict SemVer')
  const tag = match[4] ? 'next' : 'latest'
  if (channel !== tag) throw new Error(`publishConfig.tag must be ${tag} for this version`)
  if (event === 'workflow_dispatch' || event === 'pull_request') return { publish: false }
  if (event !== 'push' || ref !== `refs/tags/v${version}`) throw new Error('only an exactly matching version tag push can publish')
  return { publish: true, tag, prerelease: Boolean(match[4]) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const route = releaseRoute({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, version: manifest.version, channel: manifest.publishConfig?.tag })
  const lines = [`publish=${route.publish}`]
  if (route.publish) lines.push(`tag=${route.tag}`, `prerelease=${route.prerelease}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n')
  else console.log(lines.join('\n'))
}
