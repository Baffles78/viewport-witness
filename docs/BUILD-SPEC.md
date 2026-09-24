# ViewportWitness V1 build specification

## Outcome

Build a small public API that AI agents can pay to use. A caller submits one public HTTPS page. The service visits it in three browser sizes and returns a stable JSON report plus screenshots.

This build is complete when it works locally in free test mode, is container-ready for an existing VPS, and has an implemented but disabled x402 production payment adapter. Public deployment and mainnet activation are separate release steps.

## Naming and addresses

- Service name: ViewportWitness
- Production payment networks: Base mainnet (`eip155:8453`) and, when separately enabled and
  reviewed, Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`)
- Production asset: native USDC on each enabled network
- Public revenue destination: `0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400`
- Public test wallet address: `0xa0c0bca74d9edf0d3da3449b5c9bf785e25633ce`
- The test address is documentation/evidence only. No signer or private key belongs in the service.
- Price: `$0.08` USDC for one full three-viewport report.

## API

Provide:

- `GET /` small JSON or HTML service card with links only.
- `GET /health` process liveness; no internal details.
- `GET /ready` reports whether storage and browser worker are usable.
- `GET /openapi.json` complete machine-readable contract.
- `GET /llms.txt` concise agent usage instructions.
- `GET /.well-known/x402` payment/discovery metadata.
- `POST /v1/checks` creates one paid QA job in production mode. In local test mode it may run without payment and must label the result `paymentMode: test`.
- `GET /v1/checks/:id` returns queued/running/complete/failed state and the result when available.
- `GET /v1/checks/:id/screenshots/:viewport` returns a retained screenshot with safe headers.

Request body: `{ "url": "https://example.com" }`. Reject extra fields, non-HTTPS URLs, URL credentials, non-standard ports, oversized input, and unsafe destinations. Return stable error codes.

Use an idempotency key so retries do not create duplicate jobs. In production, also bind the job to the settled payment identity/header so one payment cannot create unlimited jobs.

## Report

For each viewport (`phonePortrait`, `phoneLandscape`, `desktop`), capture:

- load status and elapsed time
- final URL and redirect count
- screenshot URL, dimensions, byte size, and SHA-256
- browser console errors (bounded and redacted)
- page crashes/errors
- failed network requests and HTTP responses of 400 or higher (bounded and redacted)
- horizontal overflow and major off-screen elements
- accessibility results using axe-core, grouped by impact with bounded examples
- safe interaction observations: visible/focusable controls and keyboard focus reachability only

Top-level report includes `PASS`, `FAIL`, or `INCONCLUSIVE`, created/expiry timestamps, checks performed, limitations, content hash, and `paymentMode`. A hash is evidence of content integrity; do not call it a cryptographic signature.

## Runtime design

- Node.js 22 or newer and strict TypeScript.
- Express is acceptable. SQLite in WAL mode is acceptable for jobs, idempotency, and metadata.
- One worker at a time by default. API and worker code must be separable into different processes later.
- Use Playwright Chromium and axe-core.
- Do not require Redis, Postgres, object storage, a paid RPC, or a paid monitoring service for V1.
- Store screenshots on a mounted local volume. Delete jobs and screenshots after seven days. Enforce a configurable total storage ceiling with oldest-first cleanup.
- Graceful shutdown must stop taking work and safely return an in-progress job to a retryable state.

## Network isolation

Apply the target policy before navigation and to every redirect and browser subrequest:

- HTTPS only and ports 443/default only.
- Resolve DNS and reject loopback, RFC1918, carrier-grade NAT, link-local, multicast, reserved/documentation, unspecified, and cloud metadata ranges for IPv4 and IPv6.
- Reject hostnames such as localhost and `.local`.
- Re-resolve and re-check redirects to reduce DNS rebinding risk.
- Abort file, ftp, data, blob, websocket, and other unsupported schemes.
- Set bounded navigation (30 seconds), at most five redirects, at most 100 requests, at most 15 MB total downloaded response bodies, and bounded response/console samples.
- Never expose response bodies, cookies, authorization headers, URL credentials, or arbitrary page text in reports/logs.

## Payments

Integrate the current official x402 TypeScript server packages using a facilitator client. The
production receivers need only public `PAY_TO`, `SOLANA_TEST_PAY_TO`, and
`SOLANA_REVENUE_PAY_TO` destinations; the service must not require receiver private keys.

Payment modes:

- `test`: no payment verification or settlement; local-only by default and clearly labeled.
- `testnet`: Base Sepolia plus optional Solana Devnet when facilitator credentials are supplied;
  never claim mainnet revenue.
- `production`: Base mainnet plus optional Solana mainnet, exact `$0.08`, and the reviewed revenue
  addresses. This mode must refuse to start unless `ENABLE_MAINNET_PAYMENTS=true` and required
  facilitator credentials are present. Solana must remain absent unless
  `ENABLE_SOLANA_PAYMENTS=true`; the application must select the test or revenue destination from
  `PAYMENT_MODE` rather than one shared Solana address variable.

Do not invent a successful payment response. Failed or unavailable verification must fail closed. Keep facilitator credentials in environment variables only. `.env.example` contains names and safe defaults, never values.

## Containers and operations

Provide a production multi-stage Dockerfile and Compose file suitable for an existing VPS behind Cloudflare/Nginx. Run as non-root with init, read-only root filesystem where practical, `no-new-privileges`, dropped capabilities, bounded memory (1.5 GB), CPU, PIDs, and mounted data/artifact volumes. Include a health check.

Provide `docs/RUNBOOK.md` covering install, local start, test mode, backups, retention, logs, upgrades, rollback, VPS capacity check, Cloudflare/Nginx handoff, and the separate reviewed mainnet activation step. No automated public deployment in this task.

## Verification

At minimum:

- formatting, lint, strict typecheck, and unit tests
- SSRF tests for unsafe IPv4/IPv6/hostnames, redirects, URL credentials, schemes, and ports
- idempotency and payment-mode fail-closed tests
- job lifecycle and retention tests
- local end-to-end run against a controlled fixture page, producing all three screenshots and a report
- container configuration validation where Docker is available

Keep test artifacts out of Git. Record exact commands and results in `docs/BUILD-EVIDENCE.md`.
