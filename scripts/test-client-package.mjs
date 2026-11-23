/** Clean-install packaging smoke. Synthetic preview only; no wallet, chain or live paid call. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidence = JSON.parse(
  await fs.readFile(path.join(root, 'artifacts/client/package-evidence.json'), 'utf8'),
)
const dir = await fs.mkdtemp(path.join(root, 'artifacts/client/smoke-'))
const cache = path.join(dir, 'cache')
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 180000,
    shell: false,
  })
  if (result.status !== 0)
    throw new Error(`Package smoke failed (${result.status}): ${result.stdout}\n${result.stderr}`)
  return result.stdout
}
assert.ok(process.env.npm_execpath, 'Run via npm run test:client-package')
assert.ok(!evidence.files.some((file) => /^(src|data|artifacts|node_modules)\//.test(file)))
assert.ok(!evidence.files.some((file) => /server\.js|worker\/|\.env|checkpoint\.json/.test(file)))
const help = run([
  process.env.npm_execpath,
  'exec',
  '--yes',
  '--cache',
  cache,
  '--package',
  evidence.tarball,
  '--',
  'viewport-witness',
  '--help',
])
assert.ok(help.includes('--resume') && help.includes('--execute'))
const entries = await fs.readdir(path.join(cache, '_npx'))
const installed = path.join(cache, '_npx', entries[0], 'node_modules', 'viewport-witness-client')
const manifest = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'))
const expectedVersion = JSON.parse(
  await fs.readFile(path.join(root, 'client/package.json'), 'utf8'),
).version
assert.equal(manifest.version, expectedVersion)
assert.equal(manifest.dependencies['@coinbase/cdp-sdk'], undefined)
const installedInventory = JSON.parse(
  await fs.readFile(path.join(path.dirname(installed), '.package-lock.json'), 'utf8'),
).packages
assert.ok(
  !Object.keys(installedInventory).some((name) => name.includes('node_modules/@coinbase/cdp-sdk')),
)
const installedZod = Object.entries(installedInventory).filter(([name]) => name.endsWith('/zod'))
assert.ok(installedZod.length > 0)
for (const [, pkg] of installedZod) assert.equal(pkg.version, '4.6.7')
assert.equal(manifest.scripts, undefined)
assert.ok(
  !Object.keys(manifest.dependencies).some((name) => /playwright|express|axe-core/.test(name)),
)
run([
  '--input-type=module',
  '-e',
  `await import(${JSON.stringify(pathToFileURL(path.join(installed, 'dist/x402-adapter.js')).href)}); await import(${JSON.stringify(pathToFileURL(path.join(installed, 'dist/customer-cdp.js')).href)}); console.log('connector dependencies import without signing')`,
])
const preload = path.join(dir, 'synthetic-preview.mjs')
await fs.writeFile(
  preload,
  `
import assert from 'node:assert/strict';
import {promises as dns} from 'node:dns';
dns.lookup=async()=>[{address:'93.184.216.34',family:4}];
globalThis.fetch=async(url,init)=>{
 assert.equal(String(url),'https://qa.honeygate.app/v1/checks');
 assert.equal(init.method,'POST');
 const headers=new Headers(init.headers);
 assert.equal(headers.get('x-viewportwitness-source'),'test-client');
 assert.ok(headers.get('x-viewportwitness-quickstart-run'));
 assert.equal(headers.has('payment-signature'),false);
 const quote={x402Version:2,resource:{url:String(url)},accepts:[{scheme:'exact',network:'eip155:8453',asset:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',amount:'80000',payTo:'0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400'}]};
 return new Response(null,{status:402,headers:{'payment-required':Buffer.from(JSON.stringify(quote)).toString('base64')}});
};
`,
)
const output = path.join(dir, 'out')
const preview = run(
  [
    path.join(installed, 'bin/viewport-witness.mjs'),
    '--url',
    'https://example.com',
    '--run-id',
    'package-smoke',
    '--output',
    output,
    '--network',
    'base',
    '--wallet',
    'cdp',
  ],
  {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    VW_USAGE_SOURCE: 'test-client',
    CDP_API_KEY_ID: '',
    CDP_API_KEY_SECRET: '',
    CDP_WALLET_SECRET: '',
    VW_PAYER_ADDRESS: '',
  },
)
const summary = JSON.parse(await fs.readFile(path.join(output, 'summary.json'), 'utf8'))
assert.equal(summary.spendingApproved, false)
assert.equal(summary.quotedAtomic, '80000')
assert.ok(preview.includes('Wallet code will not be loaded'))
assert.ok(preview.includes('CDP_API_KEY_SECRET'))
assert.equal(await fs.stat(path.join(output, 'checkpoint.json')).catch(() => null), null)
console.log(
  'PASS clean npm exec install, CLI help, connector dependency imports and unsigned synthetic preview; no checkout/build/browser/wallet/payment.',
)
