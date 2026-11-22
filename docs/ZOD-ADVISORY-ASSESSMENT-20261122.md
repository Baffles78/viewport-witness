# Zod advisory assessment — issue #60

Status: **open; assessed, not remediated**. Scope: GHSA-mrhx-c7xc-m3w5 /
CVE-2023-54404 in the application and packaged client. No package-manager command,
dependency change, override, dismissal or production action formed part of the
assessment. Source inventories match `ebedae5c24a2cd2103b4b51a99a440c354b9d904`
and are unchanged at batch base `eeeedc1bbc3d79acc18ec59912cce0411efe59c4`.

## Inventory

Each inventory resolves one production Zod 3.25.76 copy, with no recorded optional
or platform restriction. Root consumers include the application, CDP 1.56.0,
x402 core/evm/extensions/mcp 2.27.0, MCP SDK 1.32.2 and peer consumers. The client
uses Zod through CDP and x402 core/evm plus peers. Client origin/integrity point to
the npm registry. The root Zod lock entry lacks resolved origin/integrity, leaving
an inventory provenance gap; do not invent a verified artifact origin.

Raw checkout SHA-256 values, including local line endings:

| Inventory | SHA-256 |
| --- | --- |
| package.json | d0d8d0e5e32310e1466f3cac9904f53e0d840bde2a4b6302a93a2efaae597114 |
| package-lock.json | 007b94cc80485a81c9bf69858be590c559f6a49fd832023b900c741ef7166fba |
| client/package.json | 5d0ce4c453b8b055d107b3b4e13ed302c7f58f08447354dc55369d1f504aec00 |
| client/npm-shrinkwrap.json | af654c707493c5a8b98cad1ae2644a9b0b0d9fa4d6bb827fe6795fabc3cd697f |

## Exposure and limits

The advisory identifies versions below 4.6.6 as affected. The upstream patch
changes v4 array/set/map parsers to reject collections exceeding leading `.max()`,
`.length()` or `.size()` bounds before parsing their elements. Unbounded schemas
do not gain an automatic size limit. No verified v3 backport was found. The installed v3 array parser
records the upper-bound issue and still visits the elements, so `.max(20)` alone
does not prove early rejection or bounded parsing work.

The service's ordinary HTTP/MCP parser bounds inbound bodies to 10 KiB. The
feedback router has a preceding 2 KiB parser and no collection schema. These are
useful mitigations, not a declaration that every dependency path is unaffected.
SDK payment schemas include unbounded accepts collections/records. The facilitator
success-response code reads full response text before schema parsing; the inbound
Express bound does not establish an outbound-response bound. CDP policy collection
schemas exist, but their actual reachability from every service/client path was
not established. No exploit or exhaustive reachability proof is claimed.

## Compatible upgrade proposal

Official registry metadata observed on 2026-11-22:

- Zod 4.6.6 contains the advisory fix, published 2026-10-11T16:18:23.878Z.
- Aligned x402 2.32.0 core/evm/extensions/mcp require Zod ^4.6.6; express/svm align
  with that core series. This is a concrete parent-upgrade candidate.
- CDP 1.62.0 still requires Zod ^3.25.76. Updating application Zod and x402 alone
  therefore leaves a nested v3 copy and residual exposure.
- MCP SDK 1.32.2 accepts either ^3.25 or ^4.0. Direct application migration must
  still check Zod record and JSON-schema conversion API differences.

A lock refresh within existing ranges cannot reach the patch. A forced v4
override would violate SDK ranges and is not a compatibility fix. Proposed order:

1. Inventory every used parser/response path and resolve the root lock provenance
   gap; retain reproducible artifact hashes.
2. Prepare an isolated aligned x402/application-Zod migration and evaluate CDP's
   residual v3 paths. Treat it as partial remediation until all affected copies
   have a supported patch, replacement or verified backport.
3. Check publication age/cooldowns at implementation time. No cooldown was found
   in the searched repository rules; parent publication-age evidence remains to
   be checked before selecting an upgrade.
4. Independently review the exact migration patch. Run payment quote/header-size,
   admission, uncertain settlement, replay, MCP and packaged-client compatibility
   tests before any release proposal. Keep mainnet signing disabled in tests.

Do not close or dismiss #60 based on request-size limits or an upgrade that leaves
vulnerable copies. No remediation or security acceptance is implied by the hosted
exclusion feature branch.

## Primary sources

- [GitHub advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
- [Upstream parser patch](https://github.com/colinhacks/zod/commit/a0ebf97)
- [Zod v4 migration guide](https://zod.dev/v4/changelog)
- Official npm registry metadata for [Zod](https://registry.npmjs.org/zod),
  [x402 core](https://registry.npmjs.org/@x402%2fcore), and
  [CDP SDK](https://registry.npmjs.org/@coinbase%2fcdp-sdk).

Assessment performed by a read-only actor; coordinator recorded the evidence here.
This source review is not a scan of the running image and does not certify absence
of other dependency vulnerabilities.
