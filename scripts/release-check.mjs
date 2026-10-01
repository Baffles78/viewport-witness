/**
 * Release check CLI — runs a bounded multi-page ViewportWitness check.
 *
 * Usage (preview / dry-run — no payment):
 *   node scripts/release-check.mjs --manifest examples/release-check.json --output out/
 *
 * Usage (paid execution — requires explicit flags and a customer-owned adapter):
 *   node scripts/release-check.mjs --manifest examples/release-check.json \
 *     --state out/checkpoint.json --output out/ \
 *     --execute --adapter ./my-payment-adapter.mjs
 *
 * Exit codes: 0 PASS or unpaid preview, 1 FAIL, 2 INCONCLUSIVE.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runReleaseCheck } from '../dist/release-check.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--execute') {
      args.execute = true
      continue
    }
    if (arg === '--test-mode') {
      args.testMode = true
      continue
    }
    const eqIdx = arg.indexOf('=')
    const key = eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2)
    if (
      !arg.startsWith('--') ||
      !['manifest', 'state', 'output', 'adapter', 'service-url'].includes(key) ||
      Object.hasOwn(args, key)
    )
      throw new Error('Unknown or repeated argument')
    const val = eqIdx >= 0 ? arg.slice(eqIdx + 1) : argv[++i]
    if (!val || val.startsWith('--')) throw new Error('Missing argument value')
    args[key] = val
  }
  return args
}

function usage(msg) {
  if (msg) console.error(`Error: ${msg}`)
  console.error(
    [
      'Usage: node scripts/release-check.mjs --manifest <path> [options]',
      '  --manifest <path>      Required. Path to release manifest JSON.',
      '  --state <path>         Checkpoint file. Required for --execute.',
      '  --output <dir>         Output directory for report.md and summary.json.',
      '  --execute              Enable paid execution (requires --state and --adapter).',
      '  --adapter <path>       Customer-owned JS module exporting a default payment adapter.',
      '  --service-url <url>    Service base URL (local test only).',
      '  --test-mode            Allow unsigned 202 responses (local test only).',
    ].join('\n'),
  )
  throw new CliExit(2)
}

class CliExit extends Error {
  constructor(code) {
    super('Client stopped')
    this.code = code
  }
}

async function loadBoundedJson(filePath, maxBytes = 64 * 1024) {
  const abs = resolve(filePath)
  const stat = await fs.lstat(abs)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular JSON file')
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit: ${abs}`)
  const text = await fs.readFile(abs, 'utf8')
  return JSON.parse(text)
}

async function atomicWriteJson(filePath, value) {
  const abs = resolve(filePath)
  const tmp = `${abs}.tmp.${randomUUID()}`
  await fs.mkdir(dirname(abs), { recursive: true })
  const current = await fs.lstat(abs).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (current && (!current.isFile() || current.isSymbolicLink()))
    throw new Error('Checkpoint must be a regular file')
  const file = await fs.open(tmp, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await fs.rename(tmp, abs)
  } catch (error) {
    await fs.unlink(tmp).catch(() => {})
    throw error
  }
  // Persist directory entry where supported. File sync above is required on all platforms.
  if (process.platform !== 'win32') {
    const dir = await fs.open(dirname(abs), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }
}

async function loadCheckpoint(statePath) {
  const abs = resolve(statePath)
  try {
    const parsed = await loadBoundedJson(abs)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Malformed checkpoint')
    return parsed
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw new Error(`Malformed checkpoint at ${abs}: ${err.message}`)
  }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    usage(error.message)
  }

  if (!args.manifest) usage('--manifest is required')

  const execute = args.execute === true
  const testMode = args.testMode === true

  if (execute && !args.state) usage('--state is required for --execute')
  if (execute && !testMode && !args.adapter) usage('--adapter is required for paid --execute')
  let ownedLock
  if (execute) {
    const statePath = resolve(args.state)
    await fs.mkdir(dirname(statePath), { recursive: true })
    const lockPath = statePath + '.lock'
    let lock
    try {
      lock = await fs.open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error.code === 'EEXIST')
        usage(
          'Checkpoint is locked. Reconcile an interrupted run before manually removing its lock.',
        )
      throw error
    }
    ownedLock = lockPath
    process.on('exit', () => {
      if (ownedLock)
        try {
          unlinkSync(ownedLock)
        } catch {
          /* A stale lock blocks future execution safely. */
        }
    })
    process.on('SIGINT', () => process.exit(130))
    process.on('SIGTERM', () => process.exit(143))
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      )
      await lock.sync()
    } finally {
      await lock.close()
    }
  }

  // Load manifest with size cap; reject symlinks.
  let manifest
  try {
    manifest = await loadBoundedJson(args.manifest)
  } catch (err) {
    console.error(`Failed to load manifest: ${err.message}`)
    return 2
  }

  // Build checkpoint accessor if state path is given.
  let checkpoint = undefined
  if (args.state) {
    const statePath = args.state
    let loaded = null
    try {
      loaded = await loadCheckpoint(statePath)
    } catch (err) {
      console.error(`Checkpoint load failed (fail-closed): ${err.message}`)
      return 2
    }
    checkpoint = {
      load: () => loaded,
      save: async (state) => {
        await atomicWriteJson(statePath, state)
        loaded = state
      },
    }
  }

  // Import adapter only when explicitly executing.
  let adapter = undefined
  if (execute && args.adapter) {
    const adapterPath = resolve(args.adapter)
    const adapterStat = await fs.lstat(adapterPath).catch(() => null)
    if (!adapterStat || !adapterStat.isFile() || adapterStat.isSymbolicLink()) {
      console.error('Adapter path does not exist or is a symlink')
      return 2
    }
    const mod = await import(pathToFileURL(adapterPath).href)
    adapter = mod.default
    if (typeof adapter !== 'function') {
      console.error('Adapter module must export a default function')
      return 2
    }
  }

  let result
  try {
    result = await runReleaseCheck(manifest, {
      execute,
      testMode,
      ...(args['service-url'] ? { serviceUrl: args['service-url'] } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(adapter ? { adapter } : {}),
    })
  } catch (err) {
    console.error(`Release check failed: ${err.message}`)
    return 2
  }

  // Write outputs.
  if (args.output) {
    const outDir = resolve(args.output)
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(resolve(outDir, 'report.md'), result.markdown, 'utf8')
    const { markdown: _md, ...summary } = result
    await fs.writeFile(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
    console.log(`Output written to ${outDir}`)
  }

  console.log(result.markdown)

  if (result.dryRun) {
    console.log(
      '\nNo verdict: unpaid preview. Re-run with --execute --state --adapter for a live release check.',
    )
    return 0
  }

  return result.decision === 'PASS' ? 0 : result.decision === 'FAIL' ? 1 : 2
}

try {
  process.exitCode = await main()
} catch (error) {
  if (!(error instanceof CliExit)) console.error(`Release check failed: ${error.message}`)
  process.exitCode = error instanceof CliExit ? error.code : 2
}
