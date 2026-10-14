/** Isolated buyer workflow: real browser evidence + real SDK signatures, simulated payment acceptance.
 * No funded wallet, blockchain submission, production API call, or customer data.
 */
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setServers } from 'node:dns'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyTypedData } from 'viem'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.resolve(process.argv[2] ?? 'out/buyer-demo')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-buyer-demo-'))
if (process.env.VW_SAMPLE_DNS_SERVERS)
  setServers(process.env.VW_SAMPLE_DNS_SERVERS.split(',').map((value) => value.trim()))
Object.assign(process.env, {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'test',
  ENABLE_MAINNET_PAYMENTS: 'false',
  ENABLE_SOLANA_PAYMENTS: 'false',
  DATA_DIR: scratch,
  DB_PATH: path.join(scratch, 'demo.db'),
  SCREENSHOTS_DIR: path.join(scratch, 'screenshots'),
})
for (const key of [
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'CUSTOMER_HASH_SECRET',
  'FACILITATOR_URL',
])
  delete process.env[key]
const { config } = await import('../dist/config.js')
const { JobStore } = await import('../dist/db.js')
const { WorkerRunner } = await import('../dist/worker/runner.js')
const { createApp } = await import('../dist/api/index.js')
const { runReleaseCheck } = await import('../dist/release-check.js')
const { createX402PaymentAdapter } = await import('../dist/x402-adapter.js')
await fs.mkdir(config.SCREENSHOTS_DIR, { recursive: true })
await fs.mkdir(out, { recursive: true })
const store = new JobStore(config.DB_PATH)
store.init()
const runner = new WorkerRunner(store, config.SCREENSHOTS_DIR, 120000, 'test')
let api, gateway
let fixture = 'broken'
let signatures = 0
const receipts = []
const account = privateKeyToAccount(generatePrivateKey()) // Ephemeral, never saved or funded.
const recipient = '0x' + '22'.repeat(20)
const endpoint = 'https://qa.honeygate.app/v1/checks'
const requirement = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  payTo: recipient,
  amount: '80000',
  maxTimeoutSeconds: 60,
  extra: { name: 'USD Coin', version: '2' },
}
const challenge = { x402Version: 2, resource: { url: endpoint }, accepts: [requirement] }
try {
  await runner.start()
  // Test-only transport interception. The production worker's target policy still runs
  // before route.continue; then we supply the named synthetic HTML instead of the network page.
  const browser = runner.browser
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async (...args) => {
    const context = await newContext(...args),
      newPage = context.newPage.bind(context)
    context.newPage = async () => {
      const page = await newPage(),
        register = page.route.bind(page)
      page.route = async (pattern, handler) =>
        register(pattern, (route) =>
          handler(
            new Proxy(route, {
              get(target, key) {
                if (key === 'continue')
                  return async () => {
                    if (!route.request().url().startsWith('https://example.com'))
                      throw new Error('Fixture attempted an unexpected network target')
                    await route.fulfill({
                      status: 200,
                      contentType: 'text/html',
                      body: await fs.readFile(
                        path.join(root, `examples/release-demo/${fixture}.html`),
                        'utf8',
                      ),
                    })
                  }
                const value = Reflect.get(target, key)
                return typeof value === 'function' ? value.bind(target) : value
              },
            }),
          ),
        )
      return page
    }
    return context
  }
  api = http.createServer(createApp(store, runner, config))
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
  const apiBase = `http://127.0.0.1:${api.address().port}`
  gateway = http.createServer(async (req, res) => {
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 10000) throw new Error('Request too large')
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks).toString()
      if (req.method === 'POST' && req.url === '/v1/checks') {
        const encoded = req.headers['payment-signature']
        if (!encoded) {
          res.writeHead(402, {
            'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64'),
            'content-type': 'application/json',
          })
          res.end('{"paymentRequired":true,"simulation":true}')
          return
        }
        const payment = JSON.parse(Buffer.from(encoded, 'base64').toString()),
          auth = payment.payload.authorization
        if (
          JSON.stringify(payment.accepted) !== JSON.stringify(requirement) ||
          auth.to.toLowerCase() !== recipient ||
          auth.value !== '80000'
        )
          throw new Error('Unapproved simulated requirement')
        const valid = await verifyTypedData({
          address: account.address,
          domain: {
            name: 'USD Coin',
            version: '2',
            chainId: 8453,
            verifyingContract: requirement.asset,
          },
          types: {
            TransferWithAuthorization: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'validAfter', type: 'uint256' },
              { name: 'validBefore', type: 'uint256' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
          primaryType: 'TransferWithAuthorization',
          message: auth,
          signature: payment.payload.signature,
        })
        if (!valid) throw new Error('Invalid SDK authorization')
        signatures++
      }
      if (!/^\/v1\/checks(?:\/[a-zA-Z0-9-]+(?:\/screenshots\/[a-zA-Z]+)?)?$/.test(req.url))
        throw new Error('Gateway path outside isolated workflow')
      const forwarded = await fetch(apiBase + req.url, {
        method: req.method,
        headers: {
          'content-type': 'application/json',
          ...(req.headers['idempotency-key']
            ? { 'idempotency-key': req.headers['idempotency-key'] }
            : {}),
        },
        ...(req.method === 'POST' ? { body } : {}),
        redirect: 'error',
      })
      res.writeHead(forwarded.status, {
        'content-type': forwarded.headers.get('content-type') ?? 'application/json',
      })
      res.end(Buffer.from(await forwarded.arrayBuffer()))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":"isolated_gateway_validation_failed"}')
    }
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const localGateway = `http://127.0.0.1:${gateway.address().port}`
  const localFetch = async (url, init) => {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://qa.honeygate.app')
      throw new Error('Production/signer traffic cannot escape the isolated gateway')
    return fetch(localGateway + parsed.pathname, { ...init, redirect: 'error' })
  }
  const adapter = createX402PaymentAdapter({
    network: 'eip155:8453',
    signer: account,
    payTo: recipient,
    maxTotalUsdc: '0.16',
    fetchFn: localFetch,
  })
  for (const version of ['broken', 'fixed']) {
    fixture = version
    let checkpoint = null
    const manifest = {
      runId: `demo-${version}-${Date.now()}`,
      pages: ['https://example.com'],
      maxBudgetUsdc: '0.08',
      allowedNetwork: 'eip155:8453',
      allowedPayTo: recipient,
    }
    const checkpointPath = path.join(out, version + '-checkpoint.json')
    const options = {
      fetchFn: localFetch,
      adapter,
      execute: true,
      pollIntervalMs: 100,
      pollAttempts: 120,
      checkpoint: {
        load: () => checkpoint,
        save: async (value) => {
          checkpoint = structuredClone(value)
          await fs.writeFile(checkpointPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
        },
      },
    }
    const preview = await runReleaseCheck(manifest, { fetchFn: localFetch })
    if (!preview.dryRun || signatures !== receipts.length)
      throw new Error('Preview performed unexpected authorization')
    const start = performance.now(),
      result = await runReleaseCheck(manifest, options)
    if (result.decision !== (version === 'broken' ? 'FAIL' : 'PASS'))
      throw new Error('Unexpected before/after verdict: ' + result.decision)
    const id = checkpoint.pages[0].jobId
    const report = await (await fetch(apiBase + '/v1/checks/' + id)).json()
    const folder = path.join(out, version)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await fs.writeFile(path.join(folder, 'report.md'), result.markdown)
    for (const viewport of ['phonePortrait', 'phoneLandscape', 'desktop']) {
      const image = await fetch(apiBase + `/v1/checks/${id}/screenshots/${viewport}`)
      if (!image.ok) throw new Error('Missing screenshot')
      await fs.writeFile(
        path.join(folder, viewport + '.png'),
        Buffer.from(await image.arrayBuffer()),
      )
    }
    const signedBefore = signatures
    const resumed = await runReleaseCheck(manifest, options)
    if (signatures !== signedBefore || resumed.decision !== result.decision)
      throw new Error('Resume reauthorized or changed evidence')
    receipts.push({
      version,
      decision: result.decision,
      elapsedMs: Math.round(performance.now() - start),
      warnings: report.verdict.warnings,
      blockingIssues: report.verdict.blockingIssues,
      overflowViewports: Object.entries(report.viewports)
        .filter(([, v]) => v.overflowDetected)
        .map(([key]) => key),
      findings: report.diagnosis.findings.map((f) => ({ code: f.code, fix: f.fix })),
      previewDidNotSign: true,
      resumeDidNotSign: true,
    })
  }
  const evidence = {
    schema: 'viewport-witness-isolated-buyer-proof/v1',
    at: new Date().toISOString(),
    simulation: true,
    onChainPayments: 0,
    productionCalls: 0,
    sdkAuthorizationsCryptographicallyVerified: signatures,
    browserEvidence:
      'Real Chromium captures of local synthetic HTML; example.com response was intercepted after normal public-target validation.',
    scratchRecovery: scratch,
    receipts,
  }
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally {
  await runner.stop()
  if (gateway) await new Promise((resolve) => gateway.close(resolve))
  if (api) await new Promise((resolve) => api.close(resolve))
  store.close()
}
