# ViewportWitness by Apex Labs

Browser QA API for AI agents. Submit a public HTTPS URL and receive screenshots, accessibility
findings, layout analysis, and a structured JSON report across three browser viewports.

The live service is at **https://qa.honeygate.app** and requires a $0.08 USDC x402 payment per
report. Local instances can run in test mode without payment.

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
| GET | `/.well-known/x402` | Payment discovery |
| POST | `/v1/checks` | Create a QA check job |
| GET | `/v1/checks/:id` | Poll job status / get report |
| GET | `/v1/checks/:id/screenshots/:viewport` | Download screenshot PNG |

Viewports: `phonePortrait` (375×812), `phoneLandscape` (812×375), `desktop` (1440×900)

---

## Payment modes

| Mode | Payment required | Network |
|------|-----------------|---------|
| `test` | No | — (local dev only) |
| `testnet` | Yes (x402) | Base Sepolia |
| `production` | Yes (x402, $0.08 USDC) | Base mainnet |

Production mode requires `ENABLE_MAINNET_PAYMENTS=true` and a reviewed release.
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
- [Build evidence](docs/BUILD-EVIDENCE.md) — test results and known limits

---

MIT License
