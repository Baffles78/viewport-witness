import { promises as fs } from 'fs'
import http from 'http'
import { config, validateConfig } from './config.js'
import { JobStore } from './db.js'
import { RetentionManager } from './retention.js'
import { WorkerRunner } from './worker/runner.js'
import { createApp } from './api/index.js'
import { ArchiveManager } from './archive.js'

async function main(): Promise<void> {
  // Validate config (throws on invalid payment mode configuration)
  validateConfig(config)

  // Create data directories
  await fs.mkdir(config.DATA_DIR, { recursive: true })
  await fs.mkdir(config.SCREENSHOTS_DIR, { recursive: true })

  // Initialize database
  const store = new JobStore(config.DB_PATH)
  store.init()

  // Initialize retention manager (run cleanup every hour)
  const retention = new RetentionManager(
    store,
    config.SCREENSHOTS_DIR,
    config.MAX_STORAGE_GB * 1024 * 1024 * 1024,
  )
  await retention.runCleanup()
  retention.startAutoCleanup(60 * 60 * 1000)

  // Page history archive: a separate, longer-lived copy of completed browser reports.
  let archive: ArchiveManager | null = null
  if (config.ARCHIVE_ENABLED) {
    await fs.mkdir(config.ARCHIVE_DIR, { recursive: true })
    archive = new ArchiveManager(store, {
      archiveDir: config.ARCHIVE_DIR,
      screenshotsDir: config.SCREENSHOTS_DIR,
      retentionDays: config.ARCHIVE_RETENTION_DAYS,
      maxStorageBytes: config.ARCHIVE_MAX_STORAGE_GB * 1024 * 1024 * 1024,
      maxSnapshotsPerUrl: config.ARCHIVE_MAX_SNAPSHOTS_PER_URL,
    })
    await archive.runCleanup()
    archive.startAutoCleanup(60 * 60 * 1000)
  }

  // Initialize worker
  const runner = new WorkerRunner(
    store,
    config.SCREENSHOTS_DIR,
    config.WORKER_TIMEOUT_MS,
    config.PAYMENT_MODE,
    archive,
  )
  await runner.start()

  // Create Express app
  const app = createApp(store, runner, config, archive)
  const server = http.createServer(app)

  // Graceful shutdown handler
  let shuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true

    console.info(`[server] ${signal} received, starting graceful shutdown`)

    // Stop accepting new connections
    const serverClosed = new Promise<void>((resolve) => {
      server.close(() => {
        console.info('[server] HTTP server closed')
        resolve()
      })
    })

    // Stop worker (marks in-progress jobs as retryable)
    await runner.stop()

    // Stop retention
    retention.stop()
    archive?.stop()

    // Close database
    store.close()

    await serverClosed

    console.info('[server] shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Start server
  await new Promise<void>((resolve) => {
    server.listen(config.PORT, () => {
      resolve()
    })
  })

  console.info(`[server] ViewportWitness started on port ${config.PORT}`)
  console.info(`[server] payment mode: ${config.PAYMENT_MODE}`)
  console.info(`[server] data dir: ${config.DATA_DIR}`)

  if (config.PAYMENT_MODE === 'test') {
    console.info('[server] TEST MODE: no payment required, results labeled paymentMode:test')
  }
}

main().catch((err: unknown) => {
  console.error('[server] fatal startup error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
