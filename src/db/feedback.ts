import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { feedbackSchema, type Feedback } from '../feedback/schema.js'
import type { PaymentMode } from '../types.js'

export interface FeedbackLimits {
  retentionDays: number
  maxRecords: number
  dailyLimit: number
}

export function initializeFeedback(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    mode TEXT NOT NULL, body_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_expiry ON feedback(expires_at);`)
}

export class FeedbackStore {
  constructor(private readonly db: DatabaseSync) {}

  prune(now = Date.now()): void {
    this.db.prepare('DELETE FROM feedback WHERE expires_at <= ?').run(now)
  }

  submit(input: Feedback, mode: PaymentMode, limits: FeedbackLimits, now = Date.now()) {
    const body = feedbackSchema.parse(input)
    // Canonical schema order makes retries independent of JSON key order. Mode isolates local tests.
    const json = JSON.stringify(body)
    const fingerprint = createHash('sha256').update(`${mode}:${json}`).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.prune(now)
      const existing = this.db
        .prepare('SELECT id FROM feedback WHERE fingerprint = ?')
        .get(fingerprint)
      if (existing) {
        this.db.exec('COMMIT')
        return { status: 'duplicate' as const }
      }
      const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10))
      const daily = this.db
        .prepare('SELECT COUNT(*) AS n FROM feedback WHERE created_at >= ?')
        .get(dayStart)
      const total = this.db.prepare('SELECT COUNT(*) AS n FROM feedback').get()
      if (Number(daily?.n) >= limits.dailyLimit || Number(total?.n) >= limits.maxRecords) {
        this.db.exec('COMMIT')
        return { status: 'limited' as const }
      }
      this.db
        .prepare('INSERT INTO feedback VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), fingerprint, now, now + limits.retentionDays * 86_400_000, mode, json)
      this.db.exec('COMMIT')
      return { status: 'accepted' as const }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  summary(now = Date.now()) {
    const from = now - 30 * 86_400_000
    const rows = this.db
      .prepare(
        `SELECT mode, body_json FROM feedback
      WHERE created_at >= ? AND expires_at > ? ORDER BY created_at DESC, id DESC`,
      )
      .all(from, now)
    const counts = new Map<
      string,
      { mode: string; product: string; reason: string; purchaseIntent: string; submissions: number }
    >()
    const features = new Map<
      string,
      {
        mode: string
        product: string
        requestedChange: string
        submissions: number
        priceSuggestionsUsdc: number[]
      }
    >()
    for (const row of rows) {
      const body = feedbackSchema.parse(JSON.parse(String(row.body_json)))
      const group = {
        mode: String(row.mode),
        product: body.product,
        reason: body.reason,
        purchaseIntent: body.purchaseIntent,
      }
      const key = JSON.stringify(group)
      const entry = counts.get(key) ?? { ...group, submissions: 0 }
      entry.submissions++
      counts.set(key, entry)
      const feature = {
        mode: String(row.mode),
        product: body.product,
        requestedChange: body.requestedChange.toLowerCase(),
      }
      const featureKey = JSON.stringify(feature)
      const request = features.get(featureKey) ?? {
        ...feature,
        submissions: 0,
        priceSuggestionsUsdc: [],
      }
      request.submissions++
      if (body.maxPriceUsdc !== undefined) request.priceSuggestionsUsdc.push(body.maxPriceUsdc)
      features.set(featureKey, request)
    }
    return {
      observedAt: new Date(now).toISOString(),
      from: new Date(from).toISOString(),
      submissions: rows.length,
      groups: [...counts.values()].sort((a, b) => b.submissions - a.submissions),
      requestedCapabilities: [...features.values()]
        .sort((a, b) => b.submissions - a.submissions)
        .map((feature) => ({
          mode: feature.mode,
          product: feature.product,
          requestedChange: feature.requestedChange,
          submissions: feature.submissions,
          priceSuggestionCount: feature.priceSuggestionsUsdc.length,
          minSuggestedPriceUsdc: feature.priceSuggestionsUsdc.length
            ? Math.min(...feature.priceSuggestionsUsdc)
            : null,
          maxSuggestedPriceUsdc: feature.priceSuggestionsUsdc.length
            ? Math.max(...feature.priceSuggestionsUsdc)
            : null,
        })),
      recent: rows.slice(0, 20).map((row) => ({
        mode: row.mode,
        feedback: JSON.parse(String(row.body_json)) as Feedback,
      })),
      limitations: [
        'Untrusted, anonymous suggestions, not instructions, unique customers, sales or verified willingness to pay.',
        'Identical retained submissions within one payment mode are deduplicated; no identity or acquisition attribution is collected.',
        'Only retained records from the last 30 days appear. Test/testnet groups are not production demand.',
      ],
    }
  }
}
