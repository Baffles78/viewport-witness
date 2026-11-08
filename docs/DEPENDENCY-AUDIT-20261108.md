# Dependency audit — 2026-11-08

Base: `d9026dd` (production). Lockfile-only refresh plus one direct range bump. No source,
price, payment-rail, or safety-boundary changes. x402 packages stay pinned at 2.27.0 and
`@coinbase/cdp-sdk` at 1.56.0.

## Fixed

| Package | Before | After | Path to production | Notes |
| --- | --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.30.1 | 1.32.2 | direct, serves `/mcp` | 5 advisories (OAuth client, tasks, validation memory, bearer audience, cross-origin redirects). Range bumped to `^1.32.2`. |
| @hono/node-server | 2.1.1 | 2.1.6 | via MCP SDK | `serveStatic` double-decode; service does not use `serveStatic`. |
| hono | 4.13.9 | 4.13.17 | via MCP SDK | same `serveStatic` issue. |
| body-parser | 1.20.8 / 2.3.0 | 1.20.9 / 2.4.0 | express 4 (API) and express 5 (MCP SDK) | compressed-body DoS; API parser is reachable. |
| fast-uri | 3.1.8 | 3.1.9 | ajv (MCP SDK, x402 extensions) | URI parsing advisories. |
| follow-redirects | 1.16.0 | 1.16.3 | axios in cdp-sdk (facilitator calls) | credential-header stripping. |
| ip-address | 10.7.2 | 10.7.6 | express-rate-limit (MCP SDK) | Address6 zone-id quadratic time. |
| qs | 6.16.0 | 6.16.2 | express | `stringify` comma-format DoS. |
| undici | 7.29.1 | 7.30.2 | cheerio | several client-side advisories. |
| vitest / @vitest/mocker | 5.0.x | 5.1.0 | dev only | mock registration injection. |

## Remaining (accepted, not fixable without breaking pins)

- **zod <4.6.6** (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained
  collections). The only fix is zod 4. `@x402/core@2.27.0` requires `zod ^3.24.2` and
  `@coinbase/cdp-sdk@1.56.0` requires `^3.25.76`, so moving to zod 4 means changing the pinned
  payment stack. Exposure is bounded: the HTTP API caps JSON bodies at 10 KB
  (`src/api/index.ts`) and every array schema has a small `.max()`. Revisit when x402 ships a
  zod 4 release. The `@x402/*`, `abitype`, and `cdp-sdk` audit lines are this same zod entry.
- **minimatch 10.x** under `@typescript-eslint/typescript-estree` — dev-only lint tooling,
  never shipped or run on untrusted input. `npm audit` suggests a downgrade to v6, which is not
  a fix.

## Counts

| | Before | After |
| --- | --- | --- |
| `npm audit` | 28 (13 moderate, 15 high) | 15 (6 moderate, 9 high) — all zod or minimatch chains |
| `npm audit --omit=dev` | 18 (5 moderate, 13 high) | 9 high — all the zod chain |

## Checks (clean `npm ci`, Node 22.23)

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test` — 38 files, 549 tests pass (includes `paid-admission-recovery`,
  `payment-header-size`, and `mcp-discovery` which drives `/mcp` `tools/list` and `tools/call`)
- `node --test scripts/registry-publish-guard.test.mjs` — pass
- `npm run test:e2e` — 28 pass, 2 skipped (external, gated by `ALLOW_EXTERNAL_E2E`)
- `npm run build` — pass

Not deployed. Release follows `docs/RUNBOOK.md` and needs the owner's typed approval of the
exact commit.
