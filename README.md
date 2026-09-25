# ViewportWitness by Apex Labs

Two low-resource paid agent tools complement browser QA: `extract_page` converts one public HTML page to deterministic Markdown for $0.005 USDC, and `web_release_gate` passively checks one public page's release security controls for $0.05 USDC. Both share the Base/Solana x402 rails, idempotency protection, single-worker queue, and seven-day report lifecycle. They do not accept caller-supplied HTML, credentials, cookies, custom headers, uploads, or private-network targets.

Remote MCP server and x402 API for AI-agent browser QA. Submit a public HTTPS URL and receive
screenshots, accessibility findings, layout analysis, and structured JSON across phone and
desktop viewports.

The live service is at **https://qa.honeygate.app**. A standard report costs $0.08 USDC,
read-only assertions cost $0.10, and a baseline comparison costs $0.12. Local instances can run
in test mode without payment.

- [Official MCP Registry listing](https://registry.modelcontextprotocol.io/v0.1/servers?search=viewport-witness)
- [MCP setup for ChatGPT, Claude, Codex, Cursor, and VS Code](docs/MCP-INSTALL.md)
- [Privacy policy](https://qa.honeygate.app/privacy) · [Terms](https://qa.honeygate.app/terms) · [Support](https://github.com/Baffles78/viewport-witness/issues)

---

## Live service

```bash
# Probe the live service (returns 402 with payment requirements)
curl -s -X POST https://qa.honeygate.app/v1/checks \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'

# Payment discovery
curl -s https://qa.honeygate.app/.well-known/x402 | jq .

# Agent skill manifest
curl -s https://qa.honeygate.app/skill.md
```

Use an x402-aware client (e.g. `@x402/fetch` with a funded wallet) for paid requests.
See [llms.txt](llms.txt) for the full agent usage guide.

---

## Local development

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run dev
```

```bash
# Create a check (test mode — no payment required)
curl -s -X POST http://localhost:3000/v1/checks \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}' | jq .

# Poll result
curl -s http://localhost:3000/v1/checks/JOB_ID | jq .status

# Get screenshot
curl -o desktop.png http://localhost:3000/v1/checks/JOB_ID/screenshots/desktop
```

Local defaults to `PAYMENT_MODE=test`. No CDP keys needed for test mode. Results are labeled
`paymentMode: "test"` and do not represent real payment settlements.

---

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info |
| GET | `/health` | Liveness probe |
| GET | `/ready` | Readiness probe (DB + worker) |
| GET | `/openapi.json` | OpenAPI 3.1 spec |
| GET | `/llms.txt` | Agent usage guide |
| GET | `/skill.md` | Concise agent skill manifest |
| GET | `/privacy` | Privacy policy |
| GET | `/terms` | Terms of service |
| GET | `/logo.png` | Directory and integration logo |
| GET | `/.well-known/x402` | Payment discovery |
| POST | `/v1/checks` | Create a QA check job |
| POST | `/v1/verify` | Check explicit read-only assertions |
| POST | `/v1/compare` | Compare against an unexpired baseline job |
| POST | `/mcp` | Remote MCP interface with x402-paid tools |
| GET | `/v1/checks/:id` | Poll job status / get report |
| GET | `/v1/checks/:id/screenshots/:viewport` | Download screenshot PNG |
| GET | `/v1/checks/:id/diffs/:viewport` | Download comparison diff PNG |

Viewports: `phonePortrait` (375×812), `phoneLandscape` (812×375), `desktop` (1440×900)

---

## Payment modes

| Mode | Payment required | Network |
|------|-----------------|---------|
| `test` | No | — (local dev only) |
| `testnet` | Yes (x402) | Base Sepolia; optional Solana Devnet |
| `production` | Yes (x402, $0.08 USDC) | Base mainnet; optional Solana mainnet |

Production mode requires `ENABLE_MAINNET_PAYMENTS=true` and a reviewed release.
Solana is separately off by default. Enabling it requires `ENABLE_SOLANA_PAYMENTS=true`, the
public test and revenue destinations, facilitator capability confirmation, and its own settlement
test. The application selects the correct destination from `PAYMENT_MODE`.
Paid modes also require a private `CUSTOMER_HASH_SECRET` of at least 32 characters. It creates a
stable, one-way customer label for repeat-use measurements; raw payer wallet addresses are not
stored. Attribution is best-effort and never blocks delivery after a verified payment. Changing
this secret starts a new measurement series and does not rewrite old jobs.
See [docs/RUNBOOK.md](docs/RUNBOOK.md) for activation steps.

---

## Run tests

```bash
npm test              # unit tests (no browser required)
npm run test:e2e      # local e2e (requires Playwright Chromium)
npm run typecheck     # TypeScript strict check
```

---

## Docker

```bash
docker compose build
docker compose up -d
curl http://localhost:3000/health
```

---

## Further reading

- [Build specification](docs/BUILD-SPEC.md) — full product and safety spec
- [Runbook](docs/RUNBOOK.md) — operations, backups, upgrades, mainnet activation
- [Agent guide](llms.txt) — machine-readable usage instructions
- [Skill manifest](skill.md) — concise agent skill guide
- [MCP install guide](docs/MCP-INSTALL.md) — connect ChatGPT, Claude, Codex, Cursor, and VS Code
- [Privacy policy](docs/PRIVACY.md) and [terms](docs/TERMS.md)
- [Customer feedback](https://github.com/Baffles78/viewport-witness/issues/new?template=customer-feedback.yml) — request a capability or report a result without posting secrets
- [Build evidence](docs/BUILD-EVIDENCE.md) — test results and known limits

---

MIT License
