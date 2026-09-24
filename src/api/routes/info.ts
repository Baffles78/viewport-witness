import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import { openApiSpec } from '../../openapi.js'
import type { WorkerRunner } from '../../worker/runner.js'
import type { JobStore } from '../../db.js'
import type { Config } from '../../config.js'
import { getPaymentDiscovery } from '../../payment/index.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const startTime = Date.now()

const __dirname = dirname(fileURLToPath(import.meta.url))
const llmsPath = join(__dirname, '../../../llms.txt')

let llmsContent: string
try {
  llmsContent = readFileSync(llmsPath, 'utf8')
} catch {
  llmsContent = 'ViewportWitness: see /openapi.json for full API documentation.'
}

export function createInfoRouter(store: JobStore, runner: WorkerRunner, cfg: Config): Router {
  const router = createRouter()

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'ViewportWitness',
      version: '0.1.0',
      description:
        'Browser QA API: screenshots, accessibility, and layout checks across three viewports',
      docs: '/openapi.json',
      agentDocs: '/llms.txt',
      health: '/health',
      ready: '/ready',
      paymentDiscovery: '/.well-known/x402',
    })
  })

  router.get('/favicon.ico', (_req: Request, res: Response) => {
    res.status(204).end()
  })

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    })
  })

  router.get('/ready', (_req: Request, res: Response) => {
    let dbOk = false
    try {
      store.getJob('__probe__')
      dbOk = true
    } catch {
      dbOk = false
    }

    const workerOk = runner.isHealthy()
    const ready = dbOk && workerOk

    res.status(ready ? 200 : 503).json({
      ready,
      db: dbOk ? 'ok' : 'fail',
      worker: workerOk ? 'ok' : 'fail',
    })
  })

  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(openApiSpec)
  })

  router.get('/llms.txt', (_req: Request, res: Response) => {
    res.type('text/plain').send(llmsContent)
  })

  router.get('/.well-known/x402', (_req: Request, res: Response) => {
    const discovery = getPaymentDiscovery({
      payTo: cfg.PAY_TO,
      priceUsdc: cfg.PRICE_USDC,
      mode: cfg.PAYMENT_MODE,
      enableMainnet: cfg.ENABLE_MAINNET_PAYMENTS,
      facilitatorUrl: cfg.FACILITATOR_URL,
    })
    res.json(discovery)
  })

  return router
}
