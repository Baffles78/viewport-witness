# Submission Notes — ViewportWitness Agent Plugin

## Test cases

### Positive (should succeed)

1. **Discovery via tools/list**
   - Connect MCP client to `https://qa.honeygate.app/mcp` using streamable-http transport
   - Call `tools/list`
   - Expected: four tools returned (`check_page`, `verify_page`, `compare_page`, `get_report`) with correct annotations

2. **Free get_report on unknown job**
   - Call `get_report` with `{ "jobId": "00000000-0000-0000-0000-000000000001" }`
   - Expected: `{ "isError": true, "content": [{ "text": "{\"error\":\"not_found\"}" }] }` — no payment required, returns immediately

3. **verify_page input schema validation — noHorizontalOverflow**
   - Call `verify_page` with `{ "url": "https://example.com", "assertions": [{ "type": "noHorizontalOverflow" }] }`
   - Expected: server validates the discriminated union correctly and returns a job (or 402 challenge if x402 not provided)

4. **verify_page input schema — selectorVisible with selector field**
   - Call `verify_page` with `{ "url": "https://example.com", "assertions": [{ "type": "selectorVisible", "selector": "h1" }] }`
   - Expected: valid input accepted; job queued or 402 challenge returned

5. **compare_page with valid UUID**
   - Call `compare_page` with `{ "url": "https://example.com", "baselineJobId": "550e8400-e29b-41d4-a716-446655440000" }`
   - Expected: error `baseline_or_url_unavailable` (since baseline doesn't exist), not a schema rejection

### Negative (should fail gracefully)

1. **verify_page with unknown assertion type**
   - Call `verify_page` with `{ "url": "https://example.com", "assertions": [{ "type": "unknownType" }] }`
   - Expected: tool rejects input at the schema level; discriminated union validation fails cleanly

2. **check_page with non-HTTPS URL**
   - Call `check_page` with `{ "url": "http://example.com" }` (non-HTTPS)
   - Expected: `{ "isError": true, "content": [{ "text": "{\"error\":\"invalid_url\",...}" }] }`

3. **get_report with invalid UUID**
   - Call `get_report` with `{ "jobId": "not-a-uuid" }`
   - Expected: schema validation rejects the input before handler is called

## Submission checklist

- [x] `plugin.json` uses schema `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
- [x] `mcp.json` uses schema `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` and a named `streamable-http` server
- [x] Endpoint URL is `https://qa.honeygate.app/mcp`
- [x] `description_for_model` accurately states that x402-aware client is required
- [x] Prices are correct: check $0.08, verify $0.10, compare $0.12 USDC
- [x] `get_report` is correctly listed as free
- [x] Privacy policy URL is `https://qa.honeygate.app/privacy`
- [x] Terms of service URL is `https://qa.honeygate.app/terms`
- [x] Support URL is the GitHub feedback issues URL
- [x] No claim that ChatGPT, Claude, Cursor, Codex, or VS Code can automatically pay
- [x] No invented company name, jurisdiction, address, or legal guarantees
- [x] `SKILL.md` is accurate and concise
- [x] Tool annotations verified: paid tools `readOnlyHint=false`, `get_report` `readOnlyHint=true`

## Release notes

### v0.2.0
- Added `verify_page` tool: 1–20 declarative assertions across all three viewports
- Added `compare_page` tool: visual pixel-diff and QA delta against a completed baseline
- Discriminated assertion schema: all six supported assertion types (`noHorizontalOverflow`, `noConsoleErrors`, `textVisible`, `titleIncludes`, `selectorExists`, `selectorVisible`) with precise per-type required fields
- Tool annotations: `readOnlyHint`, `destructiveHint`, `openWorldHint` set correctly on all tools
- Tool descriptions clarify x402-aware client is required; standard AI assistants cannot automatically pay
- Prepared MCP Registry metadata under verified namespace `io.github.baffles78/viewport-witness` (publication is a separate release step)
- Added `/privacy` and `/terms` public policy endpoints
