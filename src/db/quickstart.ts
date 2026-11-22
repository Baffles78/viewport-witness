import type { DatabaseSync } from 'node:sqlite'
import type { GrowthEvent, GrowthSource } from '../growth.js'
import type { PaymentMode } from '../types.js'

const DAY = 86_400_000
export function initializeQuickstart(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS quickstart_meta (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS quickstart_runs (run_hash TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS quickstart_jobs (
      job_id TEXT PRIMARY KEY, run_hash TEXT, customer_id TEXT, source TEXT NOT NULL,
      created_at INTEGER NOT NULL, paid_at INTEGER, completed_at INTEGER);
    CREATE INDEX IF NOT EXISTS quickstart_jobs_paid ON quickstart_jobs(paid_at);
    CREATE INDEX IF NOT EXISTS quickstart_jobs_run ON quickstart_jobs(run_hash);`)
  // Trust only retained authoritative acceptance markers; never reconstruct expired history.
  db.exec('SAVEPOINT quickstart_seed')
  try {
    const first = db
      .prepare("INSERT OR IGNORE INTO quickstart_meta VALUES('started_at',?)")
      .run(Date.now())
    if (Number(first.changes))
      db.exec(`INSERT OR IGNORE INTO quickstart_jobs
    SELECT j.id,NULL,j.customer_id,g.source,j.created_at,j.created_at,
      CASE WHEN j.status='complete' THEN j.completed_at ELSE NULL END
    FROM jobs j JOIN growth_jobs g ON g.job_id=j.id
    JOIN growth_job_events e ON e.job_id=j.id AND e.event='accepted_paid_job'
    WHERE g.mode='production' AND j.payment_id IS NOT NULL
    AND j.created_at >= (SELECT value FROM quickstart_meta WHERE key='started_at')-7776000000
    ORDER BY j.created_at LIMIT 50000`)
    db.exec('RELEASE quickstart_seed')
  } catch (error) {
    db.exec('ROLLBACK TO quickstart_seed; RELEASE quickstart_seed')
    throw error
  }
}

export class QuickstartStore {
  constructor(private readonly db: DatabaseSync) {}
  private noteCapacityDrop(table: 'quickstart_runs' | 'quickstart_jobs', key: string): void {
    const column = table === 'quickstart_runs' ? 'run_hash' : 'job_id'
    if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).get(key))
      this.db
        .prepare(
          "INSERT INTO quickstart_meta VALUES('capacity_drops',1) ON CONFLICT(key) DO UPDATE SET value=MIN(value+1,2147483647)",
        )
        .run()
  }
  private attempt(action: () => void): void {
    try {
      action()
    } catch {
      try {
        this.db
          .prepare(
            "INSERT INTO quickstart_meta VALUES('write_failures',1) ON CONFLICT(key) DO UPDATE SET value=MIN(value+1,2147483647)",
          )
          .run()
      } catch {
        /* Even diagnostics are optional. */
      }
    }
  }
  prune(now = Date.now()): void {
    this.attempt(() => {
      this.db.prepare('DELETE FROM quickstart_runs WHERE started_at < ?').run(now - 30 * DAY)
      this.db.prepare('DELETE FROM quickstart_jobs WHERE created_at < ?').run(now - 90 * DAY)
    })
  }
  start(hash: string | undefined, source: GrowthSource, mode: PaymentMode, now = Date.now()): void {
    if (!hash || source !== 'agent-client' || mode !== 'production') return
    this.attempt(() => {
      this.prune(now)
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO quickstart_runs SELECT ?,?
        WHERE (SELECT COUNT(*) FROM quickstart_runs)<10000`,
        )
        .run(hash, now)
      if (!Number(inserted.changes)) this.noteCapacityDrop('quickstart_runs', hash)
    })
  }
  bindJob(
    id: string,
    context?: { source: GrowthSource; mode: PaymentMode; quickstartRunHash?: string },
  ): void {
    if (context?.mode !== 'production') return
    this.attempt(() => {
      this.prune()
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO quickstart_jobs
        SELECT id,?,customer_id,?,created_at,NULL,NULL FROM jobs WHERE id=?
        AND (SELECT COUNT(*) FROM quickstart_jobs)<50000`,
        )
        .run(context.quickstartRunHash ?? null, context.source, id)
      if (!Number(inserted.changes)) this.noteCapacityDrop('quickstart_jobs', id)
    })
  }
  observe(id: string, event: GrowthEvent, now = Date.now()): void {
    if (!['accepted_paid_job', 'job_complete'].includes(event)) return
    this.attempt(() => {
      if (event === 'accepted_paid_job')
        this.db
          .prepare(
            `UPDATE quickstart_jobs
        SET paid_at=COALESCE(paid_at,?),customer_id=(SELECT customer_id FROM jobs WHERE id=?)
        WHERE job_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND payment_id IS NOT NULL
        AND status!='payment_pending' AND (settlement_state IS NULL OR settlement_state='settled'))`,
          )
          .run(now, id, id, id)
      else
        this.db
          .prepare(
            'UPDATE quickstart_jobs SET completed_at=COALESCE(completed_at,?) WHERE job_id=? AND paid_at IS NOT NULL',
          )
          .run(now, id)
    })
  }
  summary({
    now = Date.now(),
    excludedJobIds = [],
  }: { now?: number; excludedJobIds?: string[] } = {}) {
    try {
      const jobs = this.db
        .prepare(
          'SELECT * FROM quickstart_jobs WHERE created_at>=? AND created_at<=? ORDER BY paid_at,job_id',
        )
        .all(now - 90 * DAY, now) as unknown as Array<{
        job_id: string
        run_hash: string | null
        customer_id: string | null
        source: string
        paid_at: number | null
        completed_at: number | null
      }>
      const excluded = new Set(excludedJobIds)
      const controlledRuns = new Set(
        jobs
          .filter((j) => excluded.has(j.job_id) || ['monitor', 'test-client'].includes(j.source))
          .map((j) => j.run_hash),
      )
      const runs = this.db
        .prepare(
          'SELECT run_hash,started_at FROM quickstart_runs WHERE started_at>=? AND started_at<=?',
        )
        .all(now - 30 * DAY, now)
        .filter((r) => !controlledRuns.has(String(r.run_hash)))
      const paid = jobs.filter(
        (j) =>
          j.paid_at !== null &&
          j.paid_at <= now &&
          !excluded.has(j.job_id) &&
          !['monitor', 'test-client'].includes(j.source),
      )
      const first = new Map<string, (typeof paid)[number]>()
      for (const job of paid)
        if (job.customer_id && !first.has(job.customer_id)) first.set(job.customer_id, job)
      const starts = new Map(runs.map((r) => [String(r.run_hash), Number(r.started_at)]))
      const purchased = new Set<string>(),
        completed = new Set<string>(),
        identified = new Set<string>(),
        firstPurchased = new Set<string>()
      const matched = (job: (typeof paid)[number]) =>
        Boolean(
          job.run_hash && starts.has(job.run_hash) && job.paid_at! >= starts.get(job.run_hash)!,
        )
      for (const job of paid)
        if (matched(job)) {
          purchased.add(job.run_hash!)
          if (job.customer_id) identified.add(job.run_hash!)
          if (job.completed_at !== null && job.completed_at <= now) completed.add(job.run_hash!)
        }
      for (const job of first.values()) if (matched(job)) firstPurchased.add(job.run_hash!)
      const capacityDrops = Number(
        this.db.prepare("SELECT value FROM quickstart_meta WHERE key='capacity_drops'").get()
          ?.value ?? 0,
      )
      return {
        available: true,
        windowDays: 30,
        payerHistoryDays: 90,
        quickstartOpens: Number(
          this.db
            .prepare(
              `SELECT COALESCE(SUM(count),0) AS n FROM growth_daily
          WHERE event='quickstart_open' AND mode='production' AND source NOT IN ('monitor','test-client')
          AND day>=? AND day<=?`,
            )
            .get(
              new Date(now - 29 * DAY).toISOString().slice(0, 10),
              new Date(now).toISOString().slice(0, 10),
            )?.n,
        ),
        trackingStartedAt: new Date(
          Number(
            this.db.prepare("SELECT value FROM quickstart_meta WHERE key='started_at'").get()
              ?.value,
          ),
        ).toISOString(),
        startedRuns: runs.length,
        purchasedRuns: purchased.size,
        firstObservedPurchaseRuns: firstPurchased.size,
        completedReportRuns: completed.size,
        purchasedRunsMissingPayerIdentity: purchased.size - identified.size,
        observedWriteFailures: Number(
          this.db.prepare("SELECT value FROM quickstart_meta WHERE key='write_failures'").get()
            ?.value ?? 0,
        ),
        capacityDrops,
        purchaseRate: runs.length ? purchased.size / runs.length : null,
        firstObservedPurchaseRate: runs.length ? firstPurchased.size / runs.length : null,
        excludedControlledJobs: excluded.size,
        capacityReached:
          capacityDrops > 0 ||
          Number(this.db.prepare('SELECT COUNT(*) AS n FROM quickstart_runs').get()?.n) >= 10000 ||
          jobs.length >= 50000,
        limitations: [
          'Distinct anonymous setup runs, not verified agents; retries deduplicate, new run directories split identity.',
          'First observed payer uses retained 90-day production history plus available pre-cutover jobs, not lifetime purchase history. Shared wallets merge identities; missing customer attribution cannot prove first purchase.',
          'Direct GitHub visits, old clients, disabled telemetry and missing/failed writes are unobserved. Counts are observational, not proof that the guide caused a purchase.',
          'Source/run labels are caller-declared. Monitor/test-client and operator-known controlled job IDs are excluded from purchases and their matched run denominator. Unlabeled operator activity cannot be inferred.',
        ],
      }
    } catch {
      return {
        available: false,
        reason: 'Quickstart measurement unavailable; never interpret missing data as zero.',
      }
    }
  }
}
