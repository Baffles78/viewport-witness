# Paid admission and recovery

Status: implemented on branch `claude/project-thread-8u7ipa`, superseding the
design-only draft in PR #48. Test-mode verified offline against the real x402
2.27.0 packages with a scripted facilitator. Not yet verified with a funded
payment on either rail.

## Contracts this relies on (x402 2.27.0, @coinbase/cdp-sdk 1.56.0)

- HTTP paid routes advertise `extra.paymentFlow: 'upfront'`. x402 then settles
  before the handler and skips facilitator `/verify`.
- MCP paid tools use the default authorization flow: x402 calls `/verify`, runs
  the tool, then settles.
- Resource-server hooks (`onBeforeVerify`, `onAfterVerify`, `onBeforeSettle`,
  `onAfterSettle`, `onSettleFailure`) can abort by returning
  `{ abort: true, reason }`. A hook that throws is only logged and x402
  continues, so every hook here catches its own errors and returns an abort.

## What happens to a paid request

1. Unsigned request: unchanged 402 challenge (Base and Solana requirements).
2. Signed request whose payment fingerprint already has a job: the same job is
   returned if the request is the same work; different work gets 409 with no
   job id. Nothing is settled again.
3. Same payment arriving concurrently in one process waits for the first
   request, then gets the same answer. Across processes the database unique
   constraint on the payment fingerprint and idempotency key does the same.
4. If unresolved payments are at `PAYMENT_UNRESOLVED_LIMIT` (default 20), the
   request gets 503 `payment_admission_paused` before any facilitator call.
5. HTTP: the app calls facilitator `/verify` itself in `onBeforeVerify` with
   the route's negotiated requirements. Invalid payments and verify outages
   stop here. Nothing is stored and no key is bound.
6. `onBeforeSettle` writes the job row (`payment_pending`, settlement state
   `settling`) and the idempotency key in one `BEGIN IMMEDIATE` transaction,
   before settle is called. Capacity, a reused key or a reused payment abort
   the settle, and the response says nothing was charged.
7. Settle succeeds: the same row moves to `queued` with the transaction hash in
   one update. The handler enqueues that exact job id. If enqueue fails or the
   process crashes first, the 60-second queue sweep picks the job up from the
   database.
8. Settle throws, times out, returns `success:false`, or the client disconnects
   after settle was dispatched: the row becomes `unknown`. The buyer gets 202
   with `paymentOutcome: "unresolved"`, `nextAction: "poll_same_job"` and the
   text "Do not send another payment for this request". The key stays bound,
   the row never expires automatically, and repeating the request with the
   same payment returns the same job.
9. On startup any row still `settling` (the process died mid-settle) becomes
   `unknown`.

Only payments the facilitator has verified create a row, so invalid
signatures cannot poison keys or fill capacity.

## Operator reconciliation

An `unknown` row is resolved only by an operator with authoritative evidence:

```bash
docker exec viewport-witness node dist/payment-reconcile-cli.js list
docker exec viewport-witness node dist/payment-reconcile-cli.js settled <jobId> --tx <hash> --network <caip2>
docker exec viewport-witness node dist/payment-reconcile-cli.js unpaid <jobId> --evidence "<proof>"
```

- `settled` queues the original job exactly once (repeat calls are refused).
- `unpaid` fails the job and releases its key. Use it only with proof that the
  payment can no longer settle, for example an EVM transfer authorization that
  is still unused after its `validBefore` time, or a Solana transaction whose
  blockhash has expired with no matching signature. A timeout, a generic error
  or a missing lookup is not proof.
- A settled job can never be marked unpaid.

## Known limitations

- No payment payload or signature is stored, by design (no sensitive-payload
  storage was approved). The row keeps a fingerprint, the network, the time,
  the hashed customer id and any facilitator error text. Matching an `unknown`
  row to a chain transaction is therefore manual: look for a transfer of the
  exact price to the revenue address on that network near `createdAt`.
- Every settle failure is treated as unknown, including ones that probably did
  not settle. This is conservative and needs operator time if failures are
  frequent. The limit (default 20) stops new paid admissions rather than
  letting unknowns grow without bound.
- The app-side `/verify` call on upfront-flow HTTP payloads has not been run
  against the live CDP facilitator. Testnet or funded acceptance must confirm
  it before relying on it in production.
- A funded attacker could pass verify and then drain the wallet before settle,
  leaving an `unknown` row that binds one key. The capacity limit bounds this.
- The in-process wait is per process. The database constraints cover multiple
  processes, but a second process gets 409/replay instead of waiting.
- `POST /v1/history` still uses the previous payment wrapper. The route is
  disabled in production.
