/** One-page buyer entrypoint. Preview is the default; existing release client owns payment/recovery. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { prepareFirstCheckResume, saveFirstCheckReference } from './first-check-resume.mjs'
import { loadBoundedJson } from './lib/bounded-json.mjs'
import { quickstartUsage } from './lib/quickstart-usage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const networks = { base: 'eip155:8453', solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }
const help = `Preview one deployed page without paying:
  node scripts/first-check.mjs --url https://example.com --run-id deploy-123

After approving a payment, repeat with:
  --execute --wallet-module <existing-connector.mjs> --network base --recipient <approved-address>
Or select the supplied existing-account connector with --wallet cdp instead of --wallet-module.

Retrieve an accepted job without a wallet or new payment:
  node scripts/first-check.mjs --resume --output <same-output-directory>

Options: --url, --run-id, --output, --budget (default 0.08 USDC), --network base|solana,
--recipient, --fee-payer (required for Solana), --wallet-module, --wallet cdp, --execute, --resume.
Keep the same run ID, arguments and output directory to resume. Use a new ID only for a new deployment.
Never paste a key or seed phrase. Connecting an MCP client alone does not provide a signer.`

export async function prepareFirstCheck(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--execute' || flag === '--resume') {
      const key = flag.slice(2)
      if (args[key]) throw new Error('Repeated ' + flag)
      args[key] = true
      continue
    }
    if (
      ![
        '--url',
        '--run-id',
        '--output',
        '--budget',
        '--network',
        '--recipient',
        '--fee-payer',
        '--wallet-module',
        '--wallet',
        '--manifest',
      ].includes(flag) ||
      Object.hasOwn(args, flag)
    )
      throw new Error('Unknown or repeated option')
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error('Missing option value')
    args[flag] = value
  }
  if (args.resume) return prepareFirstCheckResume(args)
  if (args['--manifest']) throw new Error('--manifest is only used for legacy --resume')
  if (args['--wallet'] && (args['--wallet'] !== 'cdp' || args['--wallet-module']))
    throw new Error('Use --wallet cdp or --wallet-module, not both')
  if (args['--wallet'] === 'cdp' && args['--network'] !== 'base')
    throw new Error('The supplied CDP connector requires explicit --network base')
  const walletPath =
    args['--wallet'] === 'cdp'
      ? path.join(root, 'examples/wallets/existing-cdp-base.mjs')
      : args['--wallet-module']
  if (
    args.execute &&
    (!args['--run-id'] || !walletPath || !args['--network'] || !args['--recipient'])
  )
    throw new Error(
      'Execution requires an explicit run ID, existing wallet module, network and approved recipient',
    )
  if (!args['--url']) throw new Error('--url is required')
  const target = new URL(args['--url'])
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    args['--url'].length > 2048
  )
    throw new Error('Use one public HTTPS URL without embedded credentials')
  const runId =
    args['--run-id'] ??
    `preview-${createHash('sha256').update(args['--url']).digest('hex').slice(0, 16)}`
  if (!/^[-a-zA-Z0-9_]{1,60}$/.test(runId))
    throw new Error('Use a short run ID with letters, numbers, hyphens or underscores')
  const budget = args['--budget'] ?? '0.08'
  if (!/^\d{1,8}(\.\d{1,6})?$/.test(budget) || Number(budget) <= 0)
    throw new Error('Budget must be a positive USDC amount')
  const network = args['--network'] ? networks[args['--network']] : undefined
  if (args['--network'] && !network) throw new Error('Network must be base or solana')
  if (args.execute && network === networks.solana && !args['--fee-payer'])
    throw new Error('Solana execution requires an approved fee payer')
  const manifest = {
    runId,
    pages: [args['--url']],
    maxBudgetUsdc: budget,
    ...(network ? { allowedNetwork: network } : {}),
    ...(args['--recipient'] ? { allowedPayTo: args['--recipient'] } : {}),
    ...(args['--fee-payer'] ? { allowedFeePayer: args['--fee-payer'] } : {}),
  }
  const output = path.resolve(args['--output'] ?? path.join('out', 'first-check', runId))
  await fs.mkdir(output, { recursive: true })
  const folder = await fs.lstat(output)
  if (!folder.isDirectory() || folder.isSymbolicLink())
    throw new Error('Output must be a regular directory')
  // Each argument set gets an immutable file. A concurrent preview cannot rewrite
  // the manifest that an executing client is about to read.
  const manifestHash = createHash('sha256')
    .update(JSON.stringify(manifest))
    .digest('hex')
    .slice(0, 24)
  const manifestPath = path.join(output, `manifest-${manifestHash}.json`)
  const statePath = path.join(output, 'checkpoint.json')
  const current = await fs.lstat(manifestPath).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (current && (!current.isFile() || current.isSymbolicLink() || current.size > 65536))
    throw new Error('Existing manifest is not a bounded regular file')
  const old = current ? JSON.parse(await fs.readFile(manifestPath, 'utf8')) : null
  const checkpoint = await fs.lstat(statePath).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const lock = await fs.lstat(statePath + '.lock').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if ((checkpoint || lock) && JSON.stringify(old) !== JSON.stringify(manifest))
    throw new Error(
      'Existing checkpoint belongs to different arguments; preserve it and reconcile before changing this run',
    )
  if (old && JSON.stringify(old) !== JSON.stringify(manifest))
    throw new Error('Existing manifest was edited; preserve it and reconcile this run')
  if (!current)
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
  const clientArgs = [
    path.join(root, 'scripts/release-check.mjs'),
    '--manifest',
    manifestPath,
    '--output',
    output,
  ]
  if (args.execute || checkpoint) clientArgs.push('--state', statePath)
  if (args.execute) {
    await saveFirstCheckReference(output, manifestPath)
    clientArgs.push('--execute', '--wallet-module', path.resolve(walletPath))
  }
  return {
    manifestPath,
    clientArgs,
    output,
    execute: args.execute === true,
    walletKind: args['--wallet'],
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(help)
    return
  }
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('Node.js 22 or later is required')
  try {
    await fs.access(path.join(root, 'dist/release-check.js'))
  } catch {
    throw new Error('Build the client once with npm ci and npm run build, then retry')
  }
  const prepared = await prepareFirstCheck(process.argv.slice(2))
  if (prepared.walletKind === 'cdp') {
    const { missingCdpCustomerSettings } = await import('../dist/customer-cdp-settings.js')
    const missing = missingCdpCustomerSettings(process.env)
    if (prepared.execute && missing.length)
      throw new Error(
        'CDP setup missing local environment variables: ' +
          missing.join(', ') +
          '. No wallet loaded or payment attempted.',
      )
    console.log(
      JSON.stringify({
        wallet: 'existing-cdp-base',
        configured: missing.length === 0,
        missingEnvironmentVariables: missing,
      }),
    )
  }
  console.log(
    prepared.resume
      ? 'Retrieving accepted job without wallet access or any permitted payment.'
      : prepared.execute
        ? 'Explicit execution requested; checkpoint protections remain active.'
        : 'Unpaid preview. Wallet code will not be loaded.',
  )
  const usage = prepared.resume ? {} : await quickstartUsage(prepared.output)
  const child = spawn(process.execPath, prepared.clientArgs, {
    stdio: 'inherit', shell: false,
    env: { ...process.env, VW_QUICKSTART_RUN_ID: usage.runId ?? '', VW_QUICKSTART_SOURCE: usage.source ?? '' },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 2))
  })
  if (!prepared.execute && !prepared.resume && process.exitCode === 0) {
    const summary = await loadBoundedJson(path.join(prepared.output, 'summary.json'))
    console.log(
      JSON.stringify(
        {
          spendingApproved: false,
          paymentTerms: summary.paymentTerms ?? [],
          next: 'Independently approve the recipient and budget, then repeat with --execute and an existing wallet connector.',
          recovery: ['--resume', '--output', prepared.output],
          recoveryRequiresAcceptedCheckpoint: true,
        },
        null,
        2,
      ),
    )
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 2
  })
