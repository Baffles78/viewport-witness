# ViewportWitness Runbook

The `extract` and `security` jobs share the existing single-worker queue and seven-day cleanup. Keep `EXTRACT_PRICE_USDC=0.005` and `SECURITY_PRICE_USDC=0.05` in paid modes. Each has one eight-second budget shared by fetching and parsing, at most five redirects, HTML-only responses, and separate 1 MiB compressed-wire and decoded-body ceilings. Every request connects to the exact public address that passed DNS validation while TLS still verifies the requested hostname. Parsing runs in a terminable worker thread with 96 MiB old-generation, 16 MiB young-generation, and 4 MiB stack limits. Do not increase worker concurrency on the shared VPS.

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

### Page history archive

Off by default. When `ARCHIVE_ENABLED=true`, completed browser reports are copied to `ARCHIVE_DIR`
(default `./data/archive`, `/data/archive` in containers) and sold through `POST /v1/history`.

- The archive must not sit inside `SCREENSHOTS_DIR`; the service refuses to start if it does.
- Snapshots expire after `ARCHIVE_RETENTION_DAYS` (default 90).
- `ARCHIVE_MAX_SNAPSHOTS_PER_URL` (default 30) keeps only the newest snapshots of each URL.
- `ARCHIVE_MAX_STORAGE_GB` (default 5) caps the archive; oldest snapshots go first.
- Cleanup runs at start-up and hourly, next to job retention.
- Anyone who knows an exact URL can see how many snapshots exist and buy them. Update
  `docs/PRIVACY.md` and `docs/TERMS.md` before turning it on for the live service.

To switch it off again, set `ARCHIVE_ENABLED=false` and restart. Existing archive files stay on
disk until you delete `/data/archive` yourself:

```bash
docker exec viewport-witness du -sh /data/archive
```

---

## Unresponsive job cancellation

A timed-out job normally aborts and settles before the same job is retried. If its work ignores
cancellation for one second, the worker records `job_abort_unresponsive`, stops accepting and
starting jobs, and logs that a restart is required. This bound returns control to the queue;
it **does not terminate** the underlying non-cooperative operation. The current process must
be restarted to clear that work. Other queued jobs remain in the database and are recovered
on startup. New worker-backed HTTP and MCP purchases are rejected before payment while the
worker is quarantined. A payment already settling when quarantine begins may leave its job
queued for restart; retain its ID and poll it. External settlement and the local database are
not one atomic transaction, so a crash between them does not carry an exactly-once guarantee.
Reconcile any uncertain payment before authorizing a new paid submission.

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

Production (VPS) runs `docker compose -f deploy/docker-compose.vps.yml up -d --no-build`
from systemd, so pulling source deploys nothing. A release needs an exact-commit owner
approval and the release gate in `AGENTS.md`. Procedure:

```bash
cd /opt/viewport-witness
docker image inspect viewport-witness-viewport-witness:latest --format '{{.Id}}'   # record
docker tag viewport-witness-viewport-witness:latest viewport-witness:rollback-$(date -u +%Y%m%d)-<oldsha>
systemctl start viewport-witness-backup.service    # fresh encrypted data copy; check its receipt
git fetch origin && git checkout --detach <newsha>  # checkout is detached; do not `git pull`
docker build --label org.opencontainers.image.revision=<newsha> \
  -t viewport-witness:release-<newsha> -t viewport-witness-viewport-witness:latest .
systemctl restart viewport-witness
```

Verify through the public hostname, not localhost. Nginx and Cloudflare sit in front of the
container and nginx's default 4 KiB proxy header buffer rejects oversized 402 challenge headers
with a 502 that localhost checks cannot see (this happened on 2026-11-08):

```bash
curl -s https://qa.honeygate.app/health
for r in checks verify compare extract security-gate; do
  curl -s -o /dev/null -w "$r %{http_code}\n" -X POST https://qa.honeygate.app/v1/$r \
    -H 'content-type: application/json' -d '{"url":"https://example.com"}'
done   # every line must be 402
docker image inspect viewport-witness-viewport-witness:latest \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Roll back on any failure (see below). `tests/payment-header-size.test.ts` guards the header
budget in CI.

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

On the VPS: `docker tag viewport-witness:rollback-<date>-<sha> viewport-witness-viewport-witness:latest`,
`git checkout --detach <sha>`, `systemctl restart viewport-witness`, then repeat the public checks.

---

## Unresolved payments

A paid attempt whose settlement outcome is not proven stays `payment_pending` with
settlement state `unknown`. It keeps its idempotency key, never expires, and tells the buyer
not to pay again. Startup logs the count (`[payment] N unresolved payment(s)`). When the count reaches
`PAYMENT_UNRESOLVED_LIMIT` (default 20) new paid requests get 503 before any charge.

```bash
docker exec viewport-witness node dist/payment-reconcile-cli.js list
docker exec viewport-witness node dist/payment-reconcile-cli.js settled <jobId> --tx <hash> --network <caip2>
docker exec viewport-witness node dist/payment-reconcile-cli.js unpaid <jobId> --evidence "<proof>"
```

Find the transfer of the exact price to the revenue address on the listed network near
`createdAt`. `settled` queues the original job once. Use `unpaid` only with proof the payment
can no longer settle (unused EVM authorization past `validBefore`, expired Solana blockhash
with no matching signature). A timeout or failed lookup is not proof. Details:
`docs/PAID-ADMISSION-RECOVERY.md`.

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
The additional Solana rail is also disabled by default (`ENABLE_SOLANA_PAYMENTS=false`).
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
   ENABLE_SOLANA_PAYMENTS=false
   PRICE_USDC=0.08
   CDP_API_KEY_ID=YOUR_KEY_ID
   CDP_API_KEY_SECRET=YOUR_BASE64_ED25519_PRIVATE_KEY
   CUSTOMER_HASH_SECRET=AT_LEAST_32_RANDOM_CHARACTERS
   ```
   The pinned CDP SDK also accepts the legacy PEM ECDSA format. Never commit either
   credential format or the customer hash secret to git or print them in logs. Generate the
   customer hash secret independently from the CDP key and wallet material. Keep it stable so the
   same payer receives the same anonymous label; rotating it intentionally starts a new series.
   Attribution is best-effort analytics; a verified payment must still receive its job when a
   wallet format cannot be attributed.
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

### Add the Solana payment rail

Do this only after the Base release remains healthy and an independent review covers the dual-rail
change.

1. Set `ENABLE_SOLANA_PAYMENTS=true`. Keep
   `SOLANA_TEST_PAY_TO=AwnqYWr32DUJvk4XKxfUSpVVYcoUuMFNp8XoBShm5qSS` and
   `SOLANA_REVENUE_PAY_TO=EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk`; the application
   selects the correct destination from `PAYMENT_MODE`.
2. Confirm the facilitator advertises x402 v2 `exact` support for Solana Devnet.
3. Confirm the 402 challenge contains both Base Sepolia and Solana Devnet, each at 80,000 atomic
   USDC units.
4. Complete one real Solana Devnet settlement and retain its transaction and completed job evidence.
5. For the reviewed production release, change `PAYMENT_MODE` only after confirming discovery
   automatically selects `EcgBX5ydNsGfJDrmW2qzNtJenDud8sNGSZBtt3XH2WJk`.
6. Complete one $0.08 Solana mainnet settlement before advertising the rail in registries.

Rollback is `ENABLE_SOLANA_PAYMENTS=false` followed by
`systemctl restart viewport-witness`; Base remains available.

**If any step fails, revert immediately:**

```bash
# In .env:
PAYMENT_MODE=test
ENABLE_MAINNET_PAYMENTS=false
# Then: systemctl restart viewport-witness
```

---

## Troubleshooting

| Symptom                             | Likely cause                                                  | Fix                                                                                             |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/ready` returns `"worker": "fail"` | Browser not started                                           | Restart service; check logs for Playwright errors                                               |
| `/ready` returns `"db": "fail"`     | SQLite file permissions                                       | Check `/data` volume mount and user permissions                                                 |
| Job stuck in `running`              | Worker timeout                                                | One retry is automatic; restart requeues persisted retryable work                               |
| `payment_not_configured` 503        | Paid mode lacks CDP credentials or the customer hash secret   | Set `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `CUSTOMER_HASH_SECRET` or switch to `test` mode |
| Solana receiver is unexpected       | Wrong payment mode or public destination configuration        | Disable the Solana rail and correct the separate test/revenue addresses before retrying         |
| `mainnet_payments_disabled` 503     | `PAYMENT_MODE=production` but `ENABLE_MAINNET_PAYMENTS=false` | Set `ENABLE_MAINNET_PAYMENTS=true` (after review) or use `test` mode                            |
| Out of disk space                   | Storage ceiling reached                                       | Decrease `RETENTION_DAYS` or increase `MAX_STORAGE_GB`                                          |
| High memory usage                   | Playwright browser leak                                       | Restart service; check for stuck jobs                                                           |
