import { promises as fs } from 'fs'
import path from 'path'
import type { JobStore } from './db.js'

export class RetentionManager {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly store: JobStore,
    private readonly screenshotsDir: string,
    private readonly maxStorageBytes: number,
  ) {}

  async runCleanup(): Promise<{ deletedJobs: number; freedBytes: number }> {
    let deletedJobs = 0
    let freedBytes = 0

    // Delete expired jobs
    const expired = this.store.listExpiredJobs(Date.now())
    for (const job of expired) {
      const jobDir = path.join(this.screenshotsDir, job.id)
      try {
        const stat = await fs.stat(jobDir)
        if (stat.isDirectory()) {
          const size = await getDirSize(jobDir)
          await fs.rm(jobDir, { recursive: true, force: true })
          freedBytes += size
        }
      } catch {
        // Directory may not exist
      }
      this.store.deleteJob(job.id)
      deletedJobs++
    }

    // Enforce storage ceiling: delete oldest jobs first
    const totalBytes = await this.getTotalStorageBytes()
    if (totalBytes > this.maxStorageBytes) {
      const excess = totalBytes - this.maxStorageBytes
      let cleared = 0
      // Get all job dirs sorted by creation time (oldest first via dir mtime)
      try {
        const entries = await fs.readdir(this.screenshotsDir, { withFileTypes: true })
        const dirs: Array<{ name: string; mtime: number }> = []
        for (const entry of entries) {
          if (entry.isDirectory()) {
            try {
              const stat = await fs.stat(path.join(this.screenshotsDir, entry.name))
              dirs.push({ name: entry.name, mtime: stat.mtimeMs })
            } catch {
              // skip
            }
          }
        }
        dirs.sort((a, b) => a.mtime - b.mtime)

        for (const dir of dirs) {
          if (cleared >= excess) break
          const dirPath = path.join(this.screenshotsDir, dir.name)
          const size = await getDirSize(dirPath)
          await fs.rm(dirPath, { recursive: true, force: true })
          this.store.deleteJob(dir.name)
          cleared += size
          freedBytes += size
          deletedJobs++
        }
      } catch {
        // screenshotsDir may not exist yet
      }
    }

    return { deletedJobs, freedBytes }
  }

  async getTotalStorageBytes(): Promise<number> {
    try {
      return await getDirSize(this.screenshotsDir)
    } catch {
      return 0
    }
  }

  startAutoCleanup(intervalMs: number): ReturnType<typeof setInterval> {
    this.timer = setInterval(() => {
      this.runCleanup().catch((err) => {
        console.error('[retention] cleanup error:', (err as Error).message)
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

async function getDirSize(dir: string): Promise<number> {
  let total = 0
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile()) {
        const stat = await fs.stat(fullPath)
        total += stat.size
      } else if (entry.isDirectory()) {
        total += await getDirSize(fullPath)
      }
    }
  } catch {
    // ignore
  }
  return total
}
