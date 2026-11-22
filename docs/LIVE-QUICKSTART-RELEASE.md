# Live first-purchase discovery release — 2026-11-22

Owner/writer: coordinating Codex agent. Scope: point live agents to the merged simpler
first-purchase quickstart. Baffles requested the live app update in this chat. Reasoning:
standard implementation; independent exact-source release review required before promotion.

Base: aa866e16443f1ad4666f7db4042589f1c0720aff. Observed live source before release:
50ee36f7d98dfb5aff3249326bb9817e7665fe08; running image:
sha256:e881b622daa0eee5b23b72debed709026176ee2fee605582eb59b4cb8edbaab5.

Root JSON gains a quickstart URL, mirrored in OpenAPI. Served llms.txt, skill.md and the
agent landing page explain the unpaid preview and simpler setup. MCP initialization
instructions link the same quickstart while preserving optional feedback instructions.
No payment, admission, SSRF, worker, price, dependency or deployment configuration changes.
The baseline-to-candidate delta also contains the already reviewed client-only setup work
and monitor-source labeling; existing operations units use their separate pinned checkout.

Local checks: 586 tests in 50 files; typecheck, lint, build, file-size and diff checks pass.
Integration checks cover the root URL, three served documents and MCP initialization.
CI must additionally pass its existing browser end-to-end and operations checks.

Release gate: record exact candidate acceptance independently on the PR, require green CI,
and deploy that identical reviewed commit (not an unreviewed merge revision). Record merge,
image and live postchecks as a coordinator receipt on the PR. No extra payment is needed.

Preflight: verify clean production checkout, unchanged protected-environment hash, no
queued/running/payment-pending jobs or settling admissions immediately before replacement.
Preserve the running image under a dated rollback tag. Current online backup receipt
2026-11-22T15:46:16Z confirms authenticated R2 readback and restored SQLite integrity.
Take another online SQLite backup before replacement. Build while the old app runs;
start an isolated local test-mode candidate without production credentials or volumes.
Check discovery there before updating only the viewport-witness Compose service.

Rollback: restore the old commit 50ee36f and retag the saved previous image as
viewport-witness-viewport-witness:latest, then run
`docker compose -f deploy/docker-compose.vps.yml up -d --no-build viewport-witness`.
Keep named volumes intact. Recheck origin/public health, readiness, discovery and unpaid 402.

Postchecks: bind container image to candidate source; compare protected environment hashes;
verify public root, llms.txt, skill.md, /agents and MCP initialize point to the accessible
quickstart. Confirm ready, five unpaid 402 routes, unchanged $0.08 standard quote, and
monitor/feedback timers still active. Label synthetic paid-route probes as monitor.

Learning: a correct repository guide is insufficient discovery when live root and MCP
initialization do not point to it. This release makes the shared guide visible there;
it does not establish increased conversion or funded CDP-provider compatibility.
