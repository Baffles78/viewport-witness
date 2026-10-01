import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { buildRecheckManifest } from '../dist/recheck.js'

async function read(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new Error('Expected bounded regular JSON evidence')
  return JSON.parse(await fs.readFile(file, 'utf8'))
}
try {
  const args = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (
      !['--manifest', '--summary', '--state', '--run-id', '--max-budget-usdc', '--output'].includes(
        key,
      ) ||
      args[key] ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--')
    )
      throw new Error(
        'Expected manifest, summary, state, new run-id, max-budget-usdc and output flags',
      )
    args[key] = argv[i + 1]
  }
  if (Object.keys(args).length !== 6) throw new Error('All six planning arguments are required')
  const result = buildRecheckManifest(
    await read(args['--manifest']),
    await read(args['--summary']),
    await read(args['--state']),
    { runId: args['--run-id'], maxBudgetUsdc: args['--max-budget-usdc'] },
  )
  if (result.manifest)
    await fs.writeFile(resolve(args['--output']), JSON.stringify(result.manifest, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    })
  console.log(JSON.stringify(result))
  process.exitCode = result.status === 'resume_or_reconcile' ? 2 : 0
} catch {
  console.error(
    'Recheck planning refused. Check evidence consistency, a distinct run ID, approved budget and a new output path. No payment attempted.',
  )
  process.exitCode = 2
}
