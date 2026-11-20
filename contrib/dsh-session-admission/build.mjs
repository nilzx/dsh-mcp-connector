/** Build the reviewed optional host modules without changing an installed dsh. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [dshArg, outputArg, esbuildArg, ...extra] = process.argv.slice(2)
if (!dshArg || !outputArg || !esbuildArg || extra.length) {
  throw new Error('Usage: node build.mjs <installed-dsh-directory> <new-output-directory> <esbuild-lib-main.js>')
}
const dshRoot = await fs.realpath(dshArg)
const requestedOutput = path.resolve(outputArg)
const output = path.join(await fs.realpath(path.dirname(requestedOutput)), path.basename(requestedOutput))
const esbuildFile = await fs.realpath(esbuildArg)
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) }
if (within(dshRoot, output)) throw new Error('Output must be outside the installed dsh directory')
const metadata = JSON.parse(await fs.readFile(path.join(dshRoot, 'package.json'), 'utf8'))
if (metadata.name !== '@deepseek-ai/dsh' || metadata.version !== '0.2.2-rc.5') throw new Error('This proposal requires exactly @deepseek-ai/dsh 0.2.2-rc.5')
const esbuild = await import(pathToFileURL(esbuildFile).href)
if (esbuild.version !== '0.28.2') throw new Error('Reproducible prototype builds require esbuild 0.28.2')
const targets = [
  { name: 'session', directory: 'packages/core/session', file: 'index.ts', sha256: '8941b4c7a45debf2443b0f937830f806130167e3ef53426833f7225dd5a8bb8f' },
  { name: 'api-session-controller', directory: 'packages/api/session-controller', file: 'commands.ts', sha256: 'd387517e345d444e2ebf15c1af0c74e0ac59b55774cbebfba03f4037946b185a' },
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
for (const target of targets) {
  const source = path.join(dshRoot, 'node_modules/@deepseek-ai/dsh-' + target.name, 'src', target.file)
  if (sha(await fs.readFile(source)) !== target.sha256) throw new Error(`Unreviewed source for ${target.name}; do not apply this patch blindly`)
}
// Exclusive creation avoids overwriting an existing profile or build.
await fs.mkdir(output)
await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
await fs.symlink(path.join(dshRoot, 'node_modules'), path.join(output, 'node_modules'), 'dir')
for (const target of targets) {
  const destination = path.join(output, target.directory, 'src')
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(path.join(dshRoot, 'node_modules/@deepseek-ai/dsh-' + target.name, 'src'), destination, { recursive: true })
}
const patchFile = fileURLToPath(new URL('./host.patch', import.meta.url))
execFileSync('git', ['apply', '--check', patchFile], { cwd: output, stdio: 'pipe' })
execFileSync('git', ['apply', patchFile], { cwd: output, stdio: 'pipe' })
const modules = {}
for (const target of targets) {
  const outfile = target.name + '/index.js'
  await esbuild.build({ absWorkingDir: output, entryPoints: [target.directory + '/src/index.ts'], outfile,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', logLevel: 'warning' })
  modules[target.name] = { path: path.join(output, outfile), sha256: sha(await fs.readFile(path.join(output, outfile))) }
}
const manifest = { dshVersion: metadata.version, esbuildVersion: esbuild.version,
  patchSha256: sha(await fs.readFile(patchFile)), sourceFiles: targets, modules }
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ output, modules, installedFilesChanged: false }, null, 2))
