# QA evidence improvements — 2026-11-22

Owner/coordinator: Aria/Codex. Reasoning profile: standard/medium. Baffles approved
planning and beginning the full set on 2026-11-22. Development stays local; this
approval does not publish, deploy, spend, or alter security/payment policy.

Product tracker: https://github.com/Baffles78/viewport-witness/issues/70

The first local implementation of items 1–4 is complete. Usage and limitations:
[QA evidence](QA-EVIDENCE.md). Hosted visual exclusions remain a follow-up; the
offline utility is the first implemented version.

## Plan and acceptance

1. Repair verification: extend existing baseline comparisons with per-viewport,
   per-check/rule outcomes: fixed, still broken, newly broken, could not verify.
   Use raw measured evidence, not capped diagnosis text. Missing checks never
   establish a fix. Rule-level results must not claim stable DOM-node identity.
2. Annotated evidence: retain original screenshots and hashes; produce separate
   PNGs with numbered rectangles and a JSON legend. Bound selectors, nodes, time
   and output. Report unavailable/offscreen evidence without activating controls.
3. Visual exclusions: first deliver a local, offline PNG comparison utility with
   explicit integer rectangles, at most 20 rectangles and 20% excluded area.
   Count overlap once, retain originals, show raw and filtered differences, and
   use included pixels as the filtered denominator. This does not change API
   pricing, paid request bodies, idempotency, assertions or security checks.
   Hosted request options remain a later reviewed integration through the entire
   HTTP/MCP/admission/storage/replay chain; do not silently drop options.
4. Performance: reuse current navigation/paint/request/byte evidence, extract its
   module, add ten largest observable resources and explicit coverage limits.
   Origin-only identifiers protect paths, queries and fragments. No speed score,
   Lighthouse equivalence or field Core Web Vitals certification is claimed.
5. Access: reproduce issue #31 using unpaid discovery GETs and unsigned POSTs;
   change no edge security configuration without evidence and its reserved gate.
6. Demand: read the existing owner summary with controlled-job exclusions;
   distinguish tracked setup conversion from all external customer revenue.

Completion evidence: strict typecheck, lint, full unit/integration/security suite,
size guard, local browser end-to-end checks, and independent review of an exact
commit. No mainnet purchase or public deployment is a test prerequisite.

## Coordination

The bounded planning pass challenged architecture and user-impact assumptions.
Aria owns integration, offline exclusions, documentation and operations readback.
The repair writer owns repair-verification.ts/comparison.ts and their tests.
The browser-evidence writer owns browser.ts, performance.ts, annotations.ts and
their tests. Each file has one writer; reviewers do not implement acceptance.
No Sarah/OpenClaw route is used; that role is retired.

The referenced C:/projects/apex-labs/docs/OPERATING-AGREEMENT.md is absent on this
machine. Current supplied AGENTS.md, CLAUDE.md and the available shared contract
retain the product GitHub Issues source and release/security boundaries.

## Current readbacks

2026-11-22 21:15 UTC: Chrome, Python-urllib/3.12 and libwww-perl/6.68 user agents
all received 200 for /openapi.json, /llms.txt and /.well-known/x402 and 402 for an
unsigned POST /v1/checks. HTTP redirects with 308. The reported #31 behavior was
not reproduced from this host. These requests did not sign or settle a payment.

The owner-only demand summary was checked with controlled-job exclusions. The
matched funnel is too young and sparse to establish conversion or historical
revenue; detailed counts stay in local owner evidence. Older clients, disabled
telemetry and direct GitHub visits are unobserved. Missing coverage must not be
presented as zero customers or zero revenue.

## Learning and review

Applied current shared lesson sources lesson-preserve-shared-work and
lesson-independent-test-evidence (updated 2026-10-05): clean working tree checked;
tests must include independently specified negative cases. Their dated historical
evidence does not certify this build. Planning identified that global rule-ID
unions hide viewport migrations; repair outcomes must preserve viewport identity.
Independent acceptance and deployment remain pending until recorded below.

Local validation: baseline 596 tests passed before changes. With the additions,
629 unit/integration tests, 32 browser end-to-end tests and the offline CLI test
pass. Two existing optional external-network browser tests were skipped. Strict
TypeScript, ESLint, build and file-size checks pass. A numbered phone screenshot
was generated and visually inspected under artifacts/qa-evidence-review; this is
local fixture evidence, not a production page or deployment result. The archive
regression test confirms no source job annotation URLs survive archive capture.

Learning observation: derivatives inherit job retention, so copying their links
into longer-lived archives would create stale links and retain source job IDs.
Archive capture now deliberately strips the optional derivative metadata.

Additional live discovery check: the public service/registry documents respond,
but Coinbase Bazaar search did not surface verify, compare or security-gate in
the checker’s selected searches. Checks/extract were found. This is an external
index-coverage observation, not a new-code test failure or proof of buyer demand.
