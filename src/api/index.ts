import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { createInfoRouter } from './routes/info.js'
import { createChecksRouter } from './routes/checks.js'
import { createProductsRouter } from './routes/products.js'
import { createWebProductsRouter } from './routes/web-products.js'
import { createMcpRouter } from '../mcp.js'
import type { JobStore } from '../db.js'
import type { WorkerRunner } from '../worker/runner.js'
import type { Config } from '../config.js'
import { createPaymentMiddleware } from '../payment/index.js'

export function createApp(store: JobStore, runner: WorkerRunner, cfg: Config): Express {
  const app = express()

  // Nginx reaches the loopback-published Docker port through the fixed bridge
  // gateway declared in deploy/docker-compose.vps.yml. Trust only those host
  // peers so x402 binds requirements to HTTPS without accepting forwarded
  // headers from the worker or other networks.
  app.set('trust proxy', ['loopback', '172.31.250.1/32'])

  // Body parsing - strict 10KB limit
  app.use(express.json({ limit: '10kb' }))

  // Disable x-powered-by header
  app.disable('x-powered-by')

  // Request ID injection
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const reqId = uuidv4()
    res.setHeader('X-Request-Id', reqId)
    next()
  })

  // Request logging (method, path, status, latency - no URL params in log values)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()
    res.on('finish', () => {
      const latency = Date.now() - start
      // Route templates contain no caller-supplied IDs, URLs, or query values.
      const safePath = typeof req.route?.path === 'string' ? req.route.path : '[unmatched]'
      console.info(`${req.method} ${safePath} ${res.statusCode} ${latency}ms`)
    })
    next()
  })

  // Payment middleware (applied to POST /v1/checks in the checks router)
  const paymentMiddleware = createPaymentMiddleware({
    payTo: cfg.PAY_TO,
    solanaPayTo:
      cfg.PAYMENT_MODE === 'production' ? cfg.SOLANA_REVENUE_PAY_TO : cfg.SOLANA_TEST_PAY_TO,
    enableSolana: cfg.ENABLE_SOLANA_PAYMENTS,
    priceUsdc: cfg.PRICE_USDC,
    mode: cfg.PAYMENT_MODE,
    enableMainnet: cfg.ENABLE_MAINNET_PAYMENTS,
    facilitatorUrl: cfg.FACILITATOR_URL,
    cdpApiKeyId: cfg.CDP_API_KEY_ID,
    cdpApiKeySecret: cfg.CDP_API_KEY_SECRET,
    customerHashSecret: cfg.CUSTOMER_HASH_SECRET,
  })
  const verifyPaymentMiddleware = createPaymentMiddleware({
    payTo: cfg.PAY_TO,
    solanaPayTo:
      cfg.PAYMENT_MODE === 'production' ? cfg.SOLANA_REVENUE_PAY_TO : cfg.SOLANA_TEST_PAY_TO,
    enableSolana: cfg.ENABLE_SOLANA_PAYMENTS,
    priceUsdc: cfg.VERIFY_PRICE_USDC,
    route: 'POST /v1/verify',
    description: 'Read-only browser assertions across three viewports',
    mode: cfg.PAYMENT_MODE,
    enableMainnet: cfg.ENABLE_MAINNET_PAYMENTS,
    facilitatorUrl: cfg.FACILITATOR_URL,
    cdpApiKeyId: cfg.CDP_API_KEY_ID,
    cdpApiKeySecret: cfg.CDP_API_KEY_SECRET,
    customerHashSecret: cfg.CUSTOMER_HASH_SECRET,
  })
  const comparePaymentMiddleware = createPaymentMiddleware({
    payTo: cfg.PAY_TO,
    solanaPayTo:
      cfg.PAYMENT_MODE === 'production' ? cfg.SOLANA_REVENUE_PAY_TO : cfg.SOLANA_TEST_PAY_TO,
    enableSolana: cfg.ENABLE_SOLANA_PAYMENTS,
    priceUsdc: cfg.COMPARE_PRICE_USDC,
    route: 'POST /v1/compare',
    description: 'Visual and QA comparison against a completed baseline job',
    mode: cfg.PAYMENT_MODE,
    enableMainnet: cfg.ENABLE_MAINNET_PAYMENTS,
    facilitatorUrl: cfg.FACILITATOR_URL,
    cdpApiKeyId: cfg.CDP_API_KEY_ID,
    cdpApiKeySecret: cfg.CDP_API_KEY_SECRET,
    customerHashSecret: cfg.CUSTOMER_HASH_SECRET,
  })
  const extractPaymentMiddleware = createPaymentMiddleware({
    payTo: cfg.PAY_TO,
    solanaPayTo:
      cfg.PAYMENT_MODE === 'production' ? cfg.SOLANA_REVENUE_PAY_TO : cfg.SOLANA_TEST_PAY_TO,
    enableSolana: cfg.ENABLE_SOLANA_PAYMENTS,
    priceUsdc: cfg.EXTRACT_PRICE_USDC,
    route: 'POST /v1/extract',
    description: 'Deterministic public HTML to clean Markdown extraction',
    mode: cfg.PAYMENT_MODE,
    enableMainnet: cfg.ENABLE_MAINNET_PAYMENTS,
    facilitatorUrl: cfg.FACILITATOR_URL,
    cdpApiKeyId: cfg.CDP_API_KEY_ID,
    cdpApiKeySecret: cfg.CDP_API_KEY_SECRET,
    customerHashSecret: cfg.CUSTOMER_HASH_SECRET,
  })
  const securityPaymentMiddleware = createPaymentMiddleware({
    payTo: cfg.PAY_TO,
    solanaPayTo:
      cfg.PAYMENT_MODE === 'production' ? cfg.SOLANA_REVENUE_PAY_TO : cfg.SOLANA_TEST_PAY_TO,
    enableSolana: cfg.ENABLE_SOLANA_PAYMENTS,
    priceUsdc: cfg.SECURITY_PRICE_USDC,
    route: 'POST /v1/security-gate',
    description: 'Passive public web release security gate',
    mode: cfg.PAYMENT_MODE,
    enableMainnet: cfg.ENABLE_MAINNET_PAYMENTS,
    facilitatorUrl: cfg.FACILITATOR_URL,
    cdpApiKeyId: cfg.CDP_API_KEY_ID,
    cdpApiKeySecret: cfg.CDP_API_KEY_SECRET,
    customerHashSecret: cfg.CUSTOMER_HASH_SECRET,
  })

  // Mount routers
  const infoRouter = createInfoRouter(store, runner, cfg)
  app.use(infoRouter)

  app.use(createMcpRouter(store, runner, cfg))

  app.use(
    createProductsRouter(store, runner, cfg, verifyPaymentMiddleware, comparePaymentMiddleware),
  )
  app.use(
    createWebProductsRouter(
      store,
      runner,
      cfg,
      extractPaymentMiddleware,
      securityPaymentMiddleware,
    ),
  )

  const checksRouter = createChecksRouter(store, runner, cfg, paymentMiddleware)
  app.use(checksRouter)

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', detail: 'Route not found', code: 'not_found' })
  })

  // Error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[api] unhandled error:', err instanceof Error ? err.message : String(err))
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error', code: 'internal_error' })
    }
  })

  return app
}
