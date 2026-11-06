# Paid admission and recovery proposal

Status: design note for draft PR #48. Do not enable a new payment flow from this document alone.

## What the current flow proves

The service pins x402 packages at 2.27.0 and sets `extra.paymentFlow: 'upfront'` in
`src/payment/index.ts`. The [x402 v2 flow specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
defines upfront as **settle → resource → respond** and says facilitator `/verify`
is omitted. The [lifecycle hooks](https://docs.x402.org/advanced-concepts/lifecycle-hooks)
offer `onBeforeSettle`, but that is before the facilitator call, not proof that
the payment is valid. `onSettleFailure` runs after the facilitator was reached;
a failed response or HTTP 402 alone is not proof that nothing settled.
Coinbase's [settlement-pending guidance](https://docs.cdp.coinbase.com/x402/seller/settlement-pending)
says a submitted transaction may confirm later and must be reconciled. Its
[troubleshooting guide](https://docs.cdp.coinbase.com/x402/support/troubleshooting)
says retrying the same authorization cannot charge twice because its nonce is
single use, but the resulting rejection does not distinguish an earlier
settlement from an invalid original payload.

The current PR rejects malformed envelopes and caps unresolved reservations.
A plausible invalid signature still consumes a reservation. The synthetic
`tests/idempotency-replay-boundary.test.ts` demonstrates capacity exhaustion
and denial of a subsequent keyed purchase. The cap bounds rows, not access.

## Safe path before merge

1. Keep the PR draft until the residual denial risk has an accepted operational
   policy. Apply ingress rate limits and per-origin abuse controls at the edge,
   with separate limits for signed paid attempts. Those controls reduce but
   cannot eliminate distributed unauthenticated abuse. Do not depend on
   client-supplied `Idempotency-Key` as identity.
2. Treat only failures known to occur before the facilitator can be called as
   definitely unpaid. The app's malformed-envelope rejection meets this rule.
   Do not free a reservation on a generic 402, 503, socket close, timeout, or
   `success:false` without payment-stage evidence.
3. Set an operator alert on unresolved admission count and a hard fail-closed
   threshold. Reconcile entries; never silently expire uncertain claims merely
   to regain capacity.

A separate read-only facilitator `/verify` call could filter some invalid payloads
before admission, but the configured upfront flow does not call it. Such a
change must use the exact route's negotiated requirements, preserve the
provider's response codes, and be tested against both EVM and Solana rails.
Verification is time-sensitive and does not prove later settlement will
succeed; it cannot replace a durable pre-settle attempt or resolve a crash
after settle. Do not insert an ad hoc verify call into the current wrapper
without a reviewed contract and mocked facilitator tests.

## Durable recovery design

Create a transactionally inserted `payment_attempts` record before calling
settle, containing an immutable job ID, canonical request intent, idempotency
key hash, payment-payload fingerprint, payment rail, creation time, and state.
Store enough protected payment evidence (or a provider-issued durable
reference) to reconcile the exact authorization; a hash and timestamp alone
cannot do this. Encrypt sensitive payload material at rest, restrict retention
and operator access, and test backup/restore. This requires a privacy and key
management review.

State transitions should be `reserved` → `settling` → `settled` →
`queued`/terminal. Persist the settlement receipt and transaction identifier
before returning success. A crash or timeout in `settling` remains
`outcome_unknown`; recovery checks the exact transaction/authorization and
facilitator records. If a settlement is confirmed, enqueue the original
durable job ID exactly once. If independently proven unpaid, mark the attempt
rejected and permit a new authorization. Otherwise stop and escalate.
No recovery path asks the buyer for a new payment while the old one may settle.

The [payment-identifier extension](https://docs.x402.org/extensions/payment-identifier)
may help bind retries to the same payment, but its cache must be durable and
request-bound; the extension alone does not replace local attempt state or
external settlement reconciliation.

## Offline acceptance cases for that design

- Invalid envelope and proven pre-facilitator rejection create no unresolved
  attempt.
- Concurrent same-key requests across routes/processes create one attempt and
  one call to settle.
- Disconnect or timeout after facilitator dispatch leaves the same attempt
  unknown, never a second settlement for that key.
- Crash after confirmed settlement but before job enqueue recovers the original
  job ID from durable intent and receipt.
- Recovery with a pending or ambiguous transaction stops, preserving evidence.
- Capacity pressure refuses new settlement before any payment call and alerts
  operators; a simulated distributed invalid-payment load documents remaining
  denial behavior.
