import { DatabaseSync } from 'node:sqlite'
import type { JobKind, JobRecord, JobStatus, PageAssertion } from './types.js'

export class JobStore {
  private db: DatabaseSync | null = null

  constructor(private readonly dbPath: string) {}

  init(): void {
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.createSchema()
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
    request?: { assertions?: PageAssertion[] }
    baselineJobId?: string
  }): JobRecord {
    const now = Date.now()
    this.conn
      .prepare(
        `INSERT INTO jobs (id, url, status, idempotency_key, payment_id, customer_id, created_at, expires_at, kind, request_json, baseline_job_id)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.url,
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

    return this.getJob(params.id) as JobRecord
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
