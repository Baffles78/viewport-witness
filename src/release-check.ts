import { createHash } from 'node:crypto'
import { validatePublicHttpsUrl } from './ssrf.js'
import { buildAgentResult } from './agent-result.js'
import type { QAReport } from './types.js'

type Decision = 'PASS' | 'FAIL' | 'INCONCLUSIVE'
export type Requirement = {
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds?: number
  extra?: Record<string, unknown>
}
export type Challenge = {
  x402Version: number
  resource: { url: string }
  accepts: Requirement[]
  extensions?: Record<string, unknown>
}
export interface ReleaseManifest {
  runId: string
  pages: string[]
  maxBudgetUsdc: string
  allowedNetwork?: string
  allowedPayTo?: string
  allowedFeePayer?: string
}
export interface ReleasePage {
  index: number
  targetHash: string
  state: 'planned' | 'payment-attempted' | 'accepted'
  reservedAtomic: string
  jobId?: string
  decision?: Decision
  terminal?: boolean
}
export interface ReleaseState {
  schema: 'viewport-witness-release/v1'
  manifestHash: string
  pages: ReleasePage[]
}
export type PaymentAdapter = (input: {
  url: string
  request: RequestInit
  challenge: Challenge
  approvedRequirement: Requirement
  maximumAtomic: string
}) => Promise<Response>
interface Options {
  serviceUrl?: string
  execute?: boolean
  testMode?: boolean
  adapter?: PaymentAdapter
  fetchFn?: typeof fetch
  pollAttempts?: number
  pollIntervalMs?: number
  validateTarget?: typeof validatePublicHttpsUrl
  checkpoint?: {
    load: () => ReleaseState | null
    save: (state: ReleaseState) => void | Promise<void>
  }
  sleep?: (ms: number) => Promise<void>
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function usdcAtomic(value: string): bigint {
  if (!/^\d{1,8}(\.\d{1,6})?$/.test(value)) throw new Error('Invalid USDC budget')
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'))
}
const allowedAssets: Record<string, string> = {
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}
function requirementFor(challenge: Challenge, url: string, manifest: ReleaseManifest): Requirement {
  if (
    challenge.x402Version !== 2 ||
    challenge.resource?.url !== url ||
    !Array.isArray(challenge.accepts)
  )
    throw new Error('Unsupported or unbound payment challenge')
  const accepted = challenge.accepts.filter(
    (r) =>
      r &&
      typeof r === 'object' &&
      r.scheme === 'exact' &&
      typeof r.amount === 'string' &&
      /^\d{1,14}$/.test(r.amount) &&
      BigInt(r.amount) > 0n &&
      typeof r.payTo === 'string' &&
      r.payTo.length > 0 &&
      r.payTo.length <= 100 &&
      typeof r.asset === 'string' &&
      typeof r.network === 'string' &&
      (!manifest.allowedNetwork || r.network === manifest.allowedNetwork) &&
      (!manifest.allowedPayTo || r.payTo === manifest.allowedPayTo) &&
      (!manifest.allowedFeePayer || r.extra?.feePayer === manifest.allowedFeePayer) &&
      (r.network.startsWith('eip155:')
        ? allowedAssets[r.network] === r.asset.toLowerCase()
        : allowedAssets[r.network] === r.asset),
  )
  if (!accepted.length) throw new Error('No supported exact USDC requirement')
  return accepted.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0]!
}
async function readJson(response: Response): Promise<Record<string, unknown>> {
  const limit = 2 * 1024 * 1024
  const body = response.body
  if (!body) throw new Error('No response body')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > limit) {
          await reader.cancel()
          throw new Error('Response exceeds report limit')
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed response')
  return value as Record<string, unknown>
}
function jobId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error('Invalid accepted job identity')
  return value
}
export function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    url.username = ''
    url.password = ''
    return url.href.replace(/[\[\]<>`\r\n]/g, '')
  } catch {
    return '[redacted]'
  }
}
function safeText(value: unknown): string {
  return typeof value === 'string'
    ? value
        .slice(0, 300)
        .replace(/https?:\/\/[^\s]+/g, (url) => safeDisplayUrl(url))
        .replace(/[\[\]<>`\r\n]/g, ' ')
    : ''
}

export async function runReleaseCheck(manifest: ReleaseManifest, options: Options = {}) {
  if (
    !manifest ||
    Object.keys(manifest).some(
      (key) =>
        ![
          'runId',
          'pages',
          'maxBudgetUsdc',
          'allowedNetwork',
          'allowedPayTo',
          'allowedFeePayer',
        ].includes(key),
    ) ||
    !/^[-a-zA-Z0-9_]{1,60}$/.test(manifest.runId) ||
    !Array.isArray(manifest.pages) ||
    manifest.pages.length < 1 ||
    manifest.pages.length > 5 ||
    new Set(manifest.pages).size !== manifest.pages.length ||
    typeof manifest.maxBudgetUsdc !== 'string'
  )
    throw new Error(
      'A release needs a stable run ID, one to five unique pages and an explicit USDC budget',
    )
  const budget = usdcAtomic(manifest.maxBudgetUsdc)
  if (
    (manifest.allowedNetwork !== undefined &&
      !Object.hasOwn(allowedAssets, manifest.allowedNetwork)) ||
    (manifest.allowedPayTo !== undefined &&
      (typeof manifest.allowedPayTo !== 'string' ||
        !manifest.allowedPayTo ||
        manifest.allowedPayTo.length > 100)) ||
    (manifest.allowedFeePayer !== undefined &&
      (typeof manifest.allowedFeePayer !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(manifest.allowedFeePayer)))
  )
    throw new Error('Invalid approved network or recipient')
  if (budget <= 0n) throw new Error('Budget must be positive')
  const validate = options.validateTarget ?? validatePublicHttpsUrl
  for (const page of manifest.pages) {
    if (typeof page !== 'string' || page.length > 2048 || !(await validate(page)).valid)
      throw new Error('Every target must be a public HTTPS URL')
  }
  const service = new URL(options.serviceUrl ?? 'https://qa.honeygate.app')
  if (
    service.username ||
    service.password ||
    service.search ||
    service.hash ||
    service.pathname !== '/' ||
    !(
      (service.protocol === 'https:' && service.hostname === 'qa.honeygate.app' && !service.port) ||
      (options.testMode === true &&
        service.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(service.hostname))
    )
  )
    throw new Error('Unsupported service origin')
  if (
    options.testMode &&
    !(service.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(service.hostname))
  )
    throw new Error('Test mode requires a loopback test service')
  const execute = options.execute === true
  if (execute && !options.checkpoint) throw new Error('Execution requires a durable checkpoint')
  if (execute && !options.testMode && !options.adapter)
    throw new Error('Paid execution requires a customer-owned payment adapter')
  const attempts = options.pollAttempts ?? 60,
    interval = options.pollIntervalMs ?? 5000
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 120 ||
    !Number.isInteger(interval) ||
    interval < 0 ||
    interval > 10000
  )
    throw new Error('Polling must be bounded')
  const manifestHash = hash({
    manifest,
    service: service.origin,
    testMode: options.testMode === true,
  })
  const state: ReleaseState = options.checkpoint?.load() ?? {
    schema: 'viewport-witness-release/v1',
    manifestHash,
    pages: manifest.pages.map((url, index) => ({
      index,
      targetHash: hash(url),
      state: 'planned',
      reservedAtomic: '0',
    })),
  }
  if (
    state.schema !== 'viewport-witness-release/v1' ||
    state.manifestHash !== manifestHash ||
    state.pages.length !== manifest.pages.length ||
    state.pages.some(
      (p, index) =>
        p.index !== index ||
        p.targetHash !== hash(manifest.pages[index]) ||
        !['planned', 'payment-attempted', 'accepted'].includes(p.state) ||
        !/^\d{1,14}$/.test(p.reservedAtomic) ||
        (p.state === 'accepted' && !p.jobId),
    )
  )
    throw new Error('Checkpoint does not match the release')
  let reserved = state.pages.reduce((sum, page) => sum + BigInt(page.reservedAtomic), 0n)
  if (reserved > budget) throw new Error('Checkpoint exceeds budget')
  const fetchFn = options.fetchFn ?? fetch
  const request = async (url: string, init: RequestInit = {}) =>
    fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) })
  const endpoint = service.origin + '/v1/checks',
    preflights: Array<{
      requirement?: Requirement
      challenge?: Challenge
      response?: Record<string, unknown>
    }> = []
  let planned = 0n
  // Preflight every page before invoking any adapter: no surprise charge partway through an over-budget batch.
  for (const [index, url] of manifest.pages.entries()) {
    const page = state.pages[index]!
    if (page.state === 'accepted') {
      jobId(page.jobId)
      preflights.push({})
      continue
    }
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `release-${manifestHash.slice(0, 16)}-${manifest.runId}-${index}`,
        'x-viewportwitness-source': 'agent-client',
      },
      body: JSON.stringify({ url }),
    })
    if (response.status === 202) {
      const body = await readJson(response)
      if (!options.testMode && body.idempotent !== true && body.paymentReplay !== true)
        throw new Error('Unexpected unpaid accepted production request')
      jobId(body.id)
      preflights.push({ response: body })
      continue
    }
    if (response.status !== 402) throw new Error('Preflight refused; no payment adapter invoked')
    if (page.state === 'payment-attempted')
      throw new Error(
        'Prior payment attempt is uncertain; reconcile using the same run ID before any further payment',
      )
    const encoded = response.headers.get('payment-required')
    if (!encoded || encoded.length > 65536)
      throw new Error('Missing or oversized payment challenge')
    let challenge: Challenge
    try {
      challenge = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Challenge
    } catch {
      throw new Error('Malformed payment challenge; no payment attempted')
    }
    const requirement = requirementFor(challenge, endpoint, manifest)
    planned += BigInt(requirement.amount)
    preflights.push({ challenge, requirement })
  }
  if (reserved + planned > budget)
    throw new Error('Release exceeds approved budget; no payment adapter invoked')
  if (!execute)
    return {
      decision: 'INCONCLUSIVE' as Decision,
      dryRun: true,
      maximumAtomic: budget.toString(),
      quotedAtomic: planned.toString(),
      reservedAtomic: reserved.toString(),
      pages: manifest.pages.map(safeDisplayUrl),
      markdown:
        '# Release check preview\nNo payment adapter invoked. No release verdict is available.\n',
    }
  const reports: Array<{
    index: number
    url: string
    decision: Decision
    reportUrl?: string
    reasons: string[]
    terminal: boolean
  }> = []
  for (const [index, url] of manifest.pages.entries()) {
    const page = state.pages[index]!,
      preflight = preflights[index]!
    if (page.state !== 'accepted') {
      let body = preflight.response
      if (!body) {
        page.state = 'payment-attempted'
        page.reservedAtomic = preflight.requirement!.amount
        reserved += BigInt(page.reservedAtomic)
        await options.checkpoint!.save(state) // Await durable reservation before the customer-controlled payment call.
        const response = await options.adapter!({
          url: endpoint,
          request: {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `release-${manifestHash.slice(0, 16)}-${manifest.runId}-${index}`,
              'x-viewportwitness-source': 'agent-client',
            },
            body: JSON.stringify({ url }),
            redirect: 'error',
            signal: AbortSignal.timeout(20000),
          },
          challenge: preflight.challenge!,
          approvedRequirement: preflight.requirement!,
          maximumAtomic: page.reservedAtomic,
        })
        if (response.status !== 202)
          throw new Error(
            'Payment attempt did not return an accepted job; reconcile checkpoint, do not repay',
          )
        body = await readJson(response)
      }
      page.jobId = jobId(body.id)
      page.state = 'accepted'
      await options.checkpoint!.save(state)
    }
    const reportUrl = service.origin + '/v1/checks/' + jobId(page.jobId)
    let decision: Decision = 'INCONCLUSIVE',
      reasons = [
        'No terminal report within the bounded polling window; retain job ID and resume without repaying.',
      ]
    let terminal = false
    for (let poll = 0; poll < attempts; poll++) {
      let body: Record<string, unknown>
      try {
        const response = await request(reportUrl)
        if (!response.ok) break
        body = await readJson(response)
      } catch {
        break
      }
      if (body.id !== page.jobId || typeof body.url !== 'string' || body.url !== url) break
      if (['PASS', 'FAIL', 'INCONCLUSIVE'].includes(String(body.status)) && body.kind === 'check') {
        terminal = true
        decision = body.status as Decision
        const verdict = body.verdict as { decision?: unknown; reasons?: unknown[] } | undefined
        const expectedVerdictDecision =
          decision === 'PASS' ? 'safe_to_ship' : decision === 'FAIL' ? 'failed' : undefined
        if (expectedVerdictDecision && verdict?.decision !== expectedVerdictDecision) {
          terminal = false
          decision = 'INCONCLUSIVE'
          reasons = ['Verdict decision inconsistent with reported status; treated as inconclusive.']
          break
        }
        if (decision === 'PASS') {
          if (buildAgentResult(body as unknown as QAReport).decision !== 'safe_to_ship') {
            terminal = false
            decision = 'INCONCLUSIVE'
            reasons = [
              'Incomplete, expired or inconsistent report evidence; treated as inconclusive.',
            ]
            break
          }
        }
        reasons = (Array.isArray(verdict?.reasons) ? verdict.reasons : [])
          .slice(0, 5)
          .map(safeText)
          .filter(Boolean)
        break
      }
      if (['failed', 'retryable'].includes(String(body.status))) {
        reasons = ['The existing job needs attention; no new payment was attempted.']
        break
      }
      if (poll + 1 < attempts)
        await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          interval,
        )
    }
    page.decision = decision
    page.terminal = terminal
    await options.checkpoint!.save(state)
    reports.push({ index, url: safeDisplayUrl(url), decision, reportUrl, reasons, terminal })
  }
  const decision: Decision = reports.some((r) => r.decision === 'FAIL')
    ? 'FAIL'
    : reports.every((r) => r.decision === 'PASS')
      ? 'PASS'
      : 'INCONCLUSIVE'
  const markdown = [
    '# ViewportWitness release check',
    `\nResult: **${decision}**`,
    `\nPages: ${reports.length}. Reserved payment ceiling: ${reserved} atomic USDC. This is not a revenue or actual-settlement receipt.`,
    ...reports.flatMap((r) => [
      `\n## Page ${r.index + 1}: ${r.decision}`,
      r.url,
      `[Report evidence](${r.reportUrl})`,
      ...['phonePortrait', 'phoneLandscape', 'desktop'].map(
        (v) => `[${v} screenshot](${r.reportUrl}/screenshots/${v})`,
      ),
      ...r.reasons.map((x) => '- ' + x),
    ]),
    '\nReview targets and report contents before sharing. Reports expire under the service retention policy.',
  ].join('\n')
  return {
    schema: 'viewport-witness-release-summary/v1',
    runId: manifest.runId,
    manifestHash,
    decision,
    dryRun: false,
    maximumAtomic: budget.toString(),
    quotedAtomic: planned.toString(),
    reservedAtomic: reserved.toString(),
    pages: reports,
    markdown,
  }
}
