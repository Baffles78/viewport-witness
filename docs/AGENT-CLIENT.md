# Ready client for AI callers

The release client uses the existing Base and Solana x402 rails. It checks one to five public HTTPS pages, persists a checkpoint before signing, polls the original jobs, and emits JSON plus Markdown. Existing customer wallet connectors supply signing capabilities; the service never receives a private key or seed phrase.

Build once with `npm ci` and `npm run build`. Put the customer's existing connector in a local module that exports `signer`. Base signers expose `address` and `signTypedData`; Solana signers expose `address` and signing-only `signTransactions` (partial transaction signing, never sending). For Solana an optional HTTPS `rpcUrl` may be exported without embedded credentials or query secrets. No wallet creation or key import is required by this client.

Approve the public recipient separately from an unsigned quote. Do not automatically authorize a destination merely because the endpoint advertised it. Configure a manifest:

```json
{
  "runId": "deployment-unique-id",
  "pages": ["https://example.com"],
  "maxBudgetUsdc": "0.08",
  "allowedNetwork": "eip155:8453",
  "allowedPayTo": "<customer-approved Base recipient>"
}
```

For Solana use `allowedNetwork: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, its approved `allowedPayTo`, and `allowedFeePayer` for the approved facilitator fee payer. Obtain current public values from an unsigned `POST /v1/checks` challenge, then verify and approve them through the customer's policy. The adapter rejects changed recipients, assets, networks, amounts and fee payers before signing. Base supports native USDC EIP-3009; this integration does not grant token approvals.

Preview first; the wallet module is not loaded:

```sh
node scripts/release-check.mjs --manifest release.json --output out/
```

When the customer has granted that run's spending authority:

```sh
node scripts/release-check.mjs --manifest release.json --state out/checkpoint.json --output out/ --execute --wallet-module ./existing-customer-wallet.mjs
```

The wallet module is trusted customer code. Keep it outside the repository and retain the checkpoint and its lock. On interruption, resume the same manifest and checkpoint. A checkpoint marked `payment-attempted` requires reconciliation; the client does not automatically sign or repay. Do not delete a checkpoint or assign a new run ID to evade that stop.

Programmatic callers can compose `createX402PaymentAdapter` from `dist/x402-adapter.js` with `runReleaseCheck` from `dist/release-check.js`. Persist the runner's checkpoint before any signature and enforce exclusive ownership of that checkpoint. The adapter's in-memory budget is an additional guard, not durable state across restarts. Standard MCP hosts still need an x402-capable wallet runtime; installing a tool alone does not authorize spending.

Use [AGENT-WORKFLOW.md](AGENT-WORKFLOW.md) to select products, interpret actionable results, save a seven-day baseline and plan a bounded fix/recheck. No agent-result field grants authority to edit or deploy the customer's website.

## Supplied connector for an existing CDP Base account

The repository includes `examples/wallets/existing-cdp-base.mjs`. Configure these in your local
secret manager or environment, never in a committed file or command-line arguments:

- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET`
- `CDP_WALLET_SECRET`
- `VW_PAYER_ADDRESS`: your existing account's public address

The helper looks up that exact existing account. It does not create or fund an account, grant
token approvals, or send transfers directly. Only explicit `--execute` loads it. Its provider
lookup is covered by isolated tests; a funded real-account payment has not been validated in
this buyer-readiness pass. If you use another wallet provider, use its existing signing connector.
For Solana, the customer still supplies a signing-only connector and approves the facilitator
fee payer; the supplied CDP helper is Base-only.

```sh
npm run check:page -- --url https://your-public-deployment.example --run-id release-123 --output out/release-123
```

After separately approving the recipient and spending budget, repeat the same arguments with
`--execute --network base --recipient <approved-address> --wallet-module ./examples/wallets/existing-cdp-base.mjs`.
Keep the generated manifest and checkpoint together. A changed target or payment policy must
use a new output directory and a genuinely new deployment ID, never bypass an uncertain payment.
