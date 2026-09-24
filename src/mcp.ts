import { promises as fs } from 'node:fs'
import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createPaymentWrapper } from '@x402/mcp'
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402'
import { x402ResourceServer } from '@x402/core/server'
import type { Network, PaymentRequirements } from '@x402/core/types'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { ExactSvmScheme } from '@x402/svm/exact/server'
import { z } from 'zod'
import type { Config } from './config.js'
import type { JobStore } from './db.js'
import { PUBLIC_BASE_URL } from './public.js'
import { validatePublicHttpsUrl } from './ssrf.js'
import type { PageAssertion, QAReport } from './types.js'
import type { WorkerRunner } from './worker/runner.js'
import { createProductJob } from './api/routes/products.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function jsonResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  }
}

function parseAssertions(value: unknown[]): PageAssertion[] | null {
  if (value.length < 1 || value.length > 20) return null
  const parsed: PageAssertion[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    if (item['type'] === 'noHorizontalOverflow' || item['type'] === 'noConsoleErrors') {
      parsed.push({ type: item['type'] })
    } else if (
      (item['type'] === 'textVisible' || item['type'] === 'titleIncludes') &&
      typeof item['value'] === 'string' &&
      item['value'].length > 0 &&
      item['value'].length <= 200
    ) {
      parsed.push({ type: item['type'], value: item['value'] })
    } else if (
      (item['type'] === 'selectorExists' || item['type'] === 'selectorVisible') &&
      typeof item['selector'] === 'string' &&
      item['selector'].length > 0 &&
      item['selector'].length <= 300
    ) {
      parsed.push({ type: item['type'], selector: item['selector'] })
    } else return null
  }
  return parsed
}

async function createMcpPaymentContext(cfg: Config): Promise<{
  server: x402ResourceServer
  requirements: Record<'check' | 'verify' | 'compare', PaymentRequirements[]>
} | null> {
  if (cfg.PAYMENT_MODE === 'test') return null
  if (!cfg.CDP_API_KEY_ID || !cfg.CDP_API_KEY_SECRET) throw new Error('mcp_payment_not_configured')
  const baseNetwork: Network = cfg.PAYMENT_MODE === 'production' ? 'eip155:8453' : 'eip155:84532'
  const solanaNetwork: Network =
    cfg.PAYMENT_MODE === 'production'
      ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      : 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
  const facilitator = createCdpFacilitatorClient({
    apiKeyId: cfg.CDP_API_KEY_ID,
    apiKeySecret: cfg.CDP_API_KEY_SECRET,
    ...(cfg.FACILITATOR_URL ? { baseUrl: cfg.FACILITATOR_URL } : {}),
  })
  const server = new x402ResourceServer(facilitator).register(baseNetwork, new ExactEvmScheme())
  if (cfg.ENABLE_SOLANA_PAYMENTS) server.register(solanaNetwork, new ExactSvmScheme())
  await server.initialize()
  const build = async (price: string): Promise<PaymentRequirements[]> => {
    const options = [
      { scheme: 'exact', network: baseNetwork, payTo: cfg.PAY_TO, price: `$${price}` },
      ...(cfg.ENABLE_SOLANA_PAYMENTS
        ? [
            {
              scheme: 'exact',
              network: solanaNetwork,
              payTo:
                cfg.PAYMENT_MODE === 'production'
                  ? cfg.SOLANA_REVENUE_PAY_TO
                  : cfg.SOLANA_TEST_PAY_TO,
              price: `$${price}`,
            },
          ]
        : []),
    ]
    return server.buildPaymentRequirementsFromOptions(options, {})
  }
  return {
    server,
    requirements: {
      check: await build(cfg.PRICE_USDC),
      verify: await build(cfg.VERIFY_PRICE_USDC),
      compare: await build(cfg.COMPARE_PRICE_USDC),
    },
  }
}

export function createMcpRouter(store: JobStore, runner: WorkerRunner, cfg: Config): Router {
  const router = createRouter()
  let paymentContextPromise: ReturnType<typeof createMcpPaymentContext> | undefined
  const getPaymentContext = (): ReturnType<typeof createMcpPaymentContext> => {
    paymentContextPromise ??= createMcpPaymentContext(cfg)
    return paymentContextPromise
  }

  async function buildServer(): Promise<McpServer> {
    const mcp = new McpServer({ name: 'ViewportWitness', version: '0.2.0' })
    const context = await getPaymentContext()
    const pendingByPayment = new Map<string, string>()
    const wrap = <T extends Record<string, unknown>>(
      tier: 'check' | 'verify' | 'compare',
      handler: (args: T) => Promise<ToolResult>,
    ) =>
      context
        ? createPaymentWrapper(context.server, {
            accepts: context.requirements[tier],
            resource: { url: `mcp://tool/${tier === 'check' ? 'check_page' : `${tier}_page`}` },
            hooks: {
              onAfterExecution: ({ paymentPayload, result }) => {
                if (result.isError) return
                try {
                  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { id?: unknown }
                  if (typeof parsed.id === 'string')
                    pendingByPayment.set(JSON.stringify(paymentPayload), parsed.id)
                } catch {
                  // A malformed tool result is not activated.
                }
              },
              onAfterSettlement: async ({ paymentPayload }) => {
                const key = JSON.stringify(paymentPayload)
                const id = pendingByPayment.get(key)
                if (!id) return
                try {
                  store.updateJobStatus(id, 'queued')
                  await runner.enqueue(id)
                } catch (error) {
                  store.updateJobStatus(id, 'failed', {
                    completedAt: Date.now(),
                    error:
                      error instanceof Error ? error.message.slice(0, 1000) : 'worker_unavailable',
                  })
                  throw error
                } finally {
                  pendingByPayment.delete(key)
                }
              },
            },
          })(handler)
        : handler

    mcp.tool(
      'check_page',
      `Run browser QA across three viewports. Costs $${cfg.PRICE_USDC} USDC.`,
      { url: z.string().url().max(2048) },
      wrap('check', async ({ url }: { url: string }) => {
        const valid = await validatePublicHttpsUrl(url)
        if (!valid.valid) return jsonResult({ error: 'invalid_url', code: valid.reason }, true)
        return jsonResult(
          await createProductJob({
            store,
            runner,
            cfg,
            kind: 'check',
            url,
            deferEnqueue: Boolean(context),
          }),
        )
      }),
    )

    mcp.tool(
      'verify_page',
      `Run read-only assertions across three viewports. Costs $${cfg.VERIFY_PRICE_USDC} USDC.`,
      {
        url: z.string().url().max(2048),
        assertions: z.array(z.record(z.unknown())).min(1).max(20),
      },
      wrap('verify', async ({ url, assertions }: { url: string; assertions: unknown[] }) => {
        const valid = await validatePublicHttpsUrl(url)
        const parsed = parseAssertions(assertions)
        if (!valid.valid || !parsed) return jsonResult({ error: 'invalid_input' }, true)
        return jsonResult(
          await createProductJob({
            store,
            runner,
            cfg,
            kind: 'verify',
            url,
            assertions: parsed,
            deferEnqueue: Boolean(context),
          }),
        )
      }),
    )

    mcp.tool(
      'compare_page',
      `Compare a page to a completed baseline. Costs $${cfg.COMPARE_PRICE_USDC} USDC.`,
      { url: z.string().url().max(2048), baselineJobId: z.string().uuid() },
      wrap('compare', async ({ url, baselineJobId }: { url: string; baselineJobId: string }) => {
        const valid = await validatePublicHttpsUrl(url)
        const baseline = store.getJob(baselineJobId)
        if (
          !valid.valid ||
          !baseline ||
          baseline.status !== 'complete' ||
          !baseline.reportPath ||
          baseline.expiresAt <= Date.now()
        ) {
          return jsonResult({ error: 'baseline_or_url_unavailable' }, true)
        }
        return jsonResult(
          await createProductJob({
            store,
            runner,
            cfg,
            kind: 'compare',
            url,
            baselineJobId,
            deferEnqueue: Boolean(context),
          }),
        )
      }),
    )

    mcp.tool(
      'get_report',
      'Get a queued job status or completed report. Free.',
      { jobId: z.string().uuid() },
      async ({ jobId }) => {
        const job = store.getJob(jobId)
        if (!job) return jsonResult({ error: 'not_found' }, true)
        if (job.status !== 'complete' || !job.reportPath) {
          return jsonResult({ id: job.id, status: job.status, pollUrl: `/v1/checks/${job.id}` })
        }
        try {
          return jsonResult(JSON.parse(await fs.readFile(job.reportPath, 'utf8')) as QAReport)
        } catch {
          return jsonResult({ error: 'report_unavailable' }, true)
        }
      },
    )
    return mcp
  }

  router.post('/mcp', async (req: Request, res: Response) => {
    const rawHost = req.header('host') ?? ''
    let hostname = ''
    try {
      hostname = new URL(`http://${rawHost}`).hostname
    } catch {
      res.status(403).json({ error: 'invalid_host' })
      return
    }
    const allowedHostnames = new Set([new URL(PUBLIC_BASE_URL).hostname, 'localhost', '127.0.0.1'])
    if (!allowedHostnames.has(hostname)) {
      res.status(403).json({ error: 'invalid_host' })
      return
    }
    const server = await buildServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined as never,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [rawHost],
    })
    try {
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0])
      await transport.handleRequest(req, res, req.body)
    } catch {
      if (!res.headersSent)
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
    } finally {
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }
  })
  router.get('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }))
  router.delete('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }))
  return router
}
