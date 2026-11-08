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
  private growthWriteFailures = 0

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
        source TEXT NOT NULL, mode TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS growth_job_events (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, event TEXT NOT NULL,
        PRIMARY KEY(job_id,event));`)
    } catch {
      console.warn('Growth measurement unavailable; job service remains authoritative.')
      this.growthWriteFailures++
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

      CREATE TABLE IF NOT EXISTS archive_snapshots (
        id TEXT PRIMARY KEY,
        url_key TEXT NOT NULL,
        url TEXT NOT NULL,
        source_job_id TEXT NOT NULL UNIQUE,
        captured_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        decision TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        snapshot_path TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_archive_url_captured
        ON archive_snapshots(url_key, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_archive_expires_at ON archive_snapshots(expires_at);
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
    // Paid admission record. NULL for test-mode and legacy rows. Values:
    // settling (settle may be in flight), settled (authoritative success),
    // unknown (outcome not proven), rejected (proven unpaid by operator evidence).
    for (const [name, type] of [
      ['settlement_state', 'TEXT'],
      ['settlement_network', 'TEXT'],
      ['settlement_tx', 'TEXT'],
      ['settlement_note', 'TEXT'],
      ['settlement_updated_at', 'INTEGER'],
    ] as const) {
      if (!columns.some((column) => column.name === name)) {
        this.conn.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`)
      }
    }
    this.conn.exec(
      'CREATE INDEX IF NOT EXISTS idx_jobs_settlement_state ON jobs(settlement_state) WHERE settlement_state IS NOT NULL',
    )
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
      this.recordJobGrowth(params.id, 'job_created')
      if (params.paymentId && (params.initialStatus ?? 'queued') !== 'payment_pending')
        this.recordJobGrowth(params.id, 'accepted_paid_job')
    } catch {
      /* Measurement cannot block an accepted job. */
      this.growthWriteFailures++
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
      this.growthWriteFailures++
    }
  }

  // Observation only: a failed measurement must not change job or payment decisions.
  // A per-job/event marker and daily increment commit together, even inside a caller transaction.
  private recordJobGrowth(id: string, event: GrowthEvent): void {
    let savepoint = false
    try {
      const row = this.conn.prepare(`SELECT j.kind,j.payment_id,g.source,g.mode FROM jobs j
        JOIN growth_jobs g ON g.job_id=j.id WHERE j.id=?`).get(id) as
        { kind: GrowthProduct; source: GrowthSource; mode: PaymentMode; payment_id: string | null } | undefined
      if (!row || !GROWTH_PRODUCTS.includes(row.kind) || !GROWTH_SOURCES.includes(row.source)
        || !['test', 'testnet', 'production'].includes(row.mode)) return
      if (event === 'accepted_paid_job' && (row.mode === 'test' || !row.payment_id)) return
      const now = Date.now()
      this.pruneGrowthDaily(now)
      this.conn.exec('SAVEPOINT growth_measurement')
      savepoint = true
      const inserted = this.conn.prepare('INSERT OR IGNORE INTO growth_job_events(job_id,event) VALUES(?,?)').run(id, event)
      if (Number(inserted.changes) === 1) {
        this.conn.prepare(`INSERT INTO growth_daily(day,product,source,event,mode,count) VALUES(?,?,?,?,?,1)
          ON CONFLICT(day,product,source,event,mode) DO UPDATE SET count=MIN(count+1,2147483647)`)
          .run(new Date(now).toISOString().slice(0, 10), row.kind, row.source, event, row.mode)
      }
      this.conn.exec('RELEASE growth_measurement')
    } catch {
      this.growthWriteFailures++
      if (savepoint) {
        try { this.conn.exec('ROLLBACK TO growth_measurement; RELEASE growth_measurement') } catch { /* Optional observer only. */ }
      }
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
    let dailyCountersAvailable = true
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
      dailyCountersAvailable = false
    }
    return {
      schema: 'viewport-witness-growth/v1',
      observedAt: new Date(now).toISOString(),
      windowDays: 30,
      documents,
      counterObservation: {
        dailyReadAvailable: dailyCountersAvailable,
        writeFailuresThisProcess: this.growthWriteFailures,
        history: 'Write failures before this process are unknown; anonymous counters may be incomplete.',
      },
      products: [...groups.values()],
      protocolUsage: {
        buyerTypeVerification: 'not_available',
        description:
          'MCP and agent-client labels describe access paths, not verified AI customers.',
        sources: ['mcp', 'agent-client', 'github-action'].map((source) => {
          const selected = paid.filter((job) => job.source === source)
          const identities = new Map<string, number>()
          for (const job of selected)
            if (job.customer_id)
              identities.set(job.customer_id, (identities.get(job.customer_id) ?? 0) + 1)
          const workerSeconds = [...groups.values()]
            .filter((group) => group.source === source)
            .reduce((sum, group) => sum + group.observedWorkerSeconds, 0)
          return {
            source,
            paidJobs: selected.length,
            completed: selected.filter((job) => job.status === 'complete').length,
            failed: selected.filter((job) => job.status === 'failed').length,
            trackedCustomerIdentities: identities.size,
            repeatTrackedIdentities: [...identities.values()].filter((count) => count > 1).length,
            observedWorkerSeconds: workerSeconds,
            estimatedWorkerCostUsdc:
              costPerWorkerSecondUsdc === undefined
                ? null
                : workerSeconds * costPerWorkerSecondUsdc,
          }
        }),
      },
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
        'HTTP stage counters count attempts/responses, not unique jobs. A payment header is unverified presence; payment acceptance reads downstream settled state and may include repeated accepted responses.',
        'Parser rejection counters observe normalized JSON-parser error categories without changing response status. input_rejected_after_parser counts later 400/422 rejection responses.',
        'Monitor/test-client source labels are self-declared, not authenticated controlled clients. HTTP stage counters do not cover MCP payments; job metrics and anonymous daily counters have different retention windows.',
        'Job metrics cover retained jobs only; default retention is seven days. Historical unknown mode is not proven production.',
        'Anonymous lifecycle counters retain thirty recorded days after private job deletion and deduplicate each job/event. accepted_paid_job observes existing settled-state admission, not a bank or chain revenue reconciliation. Missing/unknown job attribution and measurement failures can leave counters incomplete.',
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
    if (status === 'complete') this.recordJobGrowth(id, 'job_complete')
    if (status === 'failed') this.recordJobGrowth(id, 'job_failed')
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
    if (Number(result.changes) === 1) this.recordJobGrowth(id, 'accepted_paid_job')
    return Number(result.changes) === 1
  }

  failPaymentPendingJob(id: string, error: string): boolean {
    const result = this.conn
      .prepare(
        "UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'payment_pending'",
      )
      .run(Date.now(), error.slice(0, 1000), id)
    if (Number(result.changes) === 1) this.recordJobGrowth(id, 'payment_pending_failed')
    return Number(result.changes) === 1
  }

  // Paid admission ---------------------------------------------------------
  //
  // A paid attempt is a jobs row written in one transaction after the
  // facilitator verified the payment and before settlement is dispatched. Its
  // id is the job id the buyer will receive, and it carries the exact intent.

  countUnresolvedPayments(customerId?: string): number {
    const row = (customerId
      ? this.conn
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE settlement_state IN ('settling','unknown') AND customer_id = ?")
          .get(customerId)
      : this.conn
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE settlement_state IN ('settling','unknown')")
          .get()) as { n: number }
    return Number(row.n)
  }

  listUnresolvedPayments(): JobRecord[] {
    const rows = this.conn
      .prepare(
        "SELECT * FROM jobs WHERE settlement_state IN ('settling','unknown') ORDER BY created_at ASC",
      )
      .all() as unknown as RawJobRow[]
    return rows.map(rowToRecord)
  }

  admitPaymentAttempt(params: {
    id: string
    url: string
    kind: JobKind
    request: { assertions?: PageAssertion[]; maxOutputTokens?: number }
    baselineJobId?: string
    idempotencyKey?: string
    paymentId: string
    paymentAliases?: string[]
    customerId?: string
    network: string
    expiresAt: number
    unresolvedLimit: number
    payerUnresolvedLimit?: number
  }):
    | { admitted: true }
    | { admitted: false; reason: AdmissionRefusal; existing?: JobRecord } {
    const now = Date.now()
    this.conn.exec('BEGIN IMMEDIATE')
    let result:
      | { admitted: true }
      | { admitted: false; reason: AdmissionRefusal; existing?: JobRecord }
    try {
      let byPayment = this.getJobByPaymentId(params.paymentId)
      for (const alias of params.paymentAliases ?? []) {
        if (byPayment) break
        byPayment = this.getJobByPaymentId(alias)
      }
      const byKey = params.idempotencyKey ? this.getJobByIdempotencyKey(params.idempotencyKey) : null
      if (byPayment) {
        result = { admitted: false, reason: 'payment_exists', existing: byPayment }
      } else if (byKey) {
        result = { admitted: false, reason: 'key_bound', existing: byKey }
      } else if (
        params.customerId &&
        params.payerUnresolvedLimit !== undefined &&
        this.countUnresolvedPayments(params.customerId) >= params.payerUnresolvedLimit
      ) {
        result = { admitted: false, reason: 'payer_busy' }
      } else if (this.countUnresolvedPayments() >= params.unresolvedLimit) {
        result = { admitted: false, reason: 'capacity' }
      } else {
        this.conn
          .prepare(
            `INSERT INTO jobs (id, url, status, idempotency_key, payment_id, customer_id, created_at,
               expires_at, kind, request_json, baseline_job_id, settlement_state, settlement_network,
               settlement_updated_at)
             VALUES (?, ?, 'payment_pending', ?, ?, ?, ?, ?, ?, ?, ?, 'settling', ?, ?)`,
          )
          .run(
            params.id,
            params.url,
            params.idempotencyKey ?? null,
            params.paymentId,
            params.customerId ?? null,
            now,
            params.expiresAt,
            params.kind,
            JSON.stringify(params.request),
            params.baselineJobId ?? null,
            params.network.slice(0, 100),
            now,
          )
        if (params.idempotencyKey) {
          this.conn
            .prepare('INSERT INTO idempotency_keys (key, job_id, created_at) VALUES (?, ?, ?)')
            .run(params.idempotencyKey, params.id, now)
        }
        result = { admitted: true }
      }
      this.conn.exec('COMMIT')
    } catch (error) {
      try { this.conn.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
    if (result.admitted) {
      try {
        const context = growthContext.getStore()
        this.conn
          .prepare('INSERT OR IGNORE INTO growth_jobs(job_id,source,mode) VALUES(?,?,?)')
          .run(params.id, context?.source ?? 'unknown', context?.mode ?? 'unknown')
        this.recordJobGrowth(params.id, 'job_created')
      } catch {
        this.growthWriteFailures++
      }
    }
    return result
  }

  // Authoritative settlement success: record the receipt and hand the original
  // job to the worker queue in one statement. Idempotent.
  recordSettlement(id: string, settlement: { network: string; transaction: string }): boolean {
    const result = this.conn
      .prepare(
        `UPDATE jobs SET settlement_state = 'settled', settlement_network = ?, settlement_tx = ?,
           settlement_updated_at = ?,
           expires_at = MAX(expires_at, ? + (expires_at - created_at)),
           status = CASE WHEN status = 'payment_pending' THEN 'queued' ELSE status END
         WHERE id = ? AND settlement_state IN ('settling', 'unknown')`,
      )
      .run(
        settlement.network.slice(0, 100),
        settlement.transaction.slice(0, 200),
        Date.now(),
        Date.now(),
        id,
      )
    const changed = Number(result.changes) === 1
    if (changed) this.recordJobGrowth(id, 'accepted_paid_job')
    return changed || this.getJob(id)?.settlementState === 'settled'
  }

  markSettlementUnknown(id: string, note: string): boolean {
    const result = this.conn
      .prepare(
        `UPDATE jobs SET settlement_state = 'unknown', settlement_note = ?, settlement_updated_at = ?
         WHERE id = ? AND settlement_state = 'settling'`,
      )
      .run(note.slice(0, 500), Date.now(), id)
    return Number(result.changes) === 1
  }

  // Startup recovery: any attempt still settling was interrupted mid-settle.
  // Its outcome is not proven, so it becomes unknown, never failed or expired.
  recoverInterruptedSettlements(): number {
    const result = this.conn
      .prepare(
        `UPDATE jobs SET settlement_state = 'unknown',
           settlement_note = COALESCE(settlement_note, 'interrupted_during_settlement'),
           settlement_updated_at = ?
         WHERE settlement_state = 'settling'`,
      )
      .run(Date.now())
    return Number(result.changes)
  }

  // Operator-only: authoritative evidence proved the payment never settled
  // and cannot settle later. The key is released so the buyer may retry.
  markSettlementRejected(id: string, evidence: string): boolean {
    this.conn.exec('BEGIN IMMEDIATE')
    try {
      const result = this.conn
        .prepare(
          `UPDATE jobs SET settlement_state = 'rejected', settlement_note = ?, settlement_updated_at = ?,
             status = 'failed', completed_at = ?, error = 'payment_not_settled', idempotency_key = NULL
           WHERE id = ? AND settlement_state = 'unknown' AND status = 'payment_pending'`,
        )
        .run(evidence.slice(0, 500), Date.now(), Date.now(), id)
      const changed = Number(result.changes) === 1
      if (changed) this.conn.prepare('DELETE FROM idempotency_keys WHERE job_id = ?').run(id)
      this.conn.exec('COMMIT')
      if (changed) this.recordJobGrowth(id, 'payment_pending_failed')
      return changed
    } catch (error) {
      try { this.conn.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  listExpiredJobs(beforeMs: number): JobRecord[] {
    // Unresolved paid attempts never expire automatically; they wait for
    // authoritative reconciliation.
    const rows = this.conn
      .prepare(
        "SELECT * FROM jobs WHERE expires_at < ? AND (settlement_state IS NULL OR settlement_state NOT IN ('settling','unknown'))",
      )
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

  insertArchiveSnapshot(snapshot: ArchiveSnapshotRecord): void {
    this.conn
      .prepare(
        `INSERT INTO archive_snapshots (id, url_key, url, source_job_id, captured_at, archived_at,
         expires_at, status, decision, content_hash, bytes, snapshot_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.urlKey,
        snapshot.url,
        snapshot.sourceJobId,
        snapshot.capturedAt,
        snapshot.archivedAt,
        snapshot.expiresAt,
        snapshot.status,
        snapshot.decision,
        snapshot.contentHash,
        snapshot.bytes,
        snapshot.snapshotPath,
      )
  }

  getArchiveSnapshot(id: string): ArchiveSnapshotRecord | null {
    const row = this.conn.prepare('SELECT * FROM archive_snapshots WHERE id = ?').get(id) as
      RawArchiveRow | undefined
    return row ? rowToArchive(row) : null
  }

  hasArchiveSnapshotForJob(jobId: string): boolean {
    return (
      this.conn.prepare('SELECT 1 FROM archive_snapshots WHERE source_job_id = ?').get(jobId) !==
      undefined
    )
  }

  // Newest first. `beforeMs` pages backwards through older captures.
  listArchiveSnapshots(
    urlKey: string,
    { limit, beforeMs, now = Date.now() }: { limit: number; beforeMs?: number; now?: number },
  ): ArchiveSnapshotRecord[] {
    const rows = this.conn
      .prepare(
        `SELECT * FROM archive_snapshots WHERE url_key = ? AND expires_at > ? AND captured_at < ?
         ORDER BY captured_at DESC, id DESC LIMIT ?`,
      )
      .all(urlKey, now, beforeMs ?? Number.MAX_SAFE_INTEGER, limit) as unknown as RawArchiveRow[]
    return rows.map(rowToArchive)
  }

  archiveAvailability(
    urlKey: string,
    now = Date.now(),
  ): { count: number; newest: number | null; oldest: number | null } {
    const row = this.conn
      .prepare(
        `SELECT COUNT(*) AS count, MAX(captured_at) AS newest, MIN(captured_at) AS oldest
         FROM archive_snapshots WHERE url_key = ? AND expires_at > ?`,
      )
      .get(urlKey, now) as { count: number; newest: number | null; oldest: number | null }
    return { count: Number(row.count), newest: row.newest, oldest: row.oldest }
  }

  // Snapshots beyond the newest `keep` for one URL, oldest first.
  listArchiveSnapshotsBeyondCap(urlKey: string, keep: number): ArchiveSnapshotRecord[] {
    const rows = this.conn
      .prepare(
        `SELECT * FROM archive_snapshots WHERE url_key = ?
         ORDER BY captured_at DESC, id DESC LIMIT -1 OFFSET ?`,
      )
      .all(urlKey, keep) as unknown as RawArchiveRow[]
    return rows.map(rowToArchive).reverse()
  }

  listExpiredArchiveSnapshots(now: number): ArchiveSnapshotRecord[] {
    const rows = this.conn
      .prepare('SELECT * FROM archive_snapshots WHERE expires_at <= ?')
      .all(now) as unknown as RawArchiveRow[]
    return rows.map(rowToArchive)
  }

  listOldestArchiveSnapshots(limit: number): ArchiveSnapshotRecord[] {
    const rows = this.conn
      .prepare('SELECT * FROM archive_snapshots ORDER BY captured_at ASC, id ASC LIMIT ?')
      .all(limit) as unknown as RawArchiveRow[]
    return rows.map(rowToArchive)
  }

  archiveTotalBytes(): number {
    const row = this.conn
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM archive_snapshots')
      .get() as { total: number }
    return Number(row.total)
  }

  deleteArchiveSnapshot(id: string): void {
    this.conn.prepare('DELETE FROM archive_snapshots WHERE id = ?').run(id)
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

export type AdmissionRefusal = 'capacity' | 'payer_busy' | 'payment_exists' | 'key_bound'

export interface ArchiveSnapshotRecord {
  id: string
  urlKey: string
  url: string
  sourceJobId: string
  capturedAt: number
  archivedAt: number
  expiresAt: number
  status: string
  decision: string
  contentHash: string
  bytes: number
  snapshotPath: string
}

interface RawArchiveRow {
  id: string
  url_key: string
  url: string
  source_job_id: string
  captured_at: number
  archived_at: number
  expires_at: number
  status: string
  decision: string
  content_hash: string
  bytes: number
  snapshot_path: string
}

function rowToArchive(row: RawArchiveRow): ArchiveSnapshotRecord {
  return {
    id: row.id,
    urlKey: row.url_key,
    url: row.url,
    sourceJobId: row.source_job_id,
    capturedAt: row.captured_at,
    archivedAt: row.archived_at,
    expiresAt: row.expires_at,
    status: row.status,
    decision: row.decision,
    contentHash: row.content_hash,
    bytes: row.bytes,
    snapshotPath: row.snapshot_path,
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
  settlement_state?: string | null
  settlement_network?: string | null
  settlement_tx?: string | null
  settlement_note?: string | null
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
    settlementState: (row.settlement_state ?? null) as JobRecord['settlementState'],
    settlementNetwork: row.settlement_network ?? null,
    settlementTx: row.settlement_tx ?? null,
    settlementNote: row.settlement_note ?? null,
  }
}

