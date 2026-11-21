// Exercise the published file list using an isolated installation.
import { mkdtemp, readFile, rm, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 0 && args.length !== 2) throw new Error('Usage: node scripts/check-package.mjs [installed-dsh-directory esbuild-lib-main.js]')
const temporary = await mkdtemp(path.join(tmpdir(), 'connector-package-'))
function run(command, argv, cwd, expected = 0) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(temporary, 'npm-cache') } })
  if (result.status !== expected) throw new Error(`${command} failed (${result.status}): ${result.stderr}`)
  return result.stdout + result.stderr
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], root))
  const install = path.join(temporary, 'install')
  await mkdir(install)
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, (Array.isArray(packed) ? packed[0] : Object.values(packed)[0]).filename)], install)
  const pkg = path.join(install, 'node_modules/@nilzx/dsh-mcp-connector')
  for (const file of ['contrib/dsh-session-admission/README.md', 'contrib/dsh-session-admission/build.mjs', 'contrib/dsh-session-admission/host.patch', 'docs/ADVANCED.md']) await access(path.join(pkg, file))
  const advanced = await readFile(path.join(pkg, 'docs/ADVANCED.md'), 'utf8')
  if (!advanced.includes('../contrib/dsh-session-admission/README.md')) throw new Error('Advanced documentation link missing')
  const builder = path.join(pkg, 'contrib/dsh-session-admission/build.mjs')
  const usage = run(process.execPath, [builder], install, 1)
  if (!usage.includes('Usage: node build.mjs')) throw new Error('Builder usage failure missing')
  if (args.length) {
    const output = path.join(temporary, 'host-build')
    run(process.execPath, [builder, path.resolve(args[0]), output, path.resolve(args[1])], install)
    await access(path.join(output, 'manifest.json'))
    await access(path.join(output, 'session/index.js'))
    await access(path.join(output, 'api-session-controller/index.js'))
    console.log('Isolated host build passed')
  } else console.log('Host build skipped: supply installed dsh and esbuild paths to verify it')
  console.log('Pack and isolated installation passed')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
