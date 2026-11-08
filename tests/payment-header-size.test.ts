/**
 * Release guard: the production Nginx proxy reads response headers into its
 * default 4 KiB proxy buffer. A larger 402 PAYMENT-REQUIRED header makes Nginx
 * answer 502 instead of the payment challenge (seen on 2026-11-08 for
 * /v1/checks and /v1/verify). Keep every paid route's challenge headers well
 * below that, leaving room for Express, security and proxy headers.
 */
import { describe, expect, it, vi } from 'vitest'
import express from 'express'

vi.mock('@coinbase/cdp-sdk/x402', () => ({
  createCdpFacilitatorClient: () => ({
    async getSupported() {
      return {
        kinds: [
          { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
          {
            x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' },
          },
        ],
        extensions: [],
        signers: {},
      }
    },
    async verify() { return { isValid: true } },
    async settle() { return { success: true, transaction: '', network: 'eip155:8453' } },
  }),
}))

const { createPaymentMiddleware, PAID_ROUTE_DESCRIPTIONS } = await import('../src/payment/index.js')

const MAX_CHALLENGE_HEADER_BYTES = 3_700

const routes = [
  ['POST /v1/checks', '0.08'],
  ['POST /v1/verify', '0.10'],
  ['POST /v1/compare', '0.12'],
  ['POST /v1/extract', '0.005'],
  ['POST /v1/security-gate', '0.05'],
] as const

describe('402 challenge fits the production proxy header buffer', () => {
  for (const [route, price] of routes) {
    it(`${route} challenge headers stay under ${MAX_CHALLENGE_HEADER_BYTES} bytes with both rails`, async () => {
      const path = route.split(' ')[1] as string
      const app = express()
      app.use(express.json())
      app.post(path, createPaymentMiddleware({
        payTo: '0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400',
        solanaPayTo: 'EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk',
        enableSolana: true,
        priceUsdc: price,
        mode: 'production',
        enableMainnet: true,
        cdpApiKeyId: 'synthetic',
        cdpApiKeySecret: 'synthetic',
        route,
        description: PAID_ROUTE_DESCRIPTIONS[route],
      }))
      const server = app.listen(0, '127.0.0.1')
      await new Promise((resolve) => server.once('listening', resolve))
      try {
        const port = (server.address() as { port: number }).port
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: 'qa.honeygate.app' },
          body: JSON.stringify({ url: 'https://example.com' }),
        })
        expect(res.status).toBe(402)
        let bytes = `HTTP/1.1 402 Payment Required\r\n`.length
        res.headers.forEach((value, key) => { bytes += key.length + value.length + 4 })
        expect(bytes).toBeLessThan(MAX_CHALLENGE_HEADER_BYTES)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  }
})
