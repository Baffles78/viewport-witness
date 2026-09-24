# ViewportWitness by Apex Labs — Agent Skill Guide

Base URL: https://qa.honeygate.app

## What this service does

Submit a public HTTPS URL; receive a structured browser QA report and screenshots across three
viewports: phone portrait (375×812), phone landscape (812×375), and desktop (1440×900).

Checks per viewport: load status, screenshots, accessibility violations (axe-core), console
errors, failed network requests, layout overflow, and keyboard/focus observations.

## Payment

- Cost: 0.08 USDC per report
- Network: Base mainnet (eip155:8453) for production; Base Sepolia (eip155:84532) for testnet
- Protocol: x402 upfront — send a valid PAYMENT-SIGNATURE header before the job is created
- Payment discovery: GET https://qa.honeygate.app/.well-known/x402

## Create a check

```
POST https://qa.honeygate.app/v1/checks
Content-Type: application/json
PAYMENT-SIGNATURE: <x402-payment>

{
  "url": "https://example.com"
}
```

Strict schema: only `url` (a public HTTPS string) is accepted; extra fields are rejected (422).
Non-HTTPS, loopback, private, and link-local addresses are blocked (400).

Response (202 Accepted):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "pollUrl": "/v1/checks/550e8400-e29b-41d4-a716-446655440000",
  "paymentMode": "testnet"
}
```

`paymentMode` is `"testnet"` or `"production"` for paid requests.

## x402 flow

1. Send POST with payment header — the middleware verifies and settles the payment before
   enqueuing browser work (upfront flow).
2. On success: 202 with job object.
3. On missing/invalid payment: 402 with PAYMENT-REQUIRED header containing requirements.

See GET https://qa.honeygate.app/.well-known/x402 for price, network, and payTo address.

## Polling

```
GET https://qa.honeygate.app/v1/checks/<id>
```

Poll until `status` is `complete`, `failed`, or `retryable`. Typical check time: 15–90 seconds.
Recommended interval: 5–10 seconds.

While running:

```json
{ "id": "...", "status": "queued|running", "createdAt": "...", "pollUrl": "/v1/checks/..." }
```

When complete, the full QAReport is returned. The top-level `status` field becomes
`"PASS"` | `"FAIL"` | `"INCONCLUSIVE"`.

## Screenshots

```
GET https://qa.honeygate.app/v1/checks/<id>/screenshots/phonePortrait
GET https://qa.honeygate.app/v1/checks/<id>/screenshots/phoneLandscape
GET https://qa.honeygate.app/v1/checks/<id>/screenshots/desktop
```

Returns `image/png`. Available once the check is `complete`.

Three representative screenshots from a report on https://example.com are available by
completing a check and fetching the URLs above — no pre-generated static examples exist.

## Limits

- Report retention: 7 days
- Max URL length: 2048 characters
- Max 50 console errors and 50 failed requests per viewport (paths redacted)
- One paid job per settled payment (payment identity bound to job)
- Idempotency-Key header (max 128 chars) prevents duplicate jobs on retries

## Idempotency

```
POST https://qa.honeygate.app/v1/checks
Idempotency-Key: my-unique-key-123
```

Same key returns the same job ID if the job already exists.

## Safety

- Read-only browser checks: no form submission, authentication, purchase, or data mutation
- Service never stores private keys or seed phrases
- Public revenue address: 0xe5fa9502bd9f32a0fc90f2c809296b4835c2c400

## References

- OpenAPI spec: https://qa.honeygate.app/openapi.json
- Payment discovery: https://qa.honeygate.app/.well-known/x402
- Full usage guide: https://qa.honeygate.app/llms.txt
- Skill manifest: https://qa.honeygate.app/skill.md
- Customer feedback: https://github.com/Baffles78/viewport-witness/issues/new?template=customer-feedback.yml

Do not include private target URLs, wallet details, payment signatures, API keys, or other
secrets in public feedback.
