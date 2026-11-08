/**
 * Operator reconciliation for paid attempts whose settlement is not proven.
 *
 * Run inside the container, for example:
 *   docker exec viewport-witness node dist/payment-reconcile-cli.js list
 *   docker exec viewport-witness node dist/payment-reconcile-cli.js settled <jobId> --tx <hash> --network <caip2>
 *   docker exec viewport-witness node dist/payment-reconcile-cli.js unpaid <jobId> --evidence "<authoritative proof>"
 *
 * `settled` queues the original job once; the running service picks it up
 * within a minute. `unpaid` is only for authoritative proof that the payment
 * never settled and can no longer settle (for example an EVM authorization
 * that is unused after its validBefore time). A timeout, a generic error or a
 * missing lookup is not proof. The job then fails and its key is released.
 */

import { JobStore } from './db.js'

function arg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

export function runReconcile(argv: string[], store: JobStore, out: (line: string) => void): number {
  const [command, jobId, ...rest] = argv
  if (command === 'list') {
    const rows = store.listUnresolvedPayments()
    if (rows.length === 0) out('No unresolved payments.')
    for (const job of rows) {
      out(JSON.stringify({
        id: job.id,
        kind: job.kind,
        url: job.url,
        createdAt: new Date(job.createdAt).toISOString(),
        state: job.settlementState,
        network: job.settlementNetwork,
        note: job.settlementNote,
        idempotencyKeyBound: Boolean(job.idempotencyKey),
      }))
    }
    return 0
  }
  if (!jobId || (command !== 'settled' && command !== 'unpaid')) {
    out('Usage: list | settled <jobId> --tx <hash> --network <caip2> | unpaid <jobId> --evidence "<proof>"')
    return 2
  }
  const job = store.getJob(jobId)
  if (!job || (job.settlementState !== 'unknown' && job.settlementState !== 'settling')) {
    out(`Job ${jobId} is not an unresolved payment.`)
    return 1
  }
  if (job.settlementState === 'settling') {
    // The service may still be waiting on the facilitator for this payment.
    // Its outcome is recorded automatically, or it becomes unknown on restart.
    out(`Job ${jobId} is still settling; wait until list shows it as unknown.`)
    return 1
  }
  if (command === 'settled') {
    const tx = arg(rest, '--tx')
    const network = arg(rest, '--network') ?? job.settlementNetwork ?? ''
    if (!tx || tx.length < 16 || !network) {
      out('settled requires --tx <transaction hash or signature> and --network <caip2>.')
      return 2
    }
    store.recordSettlement(jobId, { network, transaction: tx })
    out(`Recorded settlement for ${jobId}; the original job is queued.`)
    return 0
  }
  const evidence = arg(rest, '--evidence')
  if (!evidence || evidence.trim().length < 20) {
    out('unpaid requires --evidence describing authoritative proof (at least 20 characters).')
    return 2
  }
  if (!store.markSettlementRejected(jobId, evidence.trim())) {
    out(`Job ${jobId} could not be marked unpaid.`)
    return 1
  }
  out(`Marked ${jobId} unpaid; its idempotency key is released.`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const store = new JobStore(process.env['DB_PATH'] ?? './data/vw.db')
  store.init()
  try {
    process.exitCode = runReconcile(process.argv.slice(2), store, (line) => console.info(line))
  } finally {
    store.close()
  }
}
