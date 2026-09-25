# ViewportWitness agent-discovery evidence

Status: release candidate prepared; private OpenAI draft created; no registry update, directory submission, deployment, or payment performed.

Date: 2026-09-25

## Confirmed live

- The official MCP Registry returns one active latest entry for `io.github.Baffles78/viewport-witness`, published on 2026-09-25 as version 0.2.0.
- `/.well-known/x402`, `/.well-known/mcp.json`, `/openapi.json`, `/skill.md`, and `/llms.txt` respond successfully.
- An unsigned `POST /v1/checks` returns HTTP 402 with an absolute public resource URL, service name, five topical tags, and a Bazaar input/output declaration.
- The live payment discovery document advertises browser QA, assertions, comparison, Markdown extraction, passive release security, and MCP access.
- Coinbase Bazaar returns `/v1/checks` and `/v1/verify` for the exact product name and for the generic query `browser QA screenshots accessibility`.
- Bazaar reports one call and one unique payer for each indexed route. This is discovery evidence, not proof of organic demand.

## Material discovery gap

Coinbase Bazaar does not yet return the remaining paid routes for their intended queries:

- `/v1/compare` for `visual regression website`
- `/v1/extract` for `DOM to Markdown webpage extraction`
- `/v1/security-gate` for `passive web release security`

This is partial coverage: agents can already find and buy the core browser-QA and assertion services, but not the newer comparison, extraction, or passive-security services through the principal x402 search surface.

The official x402 Bazaar flow catalogs a declaration only after a client echoes it in a payment payload and the facilitator validates it. Existing catalog records show that this happened for checks and assertions. A fresh conforming paid call for each missing route is therefore a likely indexing trigger, not a guaranteed fix. Do not count controlled indexing calls as customer demand or revenue proof.

## Prepared release change

Version 0.2.1 expands the official MCP Registry description around common agent intents: website testing, screenshots, accessibility, visual comparison, Markdown extraction, and release security. It also brings the plugin listing up to the current six-tool inventory.

The release candidate also adds agent-search optimization based on current live directory evidence:

- Every MCP input field now has a useful description instead of an empty parameter description.
- `check_page` and `verify_page` explicitly tell an agent when to select the other tool.
- Each x402 HTTP product advertises route-specific Bazaar tags, including `visual-regression`, `web-to-markdown`, and `website-security` rather than reusing generic browser-QA tags for every route.
- `/agents` provides an indexable intent-to-tool guide with SoftwareApplication structured data.
- `/robots.txt` permits discovery and points to a new `/sitemap.xml` covering the agent landing page and machine-readable contracts.
- `/llms.txt` starts with a compact tool-selection map.

Glama already reports the remote MCP server healthy, ownership verified, and all six tools visible. Its current quality report scores the connector A overall (3.7/5.0) and specifically identifies empty parameter descriptions plus mild ambiguity between `check_page` and `verify_page`; this release directly addresses those two findings without adding speculative tools.

Verification for the candidate: TypeScript, lint, production build, and 274 unit/integration tests passed. The read-only discovery audit passed every core live check and confirmed that Bazaar still lacks the three newer paid routes.

`npm run check:discovery` performs a read-only audit of:

1. public machine-readable documents;
2. the official MCP Registry entry;
3. the live HTTP 402 Bazaar declaration; and
4. Coinbase Bazaar coverage for five intended buyer queries and all five HTTP products.

Use `npm run check:discovery -- --require-bazaar` when Bazaar presence is a release requirement.

## External-action gates

1. Publishing MCP Registry version 0.2.1 is a public metadata change and requires the normal release approval and exact-source verification.
2. A fresh production x402 indexing call spends real USDC and requires action-time confirmation. Use a bounded x402-aware client, never expose a private key, and record the transaction and delivered result separately from organic demand metrics.
3. After the call, allow for asynchronous cataloging and rerun the discovery audit. If absent, use the facilitator validation/rejection evidence before opening a support request.
4. A private OpenAI **With MCP** draft now exists, and the publishing organization is verified. Nothing has been submitted for review or published.
5. OpenAI's current plugin guidelines prohibit selling digital products or services through a plugin. The current per-call x402 purchase flow therefore cannot be submitted unchanged. A compliant OpenAI access path must either be durable and free or let users sign in to an existing paid account and use features already included there, without initiating or promoting checkout in the plugin.
6. Domain verification, live tool scanning, reviewer access, the demo recording, and the final submission remain gated behind that access-model decision.
