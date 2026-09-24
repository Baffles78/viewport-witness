# ViewportWitness working agreement

This repository is a standalone, machine-facing browser QA service.

## Product boundary

- Accept one public HTTPS URL and return a structured browser QA report.
- Test exactly three viewports: 375x812, 812x375, and 1440x900.
- Collect screenshots, accessibility findings, browser errors, failed requests, layout overflow, and safe non-mutating interaction checks.
- Keep the HTTP API primary. The root page may contain only concise service and documentation links.
- Price one complete report at $0.08 USDC when live x402 payments are enabled.

## Safety boundary

- Never accept or store seed phrases or private keys.
- The revenue address is a public destination, not a service-controlled wallet.
- Do not activate Base mainnet payments or deploy publicly without an exact-source independent review and the release gate recorded by the coordinator.
- Default to local or test mode. Test mode must not claim that payment settled.
- Only browse public HTTPS targets. Block loopback, private, link-local, metadata, local DNS results, embedded credentials, and unsafe redirects for the page and all subrequests.
- Browser workers must be bounded by time, memory, CPU, process, page, redirect, response-size, and storage limits.
- Do not click controls that can mutate data, submit forms, purchase, authenticate, upload, delete, or message. Interaction checks are focus/visibility checks only.
- Keep reports for seven days by default and enforce a storage ceiling.

## Delivery

- Use TypeScript with strict checking and committed dependency lockfile.
- Keep API and worker separable even if they run together locally.
- Include unit, integration, security-boundary, and local end-to-end checks.
- Keep operations understandable to a non-technical owner: one setup guide, one runbook, and plain error messages.

