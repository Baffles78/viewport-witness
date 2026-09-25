import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import { openApiSpec } from '../../openapi.js'
import type { WorkerRunner } from '../../worker/runner.js'
import type { JobStore } from '../../db.js'
import type { Config } from '../../config.js'
import { getPaymentDiscovery } from '../../payment/index.js'
import { FEEDBACK_URL, PUBLIC_BASE_URL } from '../../public.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const startTime = Date.now()

const __dirname = dirname(fileURLToPath(import.meta.url))
const llmsPath = join(__dirname, '../../../llms.txt')
const skillPath = join(__dirname, '../../../skill.md')
const privacyPath = join(__dirname, '../../../docs/PRIVACY.md')
const termsPath = join(__dirname, '../../../docs/TERMS.md')
const logoPath = join(__dirname, '../../../assets/viewport-witness.png')

const mcpDiscovery = {
  name: 'io.github.Baffles78/viewport-witness',
  title: 'ViewportWitness by Apex Labs',
  description: 'Paid browser QA for AI agents across phone and desktop viewports, using x402.',
  version: '0.2.0',
  transport: {
    type: 'streamable-http',
    url: `${PUBLIC_BASE_URL}/mcp`,
  },
  repository: 'https://github.com/Baffles78/viewport-witness',
}

let llmsContent: string
try {
  llmsContent = readFileSync(llmsPath, 'utf8')
} catch {
  llmsContent = 'ViewportWitness by Apex Labs: see /openapi.json for full API documentation.'
}

let skillContent: string
try {
  skillContent = readFileSync(skillPath, 'utf8')
} catch {
  skillContent = 'ViewportWitness by Apex Labs: see /openapi.json and /llms.txt for documentation.'
}

let privacyContent: string
try {
  privacyContent = readFileSync(privacyPath, 'utf8')
} catch {
  privacyContent = '# Privacy Policy\n\nSee /openapi.json for service documentation.'
}

let termsContent: string
try {
  termsContent = readFileSync(termsPath, 'utf8')
} catch {
  termsContent = '# Terms of Service\n\nSee /openapi.json for service documentation.'
}

export function createInfoRouter(store: JobStore, runner: WorkerRunner, cfg: Config): Router {
  const router = createRouter()

  router.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'ViewportWitness by Apex Labs',
      version: '0.2.0',
      description:
        'Browser QA API: screenshots, accessibility, and layout checks across three viewports',
      docs: '/openapi.json',
      agentDocs: '/llms.txt',
      skillDocs: '/skill.md',
      health: '/health',
      ready: '/ready',
      paymentDiscovery: '/.well-known/x402',
      mcpDiscovery: '/.well-known/mcp.json',
      mcp: '/mcp',
      privacy: '/privacy',
      terms: '/terms',
      logo: '/logo.png',
      products: {
        check: { endpoint: 'POST /v1/checks', price: '$0.08 USDC' },
        verify: { endpoint: 'POST /v1/verify', price: '$0.10 USDC' },
        compare: { endpoint: 'POST /v1/compare', price: '$0.12 USDC' },
      },
      feedback: FEEDBACK_URL,
    })
  })

  router.get('/favicon.ico', (_req: Request, res: Response) => {
    res.sendFile(logoPath)
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

  router.get('/skill.md', (_req: Request, res: Response) => {
    res.type('text/markdown').send(skillContent)
  })

  router.get('/privacy', (_req: Request, res: Response) => {
    res.type('text/markdown').send(privacyContent)
  })

  router.get('/terms', (_req: Request, res: Response) => {
    res.type('text/markdown').send(termsContent)
  })

  router.get('/logo.png', (_req: Request, res: Response) => {
    res.sendFile(logoPath)
  })

  router.get('/.well-known/x402', (_req: Request, res: Response) => {
    const discovery = getPaymentDiscovery(
      {
        payTo: cfg.PAY_TO,
        solanaPayTo:
          cfg.PAYMENT_MODE === 'production' ? cfg.SOLANA_REVENUE_PAY_TO : cfg.SOLANA_TEST_PAY_TO,
        enableSolana: cfg.ENABLE_SOLANA_PAYMENTS,
        priceUsdc: cfg.PRICE_USDC,
        mode: cfg.PAYMENT_MODE,
        enableMainnet: cfg.ENABLE_MAINNET_PAYMENTS,
        facilitatorUrl: cfg.FACILITATOR_URL,
      },
      PUBLIC_BASE_URL,
    )
    res.json(discovery)
  })

  router.get('/.well-known/mcp.json', (_req: Request, res: Response) => {
    res.json(mcpDiscovery)
  })

  return router
}
