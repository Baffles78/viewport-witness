# ViewportWitness V1 build evidence

Runtime release commit: `462aad58fbf37f55fa3265f963206eab84421a71`
Build date: 2026-09-24
Implementation: bounded Claude build, then coordinator correction and verification

## Verified checks

All commands below ran from the repository root.

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 88 passed |
| `ALLOW_EXTERNAL_E2E=true npm run test:e2e` | 10 passed, including a real three-viewport job against `https://example.com` |
| `npm run build` | Passed |
| `npm audit --omit=dev` | 0 production vulnerabilities |
| `docker compose config --quiet` | Passed |
| `docker build -t viewport-witness:local .` | Passed |
| Container health and readiness | Passed |
| Container job against `https://example.com` | `PASS`, three screenshots, `paymentMode: test` |
| Playwright CLI inspection of `/` | Clean snapshot, 0 console errors, 0 warnings |

The final container smoke run used about 316 MiB of its 1.5 GiB limit and 71 processes after the job completed. This is one sample, not a worst-case capacity guarantee.

## Independent review

- Browser worker boundaries: passed for a non-public test deployment after cleanup and timeout hardening.
- Payment boundary: passed for a non-public test deployment; no mainnet settlement was attempted.
- URL and network filtering: no bypass found. The review's structural findings were corrected, while the DNS rebinding release limit below remains explicit.
- API safety: an initial review found validation ordering and duplicate-request weaknesses. Those were corrected, and the independent re-review passed at commit `8719379`.
- CDP money path: a separate read-only review returned a conditional pass for public testnet. Its price and route-order conditions were corrected and verified. The remaining condition was resolved directly against the pinned x402 2.27.0 package source: `extra.paymentFlow: "upfront"` selects `settleBeforeHandler: true`, and the Exact EVM scheme explicitly supports `upfront`. Coinbase CDP SDK 1.56.0 and all x402 packages are pinned exactly.
- VPS deployment: an initial independent review found three public-testnet blockers (swap headroom, a proxy hop-by-hop header, and IPv6 egress). All three were corrected. The exact corrected Docker, Nginx, firewall, and systemd package then passed independent re-review for public testnet. Compose parsing, firewall-script syntax, and an origin-side `nginx -t` also passed.
- Live firewall testing found and corrected a host-public-IP loopback path. The final rules block metadata, private, loopback, and same-VPS destinations while preserving host-initiated health and reverse-proxy replies. Both corrections passed exact-source independent review.
- Live proxy testing found and corrected an `http://` x402 resource URL. Express now trusts forwarded scheme headers only from loopback and the fixed Docker gateway; the exact correction passed independent review and the public challenge advertises `https://qa.honeygate.app/v1/checks`.
- Mainnet release review passed in focused exact-source packets for the payment/network gates, validation and settlement ordering, durable uniqueness, startup wiring, and deployment binding. The final blocker was fixed by pinning the Docker bridge gateway to the exact trusted proxy address; the immutable one-line fix passed independent review.

The reviewed release is publicly deployed at `https://qa.honeygate.app` with Base mainnet payments active.

## Behaviors exercised

- Three viewports: 375x812, 812x375, and 1440x900.
- Screenshot creation and retrieval.
- Accessibility, layout, console, failed-request, and focusability collection.
- Stable job creation, polling, completion, expiry metadata, and idempotency.
- Restart recovery for queued, running, and retryable jobs.
- Test mode is always labeled and never claims settlement.
- Production mode refuses to start without the mainnet flag and facilitator configuration.
- Official x402 v2 packages are installed and compile against their current types.
- Paid routes request the EVM `upfront` flow so settlement precedes browser work.
- A payment-signature fingerprint is stored uniquely to prevent one payment from creating multiple jobs.
- Non-HTTPS URLs, credentials, unsafe ports, local/private/reserved IPs, empty DNS results, and local hostnames are rejected.
- The complete URL and DNS policy runs for the initial navigation, every redirect, and every subrequest.
- More than five redirects, 100 requests, or 15 MiB transferred ends or blocks further work.
- A timed-out or interrupted worker closes its browser context and leaves the job retryable.

## Container controls

- Non-root Playwright user.
- Read-only root filesystem with dedicated data and temporary volumes.
- `no-new-privileges` and all Linux capabilities dropped.
- 1.5 GiB memory, 1.5 CPU, and 256 process limits.
- Health check in the image and Compose configuration.
- Mainnet payments disabled by default in committed example configuration; the protected production environment enables them after the recorded review gate.

## Remaining release limits

1. **No receiver signer is present.** The VPS stores only the public revenue address. This is intentional.
2. **The smoke payer is deliberately low balance.** It held 4.92 USDC after the single paid smoke and is not a revenue or treasury wallet.
3. **Evidence is hashed, not signed.** A signing key and signed receipts are outside V1 until a reviewed key-custody design exists.
4. **Capacity is bounded, not proven at high volume.** The service has container limits and monitoring, but the launch evidence is a single-job production proof rather than a load test.

## Public Base Sepolia release evidence

- Cloudflare proxied A record: `qa.honeygate.app` -> origin `5.161.82.9`.
- Public `/health`, `/ready`, and `/.well-known/x402` passed through Cloudflare TLS.
- CDP credential is restricted to project `ViewportWitness`, VPS IP `5.161.82.9/32`, and View access; Trade, Transfer, Receive, Export, and Manage remain disabled.
- The VPS authenticated to Coinbase's facilitator and confirmed exact x402 support for `eip155:84532`.
- A dedicated root-only test payer completed a real protocol payment of 80,000 atomic test USDC (0.08 USDC).
- Settlement transaction: `0x4404814645f75ecbc30d58a3bdde3184adf8e10fc06cef01c408812677493aee`, successful in Base Sepolia block `47251956`.
- The public revenue address received exactly 0.08 test USDC.
- Paid job `c323de23-f76c-48bc-aa44-4ac7c060fe03` completed `PASS` with three retained screenshots and `paymentMode: testnet`.

## Public Base mainnet release evidence

- The protected environment was changed to `PAYMENT_MODE=production` and `ENABLE_MAINNET_PAYMENTS=true` only after the exact-source release reviews passed.
- The VPS authenticated to Coinbase's facilitator and confirmed x402 v2 `exact` support for `eip155:8453`.
- Public `/health` and `/ready` passed, and `/.well-known/x402` advertised `$0.08 USDC`, Base `eip155:8453`, the intended revenue address, and `testMode: false`.
- An unauthenticated public request returned HTTP 402 with HTTPS resource binding, the Base USDC contract, and exactly 80,000 atomic USDC.
- The isolated root-only smoke payer sent exactly 0.08 USDC through the live x402 flow. Settlement transaction: `0x68cec2895b4bcbb3141dcca17cdf681d359cebd10a52ffc456d01bac6dd0b4c1`, successful in Base block `51742143`.
- The payer balance moved from 5.00 to 4.92 USDC and the revenue address received exactly 0.08 USDC.
- Paid production job `d185bd84-a0da-49de-bc3f-4057b972337c` completed `PASS` across all three viewports with three retained screenshots and `paymentMode: production`.

## Re-run commands

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm run lint
npm test
ALLOW_EXTERNAL_E2E=true npm run test:e2e
npm run build
npm audit --omit=dev
docker compose config --quiet
docker build -t viewport-witness:local .
```
