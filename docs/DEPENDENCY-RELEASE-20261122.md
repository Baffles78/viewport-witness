# Dependency release and client 0.2.0 — 2026-11-22

Baffles approved deployment and publication in chat. The coordinator recorded the exact-source
[release gate on PR #76](https://github.com/Baffles78/viewport-witness/pull/76#issuecomment-7089825447)
before promotion. A fresh nonimplementing reviewer accepted the source and exact client archive.

## Released inputs

- Deployed source: `44cad78aa9e8e26910beba7655fcc0dfd329c078`.
- Running image: `sha256:afed62dfc35b778aa362c91a0f1c351de068f2cf800a401dfb99598aa43e0c97`.
- PR #76 merge receipt: `34fde040a520de7b3323561fb542bb76de4ee278`.
  Production uses the approved candidate SHA above; the merge adds no runtime changes.
- [Published pilot client 0.2.0](https://github.com/Baffles78/viewport-witness/releases/tag/client-v0.2.0)
  targets the exact approved source, with `viewport-witness-client-0.2.0.tgz` and `SHA256SUMS`.
- Client SHA-256: `ee0e98ae75ebbf717b999a5c73e7ad330f3f7f9044fc60208f0ff35399ffb0e5`.
- Client requires Node.js 22.12.0 or newer; service requires Node.js 22.13.0 or newer.

The Coinbase SDK is removed from both locked distributions. All resolved Zod versions are 4.6.7,
and root/client production audits report zero known vulnerabilities. Narrow local adapters retain
official x402 facilitator transport and existing-account lookup/typed-data signing. They add no
account creation, funding, key export or transaction-submission capabilities. Request signing
binds the exact endpoint and canonical body; customer REST calls have streamed byte/time limits.

## Verification

- [Final-source CI passed](https://github.com/Baffles78/viewport-witness/actions/runs/45098803158).
  Writer checks passed 677 tests, 32 browser checks, 18 script tests, typecheck, lint, build and size
  checks. Two opt-in external browser checks were skipped. Actual minimum Node versions were tested.
- The fresh reviewer independently passed 677 tests, typecheck, lint, size checks and compilation,
  inspected all changed callers, and verified the archive against source/independent compilation.
  A stale-base release-document regression was corrected before final acceptance.
- Exact image passed isolated test-mode HTTP/MCP/browser rehearsal at all three viewports,
  including comparison storage/pixels, replay/conflict and private-target refusal. The target's
  own QA findings were report content; all jobs loaded and completed successfully.
- Coinbase accepted the replacement authentication helper on read-only GET supported (29 kinds).
- After deployment, an independent reviewer confirmed exact running image/source, healthy container,
  public health/readiness 200, ready database/worker, all five product 402 responses with expected
  Base/Solana prices, OpenAPI/x402/MCP/skill discovery and all six MCP tools.
- Publicly downloaded archive and checksum file match the accepted bytes. Public-URL clean npm
  execution, CLI help and live unsigned preview passed on Windows Node 22.12.0 and Linux Node 22.23.3.
  Recovery of an existing accepted report passed on Windows without another payment.

No funded payment was signed or settled during this release. Funded customer CDP acceptance remains
unverified. The build's development dependency audit reported six moderate advisories; the production
audits were zero. This release closes the affected dependency path, not every possible resource risk.

## Recovery and retained state

A fresh encrypted off-host backup completed at 2026-11-23 02:17:39 UTC (November 22 local time),
with full readback, authenticated decryption and restored SQLite integrity. All 14 existing jobs were
complete and settled before restart. Protected configuration checksum was unchanged after deployment.
Service and browser-egress units remain active; existing backup/watch/feedback/purchase/pilot timers
are retained. No database schema, payment setting or retention policy changed.

Rollback source: `c0ebd88c51d702f122fd9fd4eadf6bd48f5f5ae6`.
Rollback image: `sha256:45ed70d61db21109974e4ea6e7f7009a8bb276dad14f4813490090341a997988`,
retained as `viewport-witness:rollback-c0ebd88`. Restore that source/image using the runbook and
restart only ViewportWitness, then repeat health, quote and error checks.

Client-v0.1.0 and its bytes are preserved. Client-v0.2.0 remains a pilot prerelease and does not replace
the repository's existing service latest-release label. Never overwrite either archive; corrections
require a new version. The archive's README was frozen at the reviewed source before publication;
current commands and release status are in the release notes and updated repository quickstart.
