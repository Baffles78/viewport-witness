# ViewportWitness — Agent Skill

Base URL: https://qa.honeygate.app
MCP endpoint: https://qa.honeygate.app/mcp (streamable-http)

## What it does

Submit a public HTTPS URL. Receive a structured browser QA report and PNG screenshots across three viewports:
- Phone portrait: 375×812
- Phone landscape: 812×375
- Desktop: 1440×900

Per-viewport results include: load status, screenshots, axe-core accessibility violations, console errors (redacted), failed network requests (redacted), horizontal overflow detection, and keyboard/focus observations.

## Tools

| Tool | Cost | Notes |
|------|------|-------|
| `check_page` | $0.08 USDC | Full QA report |
| `verify_page` | $0.10 USDC | 1–20 declarative assertions |
| `compare_page` | $0.12 USDC | Visual + QA diff vs baseline |
| `get_report` | Free | Poll for status and results |

**Paid tools require an x402-aware client.** Standard AI assistants (ChatGPT, Claude, Cursor, Codex, VS Code) cannot automatically sign x402 payments.

## Payment

- Protocol: x402 (pay before job is enqueued)
- Networks: Base mainnet (eip155:8453) for production; Solana when advertised
- Discovery: GET https://qa.honeygate.app/.well-known/x402

## check_page

```
Tool: check_page
Input: { "url": "https://example.com" }
Returns: { "id": "UUID", "status": "queued", "pollUrl": "/v1/checks/UUID", "paymentMode": "production" }
```

## verify_page

```
Tool: verify_page
Input: {
  "url": "https://example.com",
  "assertions": [
    { "type": "noHorizontalOverflow" },
    { "type": "textVisible", "value": "Welcome" },
    { "type": "selectorVisible", "selector": "h1" }
  ]
}
```

Assertion types: `noHorizontalOverflow`, `noConsoleErrors`, `textVisible` (value), `titleIncludes` (value), `selectorExists` (selector), `selectorVisible` (selector).

## compare_page

```
Tool: compare_page
Input: { "url": "https://example.com", "baselineJobId": "UUID-of-completed-check" }
```

## get_report (polling)

```
Tool: get_report
Input: { "jobId": "UUID" }
```

Poll every 5–10 seconds until `status` is `"complete"`, `"failed"`, or `"retryable"`. Typical check time: 15–90 seconds.

## Limits

- Reports expire after 7 days
- Max URL length: 2048 characters
- Max 50 console errors / failed requests per viewport (paths redacted)
- One paid job per settled payment

## References

- OpenAPI spec: https://qa.honeygate.app/openapi.json
- Agent guide: https://qa.honeygate.app/llms.txt
- Payment discovery: https://qa.honeygate.app/.well-known/x402
- Privacy: https://qa.honeygate.app/privacy
- Terms: https://qa.honeygate.app/terms
- Feedback: https://github.com/Baffles78/viewport-witness/issues/new?template=customer-feedback.yml
