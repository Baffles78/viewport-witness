// Manifest, challenge, report and checkpoint fixtures for release-check tests.
import type { ReleaseManifest, ReleaseState } from '../../src/release-check.js'

export function makeManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    runId: 'run-test-001',
    pages: ['https://example.com'],
    maxBudgetUsdc: '1.000000',
    ...overrides,
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body)
  const chunks = [new TextEncoder().encode(text)]
  let idx = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (idx < chunks.length) ctrl.enqueue(chunks[idx++]!)
      else ctrl.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'application/json' } })
}

export function makeChallenge(url: string, amount = '80000') {
  const requirement = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    amount,
    payTo: '0xRevenue',
  }
  return { x402Version: 2, resource: { url }, accepts: [requirement] }
}

export function challengeResponse(url: string, challengeAmount = '80000'): Response {
  const encoded = Buffer.from(JSON.stringify(makeChallenge(url, challengeAmount)), 'utf8').toString(
    'base64',
  )
  return new Response(null, { status: 402, headers: { 'payment-required': encoded } })
}

export function terminalReport(
  id: string,
  url: string,
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'PASS',
) {
  const decision = status === 'PASS' ? 'safe_to_ship' : status === 'FAIL' ? 'failed' : 'review'
  return {
    id,
    url,
    kind: 'check',
    status,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    verdict: { decision, reasons: [], blockingIssues: status === 'FAIL' ? 1 : 0 },
    viewports: Object.fromEntries(
      ['phonePortrait', 'phoneLandscape', 'desktop'].map((vp) => [
        vp,
        {
          loadStatus: 'success',
          accessibility: { completed: true },
          layoutObservation: 'measured',
          screenshotUrl: `/screenshots/${vp}`,
          screenshotSha256: 'fixture-sha256',
        },
      ]),
    ),
  }
}

export function makeCheckpoint() {
  let state: ReleaseState | null = null
  return {
    load: () => state,
    save: (s: ReleaseState) => {
      state = s
    },
    get: () => state,
  }
}

export const noValidation = async (_url: string) => ({ valid: true as const, url: _url })
