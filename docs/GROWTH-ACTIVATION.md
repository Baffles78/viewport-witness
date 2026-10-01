# Growth activation

## Usage

### Growth summary (anonymous, offline)

`growth-summary.ts` reads the local SQLite database and prints a JSON summary of observed demand signals. It is read-only and cannot connect to external services.

```sh
node dist/growth-summary.js /absolute/path/to/vw.db
```

Optional environment variables:

- `VW_CONTROLLED_JOB_IDS` — comma-separated job IDs to exclude (e.g. operator smoke tests).
- `VW_ESTIMATED_COST_PER_WORKER_SECOND_USDC` — operator-supplied rate for cost estimation. Omit if unknown; the field is `null` when absent.

### Checkpoint and reconciliation

The release check CLI saves a durable checkpoint before each payment attempt. If a run is interrupted after an adapter call but before a result is confirmed, the checkpoint remains in `payment-attempted` state. Re-running with the **same runId and manifest** will detect this and refuse to retry the payment — the operator must reconcile manually using the recorded job ID before proceeding.

A changed manifest (different pages, budget, or service URL) will not match the checkpoint hash and the run will fail closed. Always use a new `runId` for a structurally different release.

Use a **new runId for each fresh deployment** even when its page list is identical. Reuse the same runId and checkpoint only to resume that existing check; doing so returns its existing evidence, not a new browser visit. Restore the same checkpoint when resuming a CI run, and retain the checkpoint artifact if execution was interrupted. CI spending requires an explicitly supplied customer-owned adapter; a secret containing a path does not create that module.

Execution acquires an exclusive `<state path>.lock`. Another process cannot use that checkpoint concurrently. An unclean shutdown may leave the lock behind: confirm the owner process has stopped and reconcile any `payment-attempted` state before manually removing only that lock. Never delete or reset the checkpoint to retry an uncertain payment. Checkpoint writes are awaited and synced before calling the customer adapter. The CLI test mode accepts only a loopback test service.

### Release-check client

From this checkout, run `npm ci` and `npm run build`. Replace the example pages and runId, then preview without paying:

```sh
node scripts/release-check.mjs --manifest examples/release-check.json --output out/
```

Paid execution is opt-in and requires your own payment adapter module:

```sh
node scripts/release-check.mjs --manifest examples/release-check.json --state out/checkpoint.json --output out/ --execute --adapter ./customer-adapter.mjs
```

The adapter exports a default async function accepting `{url, request, challenge, approvedRequirement, maximumAtomic}` and returning a normal HTTP Response. It is trusted customer code: honor the supplied exact requirement and maximum, preserve the idempotency key, and refuse redirects or additional payments. This project supplies no signer or funded wallet. Do not paste keys into manifests, command lines, checkpoints or reports. The workflow example runs in a checkout containing this client and package.json; it is not a standalone published action. Keep the normal seven-day evidence expiry in mind before sharing links.

### Anonymous offline growth summary

The summary contains no customer labels, payment identifiers, or target URLs. It aggregates by product, source label, and mode only. All source labels are caller-declared or protocol-level values — they are not verified acquisition attribution.

## 30-day daily aggregates vs seven-day jobs

Document and challenge event counts retain **30 UTC day buckets including today** in `growth_daily`, pruned on tracked requests and hourly cleanup while running. Job records are retained for **seven days** by default (governed by the service retention policy). The summary covers only retained jobs; the daily aggregate window is longer.

## Unknown historical mode

Jobs created before the growth tables existed carry `mode = 'unknown'`. These are reported separately and are not counted as production demand. Do not interpret them as proven production revenue.

## Operator-smoke exclusions

Pass operator-known smoke or indexing job IDs in `VW_CONTROLLED_JOB_IDS` or via the `excludedJobIds` option before interpreting external demand signals. Excluded jobs are counted in `excludedControlledJobs` for transparency.

## Limitations

- Sources are caller-declared or protocol labels, not verified acquisition attribution.
- Document and challenge counts are requests, not unique visitors or a matched conversion funnel.
- Job metrics cover retained jobs only; default retention is seven days. Historical unknown mode is not proven production.
- Worker time excludes queue time and may omit interrupted attempts.
- Supplied cost rate is an estimate, not a measured expense.
- No customer labels, payment identifiers, or target URLs are returned.

## Preparation evidence

This revision adds an existing-tool release-check client, anonymous measurement and accurate use-case descriptions; it does not change prices or payment settlement. Local checks passed: 331 unit tests, typecheck, lint, build and diff check; ten existing local end-to-end tests passed with two external-browser cases explicitly skipped. A separate five-page CLI test used a local mock service and fake adapter to verify reservation-on-disk before the callback, Windows module loading, no repayment on resume and checkpoint locking. No real payment or new production release is claimed by these checks. Exact-source independent review and the release gate remain required.
