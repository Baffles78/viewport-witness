# Terms of Service

By using this service you agree to the following terms.

## What this service does

ViewportWitness provides paid automated browser QA. You submit a public HTTPS URL; the service visits it in a headless browser across three viewport sizes and returns screenshots, accessibility findings, layout analysis, and a structured report.

## Authorisation

By submitting a URL you confirm that you are authorised to have it accessed by an automated browser on the public internet. Do not submit URLs that you do not control or that belong to services that prohibit automated access. The service is intended for public HTTPS targets.

## Non-mutating behaviour

All browser checks are strictly read-only. The service does not click buttons that submit forms, authenticate, purchase, upload, delete, or send messages. Interaction checks are limited to focus and visibility observations. Screenshots are taken after a passive page load.

## Report expiry

Reports are retained on the active service for seven days. After that period the job record, screenshots, and report are deleted from the live service; infrastructure backups may follow a separate limited lifecycle. Do not rely on this service as a permanent archive.

## Paid use

Standard checks cost $0.08 USDC, assertion checks cost $0.10 USDC, and comparison checks cost $0.12 USDC on the live service. Payment is made in advance via the x402 protocol before browser work is started. Once a payment is verified and settled by the x402 facilitator, it is not refunded regardless of whether the check completes successfully.

**Crypto payment finality.** Payments are on-chain. Blockchain transactions are irreversible once confirmed. The service does not process refunds for settled payments.

## No warranty

The service is provided as-is. We do not guarantee uptime, response time, accuracy of accessibility findings, correctness of screenshots, or completeness of any report. Browser checks are best-effort across the three configured viewports at the time of the request. Results may differ from manual browser testing.

## Prohibited use

You must not:
- Submit URLs for services you are not authorised to access or test
- Use the service to probe internal networks, loopback addresses, or cloud metadata endpoints (these are blocked, but attempts are still prohibited)
- Attempt to use the service as an attack vector against the target URL or its hosting provider
- Deliberately exhaust the service's storage, CPU, or network resources
- Circumvent payment requirements

## Changes

These terms may change. The current version is always at `/terms` on the service endpoint.
