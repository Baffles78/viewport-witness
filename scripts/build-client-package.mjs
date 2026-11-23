/** Build a client-only release archive from compiled, reviewed source. Never publishes. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'artifacts/client')
await fs.mkdir(output, { recursive: true })
const stage = await fs.mkdtemp(path.join(output, 'stage-'))
const copied = new Set()
async function copy(relative) {
  const from = path.resolve(root, relative)
  if (!from.startsWith(root + path.sep)) throw new Error('Package input outside checkout')
  const stat = await fs.lstat(from)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Package input must be a regular file')
  const to = path.join(stage, relative)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  copied.add(relative.replaceAll('\\', '/'))
}
async function compiled(relative) {
  if (copied.has(relative.replaceAll('\\', '/'))) return
  if (!relative.startsWith('dist/') || !relative.endsWith('.js'))
    throw new Error('Invalid compiled input')
  await copy(relative)
  const text = await fs.readFile(path.join(root, relative), 'utf8')
  for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]))
    await compiled(dependency)
  }
}
for (const entry of [
  'release-check',
  'x402-adapter',
  'customer-cdp',
  'customer-cdp-settings',
  'client/doctor',
  'client/options',
  'client/setup-options',
])
  await compiled(`dist/${entry}.js`)
for (const input of [
  'bin/viewport-witness.mjs',
  'scripts/doctor.mjs',
  'scripts/setup.mjs',
  'scripts/setup-bridge.mjs',
  'scripts/lib/setup-checkpoint.mjs',
  'scripts/windows-setup.ps1',
  'scripts/first-check.mjs',
  'scripts/first-check-resume.mjs',
  'scripts/release-check.mjs',
  'scripts/no-payment-adapter.mjs',
  'scripts/lib/bounded-json.mjs',
  'scripts/lib/quickstart-usage.mjs',
  'examples/wallets/existing-cdp-base.mjs',
])
  await copy(input)
for (const [input, target] of [
  ['client/package.json', 'package.json'],
  ['client/README.md', 'README.md'],
  ['client/npm-shrinkwrap.json', 'npm-shrinkwrap.json'],
])
  await fs.copyFile(path.join(root, input), path.join(stage, target))
const manifest = JSON.parse(await fs.readFile(path.join(stage, 'package.json'), 'utf8'))
if (
  manifest.scripts ||
  Object.keys(manifest.dependencies).some((name) => /playwright|express|axe-core/.test(name))
)
  throw new Error('Server/build dependency in client')
// npm's CLI is JavaScript; invoke it directly on Windows too, without a shell.
if (!process.env.npm_execpath) throw new Error('Run via npm run build:client')
const pack = spawnSync(
  process.execPath,
  [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', output],
  { cwd: stage, encoding: 'utf8', shell: false },
)
if (pack.status !== 0) throw new Error('Client package creation failed: ' + pack.stderr)
const receipt = JSON.parse(pack.stdout)[0]
const tarball = path.join(output, receipt.filename)
const sha256 = createHash('sha256')
  .update(await fs.readFile(tarball))
  .digest('hex')
const evidence = {
  package: manifest.name,
  version: manifest.version,
  tarball,
  sha256,
  files: receipt.files.map((file) => file.path),
}
await fs.writeFile(
  path.join(output, 'package-evidence.json'),
  JSON.stringify(evidence, null, 2) + '\n',
)
await fs.writeFile(path.join(output, 'SHA256SUMS'), `${sha256}  ${receipt.filename}\n`)
console.log(JSON.stringify(evidence, null, 2))
