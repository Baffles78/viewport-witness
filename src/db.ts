import { DatabaseSync } from 'node:sqlite'
import type { JobKind, JobRecord, JobStatus, PageAssertion } from './types.js'
import {
  growthContext,
  GROWTH_SOURCES,
  GROWTH_PRODUCTS,
  GROWTH_EVENTS,
  type GrowthSource,
  type GrowthProduct,
  type GrowthEvent,
} from './growth.js'
import type { PaymentMode } from './types.js'

export class JobStore {
  private db: DatabaseSync | null = null

  constructor(private readonly dbPath: string) {}

  init({ readOnly = false }: { readOnly?: boolean } = {}): void {
    this.db = new DatabaseSync(this.dbPath, { readOnly })
    if (readOnly) return
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.createSchema()
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS growth_daily (
        day TEXT NOT NULL, product TEXT NOT NULL, source TEXT NOT NULL, event TEXT NOT NULL,
        mode TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,product,source,event,mode));
        CREATE TABLE IF NOT EXISTS growth_jobs (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        source TEXT NOT NULL, mode TEXT NOT NULL);`)
    } catch {
      console.warn('Growth measurement unavailable; job service remains authoritative.')
    }
  }

  private get conn(): DatabaseSync {
    if (!this.db) throw new Error('JobStore not initialized')
    return this.db
  }

  private createSchema(): void {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        idempotency_key TEXT UNIQUE,
        payment_id TEXT,
        customer_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        expires_at INTEGER NOT NULL,
        report_path TEXT,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_payment_id
        ON jobs(payment_id) WHERE payment_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS screenshots (
        job_id TEXT NOT NULL,
        viewport TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY (job_id, viewport)
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    const columns = this.conn.prepare('PRAGMA table_info(jobs)').all() as unknown as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'customer_id')) {
      this.conn.exec('ALTER TABLE jobs ADD COLUMN customer_id TEXT')
    }
    if (!columns.some((column) => column.name === 'kind')) {
      this.conn.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'check'")
    }
    if (!columns.some((column) => column.name === 'request_json')) {
      this.conn.exec("ALTER TABLE jobs ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}'")
    }
    if (!columns.some((column) => column.name === 'baseline_job_id')) {
      this.conn.exec('ALTER TABLE jobs ADD COLUMN baseline_job_id TEXT')
    }
    this.conn.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_customer_id ON jobs(customer_id) WHERE customer_id IS NOT NULL',
    )
  }

  createJob(params: {
    id: string
    url: string
    idempotencyKey: string | null
    paymentId?: string
    customerId?: string
    expiresAt: number
    kind?: JobKind
    request?: { assertions?: PageAssertion[]; maxOutputTokens?: number }
    baselineJobId?: string
    initialStatus?: 'queued' | 'payment_pending'
  }): JobRecord {
    const now = Date.now()
    this.conn
      .prepare(
        `INSERT INTO jobs (id, url, status, idempotency_key, payment_id, customer_id, created_at, expires_at, kind, request_json, baseline_job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.url,
        params.initialStatus ?? 'queued',
        params.idempotencyKey,
        params.paymentId ?? null,
        params.customerId ?? null,
        now,
        params.expiresAt,
        params.kind ?? 'check',
        JSON.stringify(params.request ?? {}),
        params.baselineJobId ?? null,
      )

    if (params.idempotencyKey) {
      this.conn
        .prepare(
          `INSERT OR IGNORE INTO idempotency_keys (key, job_id, created_at) VALUES (?, ?, ?)`,
        )
        .run(params.idempotencyKey, params.id, now)
    }

    try {
      const context = growthContext.getStore()
      this.conn
        .prepare('INSERT OR IGNORE INTO growth_jobs(job_id,source,mode) VALUES(?,?,?)')
        .run(params.id, context?.source ?? 'unknown', context?.mode ?? 'unknown')
    } catch {
      /* Measurement cannot block an accepted job. */
    }
    return this.getJob(params.id) as JobRecord
  }

  recordGrowth(
    product: GrowthProduct,
    source: GrowthSource,
    event: GrowthEvent,
    mode: PaymentMode,
    now = Date.now(),
  ): void {
    if (
      !GROWTH_PRODUCTS.includes(product) ||
      !GROWTH_SOURCES.includes(source) ||
      !GROWTH_EVENTS.includes(event) ||
      !['test', 'testnet', 'production'].includes(mode) ||
      !Number.isFinite(now)
    )
      return
    try {
      const day = new Date(now).toISOString().slice(0, 10)
      this.pruneGrowthDaily(now)
      this.conn
        .prepare(
          `INSERT INTO growth_daily(day,product,source,event,mode,count) VALUES(?,?,?,?,?,1)
        ON CONFLICT(day,product,source,event,mode) DO UPDATE SET count=MIN(count+1,2147483647)`,
        )
        .run(day, product, source, event, mode)
    } catch {
      /* Measurement must never affect request delivery. */
    }
  }

  pruneGrowthDaily(now = Date.now()): void {
    try {
      this.conn
        .prepare('DELETE FROM growth_daily WHERE day < ? OR day > ?')
        .run(
          new Date(now - 29 * 86400000).toISOString().slice(0, 10),
          new Date(now).toISOString().slice(0, 10),
        )
    } catch {
      /* Optional anonymous counters never block governed job cleanup. */
    }
  }

  growthSummary({
    now = Date.now(),
    excludedJobIds = [],
    costPerWorkerSecondUsdc,
  }: { now?: number; excludedJobIds?: string[]; costPerWorkerSecondUsdc?: number } = {}) {
    if (
      !Number.isFinite(now) ||
      excludedJobIds.length > 100 ||
      excludedJobIds.some((id) => !/^[a-zA-Z0-9-]{1,80}$/.test(id)) ||
      (costPerWorkerSecondUsdc !== undefined &&
        (!Number.isFinite(costPerWorkerSecondUsdc) || costPerWorkerSecondUsdc < 0))
    )
      throw new Error('Invalid summary options')
    const cutoff = now - 30 * 86400000
    const excluded = new Set(excludedJobIds)
    const jobs = (
      this.conn
        .prepare(
          `SELECT j.id,j.kind,j.status,j.error,j.payment_id,j.customer_id,j.started_at,j.completed_at,
      COALESCE(g.source,'unknown') AS source,COALESCE(g.mode,'unknown') AS mode FROM jobs j
      LEFT JOIN growth_jobs g ON g.job_id=j.id WHERE j.created_at>=? AND j.created_at<=?`,
        )
        .all(cutoff, now) as unknown as Array<{
        id: string
        kind: string
        status: string
        error: string | null
        payment_id: string | null
        customer_id: string | null
        started_at: number | null
        completed_at: number | null
        source: string
        mode: string
      }>
    ).filter((job) => !excluded.has(job.id))
    const paid = jobs.filter(
      (job) =>
        job.payment_id !== null &&
        job.status !== 'payment_pending' &&
        job.error !== 'payment_not_settled' &&
        job.mode === 'production',
    )
    const customers = new Map<string, number>()
    for (const job of paid)
      if (job.customer_id) customers.set(job.customer_id, (customers.get(job.customer_id) ?? 0) + 1)
    const groups = new Map<
      string,
      {
        product: string
        source: string
        mode: string
        paidJobs: number
        completed: number
        failed: number
        attributedJobs: number
        observedWorkerSeconds: number
      }
    >()
    for (const job of paid) {
      const key = `${job.kind}:${job.source}:${job.mode}`
      const group = groups.get(key) ?? {
        product: job.kind,
        source: job.source,
        mode: job.mode,
        paidJobs: 0,
        completed: 0,
        failed: 0,
        attributedJobs: 0,
        observedWorkerSeconds: 0,
      }
      group.paidJobs++
      if (job.status === 'complete') group.completed++
      if (job.status === 'failed') group.failed++
      if (job.customer_id) group.attributedJobs++
      if (
        job.started_at !== null &&
        job.completed_at !== null &&
        job.completed_at >= job.started_at
      )
        group.observedWorkerSeconds += (job.completed_at - job.started_at) / 1000
      groups.set(key, group)
    }
    const seconds = [...groups.values()].reduce(
      (sum, group) => sum + group.observedWorkerSeconds,
      0,
    )
    let documents: unknown[] = []
    try {
      documents = this.conn
        .prepare(
          'SELECT day,product,source,event,mode,count FROM growth_daily WHERE day>=? AND day<=? ORDER BY day,product,source,event',
        )
        .all(
          new Date(now - 29 * 86400000).toISOString().slice(0, 10),
          new Date(now).toISOString().slice(0, 10),
        )
    } catch {
      /* Old/missing analytics are explicitly unavailable. */
    }
    return {
      schema: 'viewport-witness-growth/v1',
      observedAt: new Date(now).toISOString(),
      windowDays: 30,
      documents,
      products: [...groups.values()],
      paidJobs: paid.length,
      completed: paid.filter((j) => j.status === 'complete').length,
      trackedCustomerIdentities: customers.size,
      repeatTrackedIdentities: [...customers.values()].filter((count) => count > 1).length,
      attributedJobs: paid.filter((j) => j.customer_id).length,
      excludedControlledJobs: excludedJobIds.length,
      testOrTestnetJobs: jobs.filter((j) => ['test', 'testnet'].includes(j.mode)).length,
      unknownModePaymentIdentityJobs: jobs.filter(
        (j) => j.mode === 'unknown' && j.payment_id !== null,
      ).length,
      observedWorkerSeconds: seconds,
      estimatedWorkerCostUsdc:
        costPerWorkerSecondUsdc === undefined ? null : seconds * costPerWorkerSecondUsdc,
      limitations: [
        'Sources are caller-declared or protocol labels, not verified acquisition attribution.',
        'Document/challenge counts are requests, not unique visitors or a matched conversion funnel.',
        'Job metrics cover retained jobs only; default retention is seven days. Historical unknown mode is not proven production.',
        'Exclude operator-known smoke/indexing job IDs before interpreting external demand.',
        'Worker time excludes queue time and may omit interrupted attempts. Cost is unknown without an operator rate; a supplied rate is an estimate, not measured expense.',
        'No customer labels, payment identifiers or target URLs are returned.',
      ],
    }
  }

  getJob(id: string): JobRecord | null {
    const row = this.conn.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      RawJobRow | undefined
    return row ? rowToRecord(row) : null
  }

  getJobByIdempotencyKey(key: string): JobRecord | null {
    const row = this.conn
      .prepare(
        `SELECT j.* FROM jobs j
         JOIN idempotency_keys ik ON ik.job_id = j.id
         WHERE ik.key = ?`,
      )
      .get(key) as RawJobRow | undefined
    return row ? rowToRecord(row) : null
  }

  getJobByPaymentId(paymentId: string): JobRecord | null {
    const row = this.conn.prepare('SELECT * FROM jobs WHERE payment_id = ?').get(paymentId) as
      RawJobRow | undefined
    return row ? rowToRecord(row) : null
  }

  listJobsByStatuses(statuses: JobStatus[]): JobRecord[] {
    if (statuses.length === 0) return []
    const placeholders = statuses.map(() => '?').join(', ')
    const rows = this.conn
      .prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...statuses) as unknown as RawJobRow[]
    return rows.map(rowToRecord)
  }

  updateJobStatus(
    id: string,
    status: JobStatus,
    extra?: {
      startedAt?: number
      completedAt?: number
      reportPath?: string
      error?: string
      retryCount?: number
    },
  ): void {
    const sets = ['status = ?']
    const values: Array<string | number> = [status]

    if (extra?.startedAt !== undefined) {
      sets.push('started_at = ?')
      values.push(extra.startedAt)
    }
    if (extra?.completedAt !== undefined) {
      sets.push('completed_at = ?')
      values.push(extra.completedAt)
    }
    if (extra?.reportPath !== undefined) {
      sets.push('report_path = ?')
      values.push(extra.reportPath)
    }
    if (extra?.error !== undefined) {
      sets.push('error = ?')
      values.push(extra.error)
    }
    if (extra?.retryCount !== undefined) {
      sets.push('retry_count = ?')
      values.push(extra.retryCount)
    }

    values.push(id)
    this.conn.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  markJobRetryable(id: string): void {
    this.conn
      .prepare(
        `UPDATE jobs SET status = 'retryable', started_at = NULL,
         retry_count = retry_count + 1 WHERE id = ?`,
      )
      .run(id)
  }

  activatePaymentPendingJob(id: string): boolean {
    const result = this.conn
      .prepare("UPDATE jobs SET status = 'queued' WHERE id = ? AND status = 'payment_pending'")
      .run(id)
    return Number(result.changes) === 1
  }

  failPaymentPendingJob(id: string, error: string): boolean {
    const result = this.conn
      .prepare(
        "UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'payment_pending'",
      )
      .run(Date.now(), error.slice(0, 1000), id)
    return Number(result.changes) === 1
  }

  listExpiredJobs(beforeMs: number): JobRecord[] {
    const rows = this.conn
      .prepare('SELECT * FROM jobs WHERE expires_at < ?')
      .all(beforeMs) as unknown as RawJobRow[]
    return rows.map(rowToRecord)
  }

  deleteJob(id: string): void {
    this.conn.exec('BEGIN IMMEDIATE')
    try {
      this.conn.prepare('DELETE FROM screenshots WHERE job_id = ?').run(id)
      this.conn.prepare('DELETE FROM idempotency_keys WHERE job_id = ?').run(id)
      this.conn.prepare('DELETE FROM jobs WHERE id = ?').run(id)
      this.conn.exec('COMMIT')
    } catch (error) {
      this.conn.exec('ROLLBACK')
      throw error
    }
  }

  recordScreenshot(
    jobId: string,
    viewport: string,
    path: string,
    sha256: string,
    bytes: number,
  ): void {
    this.conn
      .prepare(
        `INSERT OR REPLACE INTO screenshots (job_id, viewport, path, sha256, bytes)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jobId, viewport, path, sha256, bytes)
  }

  getScreenshot(
    jobId: string,
    viewport: string,
  ): { path: string; sha256: string; bytes: number } | null {
    const row = this.conn
      .prepare('SELECT path, sha256, bytes FROM screenshots WHERE job_id = ? AND viewport = ?')
      .get(jobId, viewport) as { path: string; sha256: string; bytes: number } | undefined
    return row ?? null
  }

  getIdempotencyEntry(key: string): { jobId: string } | null {
    const row = this.conn.prepare('SELECT job_id FROM idempotency_keys WHERE key = ?').get(key) as
      { job_id: string } | undefined
    return row ? { jobId: row.job_id } : null
  }

  setIdempotencyEntry(key: string, jobId: string): void {
    this.conn
      .prepare(`INSERT OR IGNORE INTO idempotency_keys (key, job_id, created_at) VALUES (?, ?, ?)`)
      .run(key, jobId, Date.now())
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

interface RawJobRow {
  id: string
  url: string
  status: string
  idempotency_key: string | null
  payment_id: string | null
  customer_id: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  expires_at: number
  report_path: string | null
  error: string | null
  retry_count: number
  kind: string
  request_json: string
  baseline_job_id: string | null
}

function rowToRecord(row: RawJobRow): JobRecord {
  let request: JobRecord['request'] = {}
  try {
    request = JSON.parse(row.request_json ?? '{}') as JobRecord['request']
  } catch {
    request = {}
  }
  return {
    id: row.id,
    url: row.url,
    status: row.status as JobStatus,
    idempotencyKey: row.idempotency_key,
    paymentId: row.payment_id,
    customerId: row.customer_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    reportPath: row.report_path,
    error: row.error,
    retryCount: row.retry_count,
    kind: (row.kind ?? 'check') as JobKind,
    request,
    baselineJobId: row.baseline_job_id ?? null,
  }
}
