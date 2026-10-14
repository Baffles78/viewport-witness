# Check your deployment before sign-off

ViewportWitness visits public HTTPS pages and returns screenshots, accessibility findings,
layout and browser-error evidence across three screen sizes. A standard check costs $0.08 USDC
per page. It cannot inspect authenticated pages or private staging networks.

## See the evidence first

Open the [free static sample](https://qa.honeygate.app/samples/example/).
This example was generated locally in test mode; no payment or customer data is involved.
It is a saved demonstration, not current target health. The sample URL becomes available
after the offering update is deployed; its files also live in `samples/example/` in this repository.

## Preview a budget without paying

Prerequisites: Node.js 22 or later, npm, Git, and a checkout of this repository.
Browser installation is unnecessary for the client. Run from the repository directory:

```sh
git clone https://github.com/Baffles78/viewport-witness.git
cd viewport-witness
npm ci
npm run build
```

Create `release.json` with your public page URL and a new ID for this deployment:

```json
{
  "runId": "my-deployment-001",
  "pages": ["https://example.com"],
  "maxBudgetUsdc": "0.08"
}
```

```sh
node scripts/release-check.mjs --manifest release.json --output out/
```

This previews the budget; it does not load a wallet, make a payment, or return a QA verdict.
You may include up to five pages; five standard checks quote $0.40 USDC.

## Authorize and run

Use your existing customer-owned wallet connector. Follow [AGENT-CLIENT.md](AGENT-CLIENT.md)
to configure the approved network, recipient, and (for Solana) facilitator fee payer in the
manifest. The connector must expose the signing interface documented there; an MCP connection
or wallet balance alone is insufficient. Never put keys or seed phrases in this repository.

Only after granting spending authority for that run:

```sh
node scripts/release-check.mjs --manifest release.json --state out/checkpoint.json --output out/ --execute --wallet-module ./existing-customer-wallet.mjs
```

Keep the checkpoint and generated reports. On interruption, resume the same run and checkpoint;
a `payment-attempted` state requires reconciliation, not a new payment. A new deployment gets
a fresh run ID. See [GROWTH-ACTIVATION.md](GROWTH-ACTIVATION.md) for recovery details.

## Read the result

Inspect the JSON and Markdown evidence in `out/`. PASS, FAIL and INCONCLUSIVE describe observed
page evidence, not permission to ship or a guarantee of correctness. Retained API reports expire
after seven days. Download needed evidence before expiry and review it before sharing.

For explicit pass/fail assertions, use `verify_page` ($0.10), which includes the browser QA pass.
For visual regression, create a baseline then use `compare_page` ($0.12) before that baseline expires.
Extraction and passive security checks are separate secondary tools. All six tools and client setup
are described in [MCP-INSTALL.md](MCP-INSTALL.md).

## Maintaining the sample

From a development checkout with Playwright Chromium installed, run `npm run build` then
`node scripts/generate-example-sample.mjs`. The generator accepts no target URL and checks
only `https://example.com`, using an isolated temporary database and a loopback API in test mode.
It clears payment credentials from its own process, stops its worker on completion, and retains
the temporary test data as a recovery copy. It never calls the paid production endpoint.
Review the resulting report and screenshots before committing an update. FAIL or INCONCLUSIVE
results must remain visible; the sample must not be curated into a fictitious PASS.

If Node's resolver points to an unavailable local DNS server, set `VW_SAMPLE_DNS_SERVERS` to
your working network resolver before generation. This affects only the generator process;
private-target checks remain enabled. It does not change Windows or production DNS settings.
