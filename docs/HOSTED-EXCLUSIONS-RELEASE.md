# Hosted visual exclusions release — 2026-11-22

Baffles approved proceeding after PR #74's reviewed, green-CI handoff. Independent
release-readiness review accepted exact source
`c0ebd88c51d702f122fd9fd4eadf6bd48f5f5ae6`, including the full delta from prior
deployed source `e35f2555d554b4432ee58a689877a743e17bd26a`.
PR #74 merged as `4692107703d8ea24f6c825d20fbcd7de6ffa47c9`; production uses the
reviewed source rather than the generated merge revision.

Deployed at 23:32:07 UTC to qa.honeygate.app. Image:
`sha256:45ed70d61db21109974e4ea6e7f7009a8bb276dad14f4813490090341a997988`.
Prior source/image are retained under
`viewport-witness:rollback-20261122-e35f255-hosted-exclusions`. Rollback restores
that pinned source/image and Compose up with `--no-build` for only this service;
retain named data volumes and the existing protected environment.

## Execution evidence

- Green exact-source CI; 656 unit/integration, 32 browser and six Node script
  checks plus typecheck/lint/build/size and packaged-client smoke. Existing two
  optional external-network browser tests skipped.
- Fresh encrypted backup at 23:28:32 UTC passed full remote readback,
  authenticated decryption and restored SQLite integrity. A separate final online
  backup passed integrity with zero active/unresolved jobs before replacement.
- Exact candidate image ran isolated, bounded, test mode, without production
  credentials/data, a public port or payments. A check and HTTP/MCP comparisons
  completed across all three viewports. Verified canonical stored exclusions,
  compatible replay, changed-intent 409, excessive-coverage 422, raw screenshot
  hashes, raw/filtered counts, included-pixel denominator and blue-mask PNGs.
  Private targets remained blocked. QA FAIL verdicts described detected page
  findings; job execution completed.
- Proven scoped ingress fence, upstream socket drain and full app barrier held
  through final job/settlement readback and replacement. EXIT/signal cleanup and
  rollback pins were independently reviewed. The app container alone was replaced.
- Public health, readiness, OpenAPI and MCP tool discovery expose the feature.
  All five unpaid product calls return 402; standard price remains 0.08 USDC and
  comparison price 0.12. Challenge headers stay within the existing proxy budget.
- Independent live readback confirmed exact source/image, healthy public
  readiness, new schemas, unchanged protected-environment checksum and removed
  fence. Existing backup/watch/feedback/purchase/pilot timers remain active.
  No new ViewportWitness error was recorded in the immediate postcheck window.
  The isolated candidate was removed after retaining test evidence.

## Verification limits

No paid production comparison, synthetic settlement or customer contact occurred.
Positive feature execution was verified in isolated test mode on the identical
deployed image; unpaid public checks do not prove a paid end-to-end purchase.
No dependency, signing, payment-mode, scheme, price, SSRF or operations-unit change
was included. The separate dependency migration remains a prepared patch and the
advisory remains open. Real customer validation still needs a participant, target
and spending authority.

Learning: region options are paid work intent and must survive admission/recovery;
ranked-search misses do not prove catalog absence. Partial dependency mitigation
must not be presented as closing every affected copy or as a deployed fix.
