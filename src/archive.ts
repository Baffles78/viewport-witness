import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { ArchiveSnapshotRecord, JobStore } from './db.js'
import type { JobRecord, QAReport, Viewport, ViewportResult } from './types.js'

export const ARCHIVE_SNAPSHOT_SCHEMA = 'viewport-witness-snapshot/v1'
const ARCHIVABLE_KINDS = new Set(['check', 'verify', 'compare'])
const VIEWPORTS: Viewport[] = ['phonePortrait', 'phoneLandscape', 'desktop']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// One archived page state. It deliberately carries no job ID, payment data,
// caller assertions or baseline references: only the public page evidence.
export interface ArchivedSnapshot {
  schema: typeof ARCHIVE_SNAPSHOT_SCHEMA
  snapshotId: string
  url: string
  capturedAt: string
  expiresAt: string
  status: QAReport['status']
  paymentMode: QAReport['paymentMode']
  sourceContentHash: string
  checksPerformed: string[]
  limitations: string[]
  viewports: Partial<Record<Viewport, Omit<ViewportResult, 'assertions'>>>
  summary: QAReport['summary']
  verdict: QAReport['verdict']
  diagnosis: QAReport['diagnosis']
}

export interface ArchiveOptions {
  archiveDir: string
  screenshotsDir: string
  retentionDays: number
  maxStorageBytes: number
  maxSnapshotsPerUrl: number
}

// Archive lookups match one exact public HTTPS page. Fragments never reach the
// server and default ports are dropped; path and query stay significant.
export function archiveUrlKey(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
  if (parsed.port && parsed.port !== '443') return null
  parsed.hash = ''
  return parsed.href
}

export function isSnapshotId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export class ArchiveManager {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly root: string

  constructor(
    private readonly store: JobStore,
    private readonly opts: ArchiveOptions,
  ) {
    this.root = path.resolve(opts.archiveDir)
  }

  private snapshotDir(id: string): string | null {
    if (!isSnapshotId(id)) return null
    const candidate = path.resolve(this.root, id)
    return isPathInside(this.root, candidate) ? candidate : null
  }

  screenshotPath(id: string, viewport: Viewport): string | null {
    const dir = this.snapshotDir(id)
    return dir ? path.join(dir, `${viewport}.png`) : null
  }

  async capture(
    job: JobRecord,
    report: QAReport,
    now = Date.now(),
  ): Promise<ArchiveSnapshotRecord | null> {
    if (!ARCHIVABLE_KINDS.has(job.kind)) return null
    const urlKey = archiveUrlKey(job.url)
    if (!urlKey || this.store.hasArchiveSnapshotForJob(job.id)) return null

    const id = uuidv4()
    const dir = this.snapshotDir(id)
    if (!dir) return null
    const jobRoot = path.join(this.opts.screenshotsDir, job.id)
    const expiresAt = now + this.opts.retentionDays * 24 * 60 * 60 * 1000
    await fs.mkdir(dir, { recursive: true })
    try {
      let bytes = 0
      const viewports: ArchivedSnapshot['viewports'] = {}
      for (const viewport of VIEWPORTS) {
        const result = report.viewports[viewport]
        if (!result) continue
        const publicResult: Omit<ViewportResult, 'assertions'> & { assertions?: unknown } = {
          ...result,
        }
        delete publicResult.assertions
        let screenshotUrl = ''
        const shot = this.store.getScreenshot(job.id, viewport)
        if (shot && result.screenshotBytes > 0 && isPathInside(jobRoot, shot.path)) {
          await fs.copyFile(shot.path, path.join(dir, `${viewport}.png`))
          bytes += shot.bytes
          screenshotUrl = `/v1/history/snapshots/${id}/screenshots/${viewport}`
        }
        viewports[viewport] = { ...publicResult, screenshotUrl }
      }
      const snapshot: ArchivedSnapshot = {
        schema: ARCHIVE_SNAPSHOT_SCHEMA,
        snapshotId: id,
        url: urlKey,
        capturedAt: report.createdAt,
        expiresAt: new Date(expiresAt).toISOString(),
        status: report.status,
        paymentMode: report.paymentMode,
        sourceContentHash: report.contentHash,
        checksPerformed: report.checksPerformed,
        limitations: report.limitations,
        viewports,
        summary: report.summary,
        verdict: report.verdict,
        diagnosis: report.diagnosis,
      }
      const json = JSON.stringify(snapshot)
      const snapshotPath = path.join(dir, 'snapshot.json')
      await fs.writeFile(snapshotPath, json, 'utf8')
      bytes += Buffer.byteLength(json)

      const record: ArchiveSnapshotRecord = {
        id,
        urlKey,
        url: urlKey,
        sourceJobId: job.id,
        capturedAt: Date.parse(report.createdAt) || job.createdAt,
        archivedAt: now,
        expiresAt,
        status: report.status,
        decision: report.verdict.decision,
        contentHash: crypto.createHash('sha256').update(json).digest('hex'),
        bytes,
        snapshotPath,
      }
      this.store.insertArchiveSnapshot(record)

      for (const old of this.store.listArchiveSnapshotsBeyondCap(
        urlKey,
        this.opts.maxSnapshotsPerUrl,
      )) {
        await this.remove(old)
      }
      await this.enforceStorageCeiling()
      return this.store.getArchiveSnapshot(id)
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async readSnapshot(id: string, now = Date.now()): Promise<ArchivedSnapshot | null> {
    const record = isSnapshotId(id) ? this.store.getArchiveSnapshot(id) : null
    const dir = this.snapshotDir(id)
    if (!record || !dir || record.expiresAt <= now) return null
    if (!isPathInside(dir, record.snapshotPath)) return null
    try {
      return JSON.parse(await fs.readFile(record.snapshotPath, 'utf8')) as ArchivedSnapshot
    } catch {
      return null
    }
  }

  private async remove(record: ArchiveSnapshotRecord): Promise<number> {
    const dir = this.snapshotDir(record.id)
    if (dir) {
      try {
        const stat = await fs.lstat(dir)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await fs.rm(dir, { recursive: true, force: true })
        }
      } catch {
        // Directory may already be gone.
      }
    }
    this.store.deleteArchiveSnapshot(record.id)
    return record.bytes
  }

  private async enforceStorageCeiling(): Promise<{ deleted: number; freedBytes: number }> {
    let total = this.store.archiveTotalBytes()
    let deleted = 0
    let freedBytes = 0
    while (total > this.opts.maxStorageBytes) {
      const batch = this.store.listOldestArchiveSnapshots(50)
      if (batch.length === 0) break
      for (const record of batch) {
        if (total <= this.opts.maxStorageBytes) break
        const freed = await this.remove(record)
        total -= freed
        freedBytes += freed
        deleted++
      }
    }
    return { deleted, freedBytes }
  }

  async runCleanup(now = Date.now()): Promise<{ deletedSnapshots: number; freedBytes: number }> {
    let deletedSnapshots = 0
    let freedBytes = 0
    for (const record of this.store.listExpiredArchiveSnapshots(now)) {
      freedBytes += await this.remove(record)
      deletedSnapshots++
    }
    const ceiling = await this.enforceStorageCeiling()
    return {
      deletedSnapshots: deletedSnapshots + ceiling.deleted,
      freedBytes: freedBytes + ceiling.freedBytes,
    }
  }

  startAutoCleanup(intervalMs: number): ReturnType<typeof setInterval> {
    this.timer = setInterval(() => {
      this.runCleanup().catch((err) => {
        console.error('[archive] cleanup error:', (err as Error).message)
      })
    }, intervalMs)
    return this.timer
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
