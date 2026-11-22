# Check your deployment before sign-off

ViewportWitness visits public HTTPS pages and returns screenshots, accessibility findings,
layout and browser-error evidence across three screen sizes. A standard check costs $0.08 USDC
per page. It cannot inspect authenticated pages or private staging networks.

## See the evidence first

Open the [free static sample](https://qa.honeygate.app/samples/example/).
This example was generated locally in test mode; no payment or customer data is involved.
It is a saved demonstration, not current target health. Its files also live in
`samples/example/` in this repository.

## Preview a budget without paying

Prerequisites: Node.js 22 or later, npm, Git, and a checkout of this repository.
Browser installation is unnecessary for the client. Run from the repository directory:

```sh
git clone https://github.com/Baffles78/viewport-witness.git
cd viewport-witness
npm ci
npm run build
```

For one page, no handwritten configuration is needed:

```sh
npm run check:page -- --url https://example.com --run-id my-deployment-001 --output out/my-deployment-001 --network base --wallet cdp
```

This shows the quote, native-USDC asset, network and recipient in one step, plus any missing
CDP environment variable **names**, without loading a wallet or paying. The machine-readable
summary contains `paymentTerms` and `spendingApproved: false`. A quote is not approval of its
recipient or permission to spend, and execution rechecks the current challenge against your
approved network, recipient and budget. Preview does not return a QA verdict.
Omit `--wallet cdp` for another existing connector; Base and Solana remain available.
For up to five pages, use the manifest-based client in
[AGENT-CLIENT.md](AGENT-CLIENT.md).

## Authorize and run

For an **existing CDP Base account**, `--wallet cdp` selects the supplied connector. Configure
`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` and `VW_PAYER_ADDRESS` in your local
secret manager/environment. The command reports missing names, never their values. It does
not create or fund an account. Another existing signer can use `--wallet-module /path/to/connector.mjs`
instead. See [AGENT-CLIENT.md](AGENT-CLIENT.md) for both signing interfaces and Solana fee-payer
approval. An MCP connection or wallet balance alone is insufficient. Never paste keys or
seed phrases into commands or this service.

Only after granting spending authority for that run:

```sh
npm run check:page -- --url https://example.com --run-id my-deployment-001 --output out/my-deployment-001 --network base --wallet cdp --recipient APPROVED_RECIPIENT --execute
```

Replace `APPROVED_RECIPIENT` with the independently approved address, and keep the same run ID,
target, budget and directory. Do not rerun with changed policy to bypass an uncertain payment.

## Retrieve an accepted job again without a wallet

```sh
npm run check:page -- --resume --output out/my-deployment-001
```

This uses the saved `first-check.json` reference and original checkpoint. It can poll or
retrieve only an already accepted job; no wallet connector is loaded and payment is forbidden.
Original purchase reports stay in the run directory; refreshed output goes into `resumed/`.
The checkpoint retains the same run/job binding and may update its terminal result.
An uncertain `payment-attempted` checkpoint stops for reconciliation instead of paying again.
For a legacy run without a reference, add `--manifest` with its original generated basename.
Keep all files; use a new run ID only for a new deployment. See
[GROWTH-ACTIVATION.md](GROWTH-ACTIVATION.md) for recovery details.

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

## Reproduce a useful failure and fix without paying

Run `npm run demo:buyer -- out/demo` with Playwright Chromium installed. This checks a deliberately
broken fictional release, then its fixed version, with real browser captures and locally verified
Base SDK signatures. The gateway and payment acceptance are simulated; there are no production
calls or on-chain payments. It also proves preview and checkpoint resume do not sign again.
The saved evidence is in `samples/release-demo/`; it is explicitly synthetic, not customer usage.
