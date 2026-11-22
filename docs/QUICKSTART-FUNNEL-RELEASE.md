# Quickstart funnel release — 2026-11-22

Owner/writer: coordinating Codex. Scope from Baffles: track quickstart use through first
purchase, excluding monitors and controlled test payments. Reasoning: standard implementation;
independent exact-source acceptance required before the requested live instrumentation.
Base/observed live source: 57358c1b66b618462032bfca287d98d2369e6e86 (main merge de385580).

The live quickstart link becomes a fixed noncached redirect. A random client per-run ID,
persisted beside output and hashed server-side, links a real unpaid preview to authoritative
settled acceptance and report completion. The summary counts runs, not verified agents.
The first-observed payer measure uses bounded history and does not claim lifetime identity.
No payment permission, settlement, price, target validation, worker or deployment config changes.

Modules own attribution, bounded SQLite analytics, client ID storage and private operator
reporting. The existing growth-schema initialization and unchanged USDC parsing function were
extracted to keep already oversized files within their decreasing ceilings. Analytics hooks
are fail-open for purchases. New tables are additive and independent of report deletion.
The privacy policy and quickstart disclose retention, purpose, exclusions and client opt-out.

Checks: full tests plus targeted migration/settlement/capacity cases, TypeScript, lint, build,
size and whitespace checks. CI also runs existing browser E2E and the new three-case Python
operator-report test. Synthetic settlement uses local fixtures only; no further spending.

Release gate: require independent acceptance of the exact source and green CI. Preserve
the previous image/source and protected environment checksum. Verify no active or unresolved
jobs, take a verified online SQLite backup, and build while the current service stays online.
Run an isolated network-disabled test-mode smoke without production credentials/volumes.
Deploy the identical accepted commit. Update the separate operations checkout to that same
commit only after checking existing monitor/feedback scripts are unchanged.

Rollback: restore source 57358c1, retag its preserved image as
viewport-witness-viewport-witness:latest, and run the existing Compose up command with
--no-build for this service. Keep named volumes and additive analytics tables intact.
Restore the operations checkout's previous source if its report command needs rollback.

Postchecks: root/docs/MCP quickstart entry, fixed redirect, publicly accessible guide, ready,
five monitor-labeled unpaid 402 probes and unchanged $0.08 Base terms. Run the private report
with the existing controlled ledger; verify it loads the known test exclusion and does not
count our monitor/test-client previews. No fabricated production purchase is inserted.
Record exact image, source, cutover, raw baseline metrics and release outcome on the PR.

Learning: use the same anonymous run denominator for matched conversion, preserve exclusions
after seven-day cleanup, and distinguish observed first purchases from unknowable lifetime
history. No statistical or causal conversion improvement is claimed.
