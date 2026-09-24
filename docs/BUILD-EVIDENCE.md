# ViewportWitness V1 build evidence

Branch: `feat/browser-qa-v1`
Build date: 2026-09-24
Implementation: bounded Claude build, then coordinator correction and verification

## Verified checks

All commands below ran from the repository root.

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 86 passed |
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

This is review evidence for a local, non-public test deployment. It is not approval for an Internet-facing or mainnet release.

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
- Mainnet payments disabled in the committed configuration.

## Remaining release limits

1. **No public deployment yet.** The image was tested locally and then stopped. VPS capacity, Nginx, Cloudflare DNS, and live TLS remain a release step.
2. **No live payment test yet.** No USDC was transferred. Base Sepolia can use the public test facilitator. Base mainnet requires choosing and configuring a production facilitator; the public x402.org facilitator must not be assumed to support mainnet.
3. **Facilitator authentication.** The adapter uses the official Coinbase CDP SDK facilitator client with `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`. The SDK generates endpoint-bound, short-lived authentication; static bearer auth and hand-written signing are not used. Fail-closed configuration guards have unit coverage. Live settlement has not been tested.
4. **DNS rebinding still needs a network control.** Application checks run before every browser request, but DNS can theoretically change between the check and Chromium's connection. Before public launch, add an outbound proxy/firewall policy that independently blocks private and metadata networks.
5. **No receiver signer is present.** The VPS stores only the public revenue address. This is intentional.
6. **Evidence is hashed, not signed.** A signing key and signed receipts are outside V1 until a reviewed key-custody design exists.

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
