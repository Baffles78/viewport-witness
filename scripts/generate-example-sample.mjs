// Regenerate only the public Example Domain demonstration, never a paid service job.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setServers } from 'node:dns'

// Optional process-only resolver override for development PCs with unavailable local DNS.
// Target addresses and all browser subrequests still pass the normal SSRF policy.
if (process.env.VW_SAMPLE_DNS_SERVERS) {
  setServers(process.env.VW_SAMPLE_DNS_SERVERS.split(',').map((value) => value.trim()))
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-example-sample-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  PAYMENT_MODE: 'test',
  ENABLE_MAINNET_PAYMENTS: 'false',
  ENABLE_SOLANA_PAYMENTS: 'false',
  DATA_DIR: scratch,
  DB_PATH: path.join(scratch, 'test.db'),
  SCREENSHOTS_DIR: path.join(scratch, 'screenshots'),
})
for (const name of [
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'FACILITATOR_URL',
  'CUSTOMER_HASH_SECRET',
])
  delete process.env[name]
const { config } = await import('../dist/config.js')
const { JobStore } = await import('../dist/db.js')
const { WorkerRunner } = await import('../dist/worker/runner.js')
const { createApp } = await import('../dist/api/index.js')
await fs.mkdir(config.SCREENSHOTS_DIR, { recursive: true })
const store = new JobStore(config.DB_PATH)
store.init()
const runner = new WorkerRunner(store, config.SCREENSHOTS_DIR, 120000, 'test')
let server
try {
  await runner.start()
  server = http.createServer(createApp(store, runner, config))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${base}/v1/checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),
  })
  if (response.status !== 202)
    throw new Error(`Sample request rejected: ${response.status} ${await response.text()}`)
  const job = await response.json()
  const deadline = Date.now() + 130000
  let report
  while (Date.now() < deadline) {
    const poll = await fetch(`${base}${job.pollUrl}`)
    const body = await poll.json()
    if (['PASS', 'FAIL', 'INCONCLUSIVE'].includes(body.status)) {
      report = body
      break
    }
    if (['failed', 'retryable'].includes(body.status)) throw new Error(`Sample job ${body.status}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!report) throw new Error('Sample generation timed out')
  const files = new Map()
  for (const viewport of ['phonePortrait', 'phoneLandscape', 'desktop']) {
    const image = await fetch(`${base}/v1/checks/${job.id}/screenshots/${viewport}`)
    if (!image.ok || !image.headers.get('content-type')?.includes('image/png'))
      throw new Error(`Missing ${viewport} screenshot`)
    files.set(`${viewport}.png`, Buffer.from(await image.arrayBuffer()))
  }
  // Export links to the saved screenshots rather than an expiring local job endpoint.
  for (const viewport of ['phonePortrait', 'phoneLandscape', 'desktop']) {
    report.viewports[viewport].screenshotUrl = `/samples/example/${viewport}.png`
  }
  files.set('report.json', JSON.stringify(report, null, 2) + '\n')
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    )
  files.set(
    'index.html',
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sample deployment report | ViewportWitness</title>
</head><body><main><a href="/agents">ViewportWitness</a><p class="label">SAVED DEMONSTRATION · NO PAYMENT</p>
<h1>See what a deployment check returns</h1>
<p>Actual browser evidence from <a href="https://example.com">Example Domain</a>, generated locally in test mode on ${escape(report.createdAt)}.</p>
<p class="notice">This is a static example, not a fresh production check or customer result. No wallet or payment was used. The original test job has an expiry date; these demonstration files remain available independently.</p>
<section class="summary"><h2>Observed result: ${escape(report.status)}</h2><p>${escape(report.diagnosis.overview)}</p>
<p>PASS means the required blocking checks passed; it does not mean there are no findings.
This report records ${escape(report.verdict.blockingIssues)} blocking issues and ${escape(report.verdict.warnings)} warnings. Review the evidence before sign-off.</p>
<dl><dt>Accessibility violations across viewports</dt><dd>${escape(report.summary.totalViolations)} observations; the same rule can appear in multiple views.</dd><dt>Browser errors</dt><dd>${escape(report.summary.totalErrors)}</dd><dt>Evidence limits</dt><dd>One public page at one point in time. Automated checks do not replace manual review or authorize deployment.</dd></dl>
${report.diagnosis.findings.map((finding) => `<h3>${escape(finding.code)}</h3><p>${escape(finding.diagnosis)}</p><p><strong>Suggested action:</strong> ${escape(finding.fix)}</p>`).join('')}
<p><a href="report.json">Download the complete JSON report</a> · <a href="provenance.json">Generation details</a></p></section>
<h2>Three real screenshots</h2><div class="grid">${['phonePortrait', 'phoneLandscape', 'desktop']
      .map((viewport) => {
        const view = report.viewports[viewport]
        return `<figure><figcaption><strong>${escape(viewport)}</strong><br>${view.dimensions.width} × ${view.dimensions.height} viewport · ${escape(view.loadStatus)} load</figcaption><a href="${viewport}.png">Open the ${escape(viewport)} screenshot</a></figure>`
      })
      .join('')}</div>
<footer><p>Check your own deployed public HTTPS page from $0.08 USDC. <a href="https://github.com/Baffles78/viewport-witness/blob/main/docs/QUICKSTART.md">Start with a no-payment budget preview</a>.</p><p>Regular API reports expire after seven days. This saved sample is not a live report ID.</p></footer></main></body></html>\n`,
  )
  files.set(
    'provenance.json',
    JSON.stringify(
      {
        sample: true,
        generatedAt: new Date().toISOString(),
        target: 'https://example.com',
        paymentMode: 'test',
        paymentSettled: false,
        method: 'Local isolated ViewportWitness API and browser worker; public Example Domain.',
        exportChanges:
          'Viewport screenshotUrl fields point to durable sample copies; test job timestamps and measured evidence are preserved.',
        retention: 'Static demonstration; original test job expiry does not remove these copies.',
        limitation:
          'One page at one point in time; not customer evidence or a live health guarantee.',
      },
      null,
      2,
    ) + '\n',
  )
  const output = path.join(root, 'samples/example')
  await fs.mkdir(output, { recursive: true })
  for (const [name, content] of files) await fs.writeFile(path.join(output, name), content)
  console.log(`Sample generated (${report.status}); no payment. Scratch recovery: ${scratch}`)
} finally {
  await runner.stop()
  if (server) await new Promise((resolve) => server.close(resolve))
  store.close()
}
