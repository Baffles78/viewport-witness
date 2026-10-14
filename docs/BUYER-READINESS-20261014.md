# Buyer readiness: 14 October 2026

Status: prepared and locally tested; not deployed or accepted as a paid production workflow.

## What was broken

Real Python urllib POST requests from Windows and the VPS receive Cloudflare 403/error 1010 before payment. Public GET documentation works. Browser-style POST receives the expected 402. The same unsigned request reaches the origin and receives 402. This is an edge access barrier, not a missing wallet balance. Cloudflare configuration access is pending. The HTTP endpoint also redirects with 301; a prepared 308 configuration preserves POST methods, but it has not been applied.

The release client prematurely stopped polling because queued/running responses omit the target URL. The regression test failed before the fix and passes afterward; terminal results still require the expected target.

## Delivered locally

- One-page preview/execute launcher, immutable manifest and existing checkpoint protections.
- Existing CDP Base account connector, with no account creation or funding.
- Actionable report findings and visible warnings, quoted budget and clearer access errors.
- Reproducible synthetic broken/fixed demonstration with real Chromium screenshots.
- Two locally cryptographically verified Base SDK signatures; zero on-chain payments and zero production calls in that demonstration. Preview and resume do not sign again.
- Whitelisted static demonstration routes and runnable setup instructions.

Build and lint pass; 403 tests pass. The final isolated demonstration returns FAIL with eight blocking observations, then PASS with zero. Provider lookup is mocked; real funded CDP payments and a full Solana signed workflow remain unverified.

## Demand and economics

The fresh anonymous production summary at 2026-10-14T05:00:18Z contains four retained paid jobs, four completed jobs, two tracked identities and one repeat identity. Operator exclusions are not yet reconciled. These counts do not establish four customers or external adoption. The seven-day job retention differs from the 30-day anonymous request buckets; requests cannot be treated as visitors or conversions.

At advertised prices those retained jobs represent at most $0.14 nominal gross value: two extraction jobs, one security job and one browser check. This is not lifetime revenue, verified net settlement, or profit. Worker observations total about 5.38 seconds but omit queue time, idle capacity, interrupted attempts, storage, facilitator costs and support. No verified invoice allocation or measured cost rate is available; margin remains unknown.

Recommendation: retain the focused deployment-verification offer for a bounded demand test after access is repaired. Do not expand the product menu or buy traffic based on the existing counts. A useful proof is available; repeat external paid use and acquisition attribution are still missing. Outreach and spending require separate authorization.

## Open acceptance gates

1. Inspect and repair the narrowly scoped Cloudflare rule; repeat real Python requests from Windows and VPS.
2. Validate deployed exact source, static evidence, unchanged payment policy and method-preserving redirect.
3. Reconcile controlled usage and obtain actual cost inputs.
4. Obtain an authorized customer-owned funded-wallet workflow receipt before claiming paid production acceptance.

## Task record

User intervention: scope approval; credential location requested, answer pending. Elapsed user time is unknown. Correction: a Node request with an imitated Python user agent was insufficient; actual urllib reproduced the failure. No subscription-limit interruption observed. No other agent used. No spending, prospect messages, credential revocation or retired automation restoration.
