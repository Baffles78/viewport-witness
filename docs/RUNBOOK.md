# ViewportWitness Runbook

This runbook covers day-to-day operations. For technical internals see [BUILD-SPEC.md](BUILD-SPEC.md).

---

## Prerequisites

- Node.js 22 or newer (`node --version`)
- npm 10 or newer
- git
- Docker and Compose (for container deployment; optional for local dev)
- At least 2 GB free RAM and 5 GB free disk for the Playwright browser

---

## Local development start

```bash
git clone https://github.com/your-org/viewport-witness
cd viewport-witness
npm install
npx playwright install chromium
cp .env.example .env
# Edit .env if needed (defaults work for local test mode)
npm run dev
```

The service starts on port 3000 in test mode. No payment is required.

Verify it works:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/
```

---

## Test mode

Test mode (`PAYMENT_MODE=test` in `.env`) means:
- No x402 payment required for any request.
- Every report will include `"paymentMode": "test"`.
- **Test mode does not represent a real payment settlement.**
- Safe to run locally, in CI, or on a staging VPS.

To confirm you are in test mode:
```bash
curl http://localhost:3000/.well-known/x402
# Should show: "testMode": true, "paymentRequired": false
```

Example check in test mode:
```bash
# Create a check
curl -s -X POST http://localhost:3000/v1/checks \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}' | jq .

# Poll result (replace JOB_ID with the id from above)
curl -s http://localhost:3000/v1/checks/JOB_ID | jq .status

# Download a screenshot (when complete)
curl -o screenshot.png http://localhost:3000/v1/checks/JOB_ID/screenshots/desktop
```

---

## Running tests

```bash
npm test          # unit tests (SSRF, payment, DB, idempotency)
ALLOW_EXTERNAL_E2E=true npm run test:e2e  # real three-viewport check
npm run typecheck # TypeScript strict check
npm run lint      # ESLint
```

Expected: all unit tests pass in a few seconds. The e2e test takes up to 2 minutes.

---

## Docker deployment

Build and start:
```bash
docker compose build
docker compose up -d
docker compose logs -f viewport-witness
```

Verify:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

Check container resource usage:
```bash
docker stats viewport-witness
```

---

## VPS setup

The service listens on port 3000. Put Nginx or Cloudflare in front.

Example Nginx config snippet:
```nginx
server {
    listen 443 ssl;
    server_name your-host.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
    }
}
```

Recommended VPS minimums:
- 2 GB RAM (Playwright Chromium uses ~300-500 MB per check)
- 2 CPU cores
- 20 GB disk (screenshots + DB)

---

## Backups

The data volume (`vw-data`) contains the SQLite database and all screenshots.

Manual snapshot:
```bash
docker compose stop viewport-witness
tar -czf vw-backup-$(date +%Y%m%d).tar.gz /var/lib/docker/volumes/viewport-witness_vw-data
docker compose start viewport-witness
```

Or use your VPS provider's volume snapshot feature.

**Frequency**: daily snapshots recommended. Reports expire after 7 days by default.

---

## Retention

Reports and screenshots are kept for `RETENTION_DAYS` days (default: 7).

To change:
1. Edit `.env`: `RETENTION_DAYS=14`
2. Restart the service: `docker compose restart`

Storage ceiling:
- `MAX_STORAGE_GB=10` (default) caps total screenshot storage.
- When exceeded, oldest jobs are deleted first automatically.

To check current storage:
```bash
docker exec viewport-witness du -sh /data
```

---

## Logs

```bash
docker compose logs -f viewport-witness
docker compose logs --tail 200 viewport-witness
```

Log format: `METHOD /path STATUS LATENCYms`

**What is not logged:**
- Full URLs of checked pages (only redacted domain names)
- Page content or page text
- Authorization headers or credentials
- Full stack traces (only error messages)
- Any user data beyond the job ID

Log level can be set via `LOG_LEVEL=debug|info|warn|error` in `.env`.

---

## Upgrades

```bash
git pull
docker compose build --no-cache
docker compose up -d --force-recreate
docker compose logs -f viewport-witness
```

Test after upgrade:
```bash
curl http://localhost:3000/health
npm test  # run from project dir
```

---

## Rollback

Tag images before major upgrades:
```bash
docker tag viewport-witness-viewport-witness:latest viewport-witness-viewport-witness:backup-YYYYMMDD
```

To rollback:
```bash
docker compose down
docker tag viewport-witness-viewport-witness:backup-YYYYMMDD viewport-witness-viewport-witness:latest
docker compose up -d
```

---

## VPS capacity check

```bash
# Disk
df -h /data

# Memory
free -h

# Container resources
docker stats viewport-witness --no-stream

# Container footprint
docker compose exec viewport-witness du -sh /data
```

---

## Mainnet activation — SEPARATE REVIEWED STEP

**Do not follow these steps without completing the independent code review gate.**

Production mainnet payments are disabled by default (`ENABLE_MAINNET_PAYMENTS=false`).
Activating them requires:

1. **Independent code review** completed and recorded by the coordinator.
2. Create a Coinbase CDP API key at the Coinbase Developer Platform dashboard.
   - Restrict it to the ViewportWitness project and the VPS public IP.
   - Leave Trade, Transfer, Receive, private-key Export, and policy Manage disabled.
   - Prefer Ed25519 unless the pinned SDK explicitly requires the legacy ECDSA format.
   - Download the one-time key file and store it securely; it is not recoverable.
3. The official CDP SDK uses Coinbase's hosted facilitator at
   `https://api.cdp.coinbase.com/platform/v2/x402` and binds authentication to each
   operation path. Do not hand-build or reuse a static bearer token.
4. Create/edit `.env` (never `docker-compose.yml`):
   ```
   PAYMENT_MODE=production
   ENABLE_MAINNET_PAYMENTS=true
   PRICE_USDC=0.08
   CDP_API_KEY_ID=YOUR_KEY_ID
   CDP_API_KEY_SECRET=YOUR_BASE64_ED25519_PRIVATE_KEY
   ```
   The pinned CDP SDK also accepts the legacy PEM ECDSA format. Never commit either
   credential format to git or print it in logs.
5. Restart the service:
   ```bash
   docker compose restart
   ```
6. Verify the mode:
   ```bash
   curl http://localhost:3000/.well-known/x402
   # Must show: "paymentRequired": true, "testMode": false, "network": "base (eip155:8453)"
   ```
7. Test with a real $0.08 USDC payment on Base mainnet.
8. Confirm response includes `"paymentMode": "production"` — not `"test"`.

**If any step fails, revert immediately:**
```bash
# In .env:
PAYMENT_MODE=test
ENABLE_MAINNET_PAYMENTS=false
# Then: docker compose restart
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `/ready` returns `"worker": "fail"` | Browser not started | Restart service; check logs for Playwright errors |
| `/ready` returns `"db": "fail"` | SQLite file permissions | Check `/data` volume mount and user permissions |
| Job stuck in `running` | Worker timeout | One retry is automatic; restart requeues persisted retryable work |
| `payment_not_configured` 503 | Paid mode lacks CDP credentials | Set `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` or switch to `test` mode |
| `mainnet_payments_disabled` 503 | `PAYMENT_MODE=production` but `ENABLE_MAINNET_PAYMENTS=false` | Set `ENABLE_MAINNET_PAYMENTS=true` (after review) or use `test` mode |
| Out of disk space | Storage ceiling reached | Decrease `RETENTION_DAYS` or increase `MAX_STORAGE_GB` |
| High memory usage | Playwright browser leak | Restart service; check for stuck jobs |
