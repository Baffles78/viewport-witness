# QA evidence release — 2026-11-22

Owner/coordinator: Aria/Codex. Baffles approved proceeding after the prepared PR
#71 handoff. Independent source and operational-readiness review accepted exact
source `e35f2555d554b4432ee58a689877a743e17bd26a`. PR #71 merged as
`6d7bbafcd09d9e699462a204ede7d1d4687e6ecb`; production runs the reviewed source,
not the generated merge revision.

Deployed at 21:36:56 UTC to qa.honeygate.app. Runtime image:
`sha256:150414b970677618dc8c718c758c92709f263a592fd11895a3d45fa590541029`.
Prior source `8375d87ca3209df506823b34fe3cd2c800028e33` and its image remain
preserved under `viewport-witness:rollback-20261122-8375d87-qa-evidence`.
Rollback follows the existing runbook: restore that source/image and run Compose
up with `--no-build` for this service. Keep data volumes intact.

## Before replacement

- Green GitHub CI, 629 local unit/integration tests, 32 browser tests, offline CLI
  proof and clean client-package smoke. Two optional external-network tests skipped.
- Fresh encrypted backup at 21:31:35 UTC: full remote readback, authenticated
  decryption and restored SQLite integrity passed. A separate final online SQLite
  backup also passed integrity with zero active/unresolved jobs.
- Exact candidate image ran isolated in test mode without production credentials,
  volumes or published ports. Check and comparison jobs completed across all three
  viewports, each with annotations and seven observable resources. Original PNG
  hashes, derivative retrieval, repair-result schema and private-target rejection
  passed. QA FAIL verdicts describe findings on the target page, not failed jobs.
- A scoped temporary ingress fence was proven with a failed host probe and packet
  counter, existing upstream sockets drained, and a full barrier held through the
  final admission readback and replacement. Failure/signal cleanup was independently
  reviewed. Only the app service was replaced; shared services stayed running.

## After replacement

Public health/readiness and discovery returned 200. OpenAPI exposes annotations,
repair verification and resource details. All five unsigned paid routes returned
402; the standard quote remains 0.08 USDC on the existing Base/Solana rails.
Protected environment checksum stayed unchanged. Container is healthy; all
existing backup/watch/feedback/purchase/pilot timers remain active. Both temporary
fence rules were removed. The isolated candidate was removed after preserving its
test evidence. No new production job, synthetic settlement or real payment was made.

A separate independent actor confirmed the exact deployed source/image, unchanged
environment checksum, removed fence and public readiness/OpenAPI. Positive browser
feature execution was verified in the isolated candidate using the identical image.
No paid production report was purchased, so paid end-to-end execution after this
cutover is not claimed. No operations notification units or edge configuration changed.

Visual exclusions remain an offline utility. Hosted exclusions and external
discovery-index coverage remain follow-up work in issue #70. Detailed private
demand counts stay in owner-only evidence.

Learning: derivative links must not outlive their job retention in archives. At
release time, fencing only new TCP connections is insufficient if upstream
keepalive sockets survive; drain them and hold a full barrier before final
payment/job readback. Neither lesson changes payment authorization.
