# ViewportWitness

Browser QA API for AI agents. Submit a public HTTPS URL and receive screenshots, accessibility findings, layout analysis, and a structured JSON report across three browser viewports.

**Test mode ships enabled. Mainnet payments are disabled by default and require a separate reviewed activation step.**

---

## Quick start

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

---

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info |
| GET | `/health` | Liveness probe |
| GET | `/ready` | Readiness probe (DB + worker) |
| GET | `/openapi.json` | OpenAPI 3.1 spec |
| GET | `/llms.txt` | Agent usage guide |
| GET | `/.well-known/x402` | Payment discovery |
| POST | `/v1/checks` | Create a QA check job |
| GET | `/v1/checks/:id` | Poll job status / get report |
| GET | `/v1/checks/:id/screenshots/:viewport` | Download screenshot PNG |

Viewports: `phonePortrait` (375×812), `phoneLandscape` (812×375), `desktop` (1440×900)

---

## Payment modes

| Mode | Payment required | Network |
|------|-----------------|---------|
| `test` | No | — |
| `testnet` | Yes (x402) | Base Sepolia |
| `production` | Yes (x402, $0.08 USDC) | Base mainnet |

Production mode is disabled by default. See [docs/RUNBOOK.md](docs/RUNBOOK.md) for the mainnet activation steps.

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
- [Build evidence](docs/BUILD-EVIDENCE.md) — test results and known limits

---

MIT License
