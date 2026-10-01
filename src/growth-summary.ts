import { JobStore } from './db.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 1)
    throw new Error('Usage: node dist/growth-summary.js /absolute/path/to/vw.db')
  const store = new JobStore(resolve(args[0] as string))
  store.init({ readOnly: true })
  try {
    const excludedJobIds = (process.env.VW_CONTROLLED_JOB_IDS ?? '').split(',').filter(Boolean)
    const rawCost = process.env.VW_ESTIMATED_COST_PER_WORKER_SECOND_USDC
    const summaryArgs =
      rawCost === undefined
        ? { excludedJobIds }
        : { excludedJobIds, costPerWorkerSecondUsdc: Number(rawCost) }
    process.stdout.write(JSON.stringify(store.growthSummary(summaryArgs), null, 2) + '\n')
  } finally {
    store.close()
  }
}
