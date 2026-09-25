# Privacy Policy

This policy describes how the ViewportWitness service handles data submitted to it.

## Data we process

**Submitted URLs.** When you submit a URL for a browser QA check, that URL is stored with the job record for the duration of the report retention period.

**Screenshots and reports.** Browser screenshots, accessibility findings, console error excerpts (with URLs redacted), and the structured QA report are stored on the server's local data volume and associated with your job ID. They are accessible to anyone who has the job ID.

**Pseudonymous payment identifiers.** In paid modes (testnet, production), the service derives a one-way pseudonymous customer identifier from the payer wallet address using a server-side HMAC secret. The raw wallet address is not stored. The derived identifier is used only to associate repeat-use measurements within the same service instance; changing the HMAC secret starts a new series and never relinks old jobs. To prevent duplicate job creation from the same payment, the REST API stores a SHA-256 fingerprint of the received payment header. MCP requests instead store a SHA-256 fingerprint of canonical payment fields such as the network, payment scheme, and signed authorization or transaction identity. The service does not store the raw payment header in either flow.

**Payment and billing data.** Payment verification and settlement are handled by the Coinbase CDP facilitator on behalf of the x402 protocol. We do not receive, store, or process private keys, seed phrases, or full payment credentials. The service operator does not operate a payment processor.

**Browser request data.** During a check, the service opens the submitted URL in a headless browser. Response bodies, cookies, and authorisation headers from the checked page are not stored. Console error text is truncated and URL-redacted before storage.

**Network and operational data.** Cloudflare, the hosting provider, and the service process may temporarily process ordinary request metadata such as IP address, user agent, route, response status, and timing for delivery, abuse prevention, and troubleshooting. The application log does not intentionally record payment headers, wallet addresses, submitted page contents, or screenshots.

## What we do not collect

- Private keys or seed phrases
- Browser cookies or session tokens from the checked page
- Full response bodies from the checked page
- Names, email addresses, or other personal identifiers

## Retention

Job records, screenshots, and reports are retained on the active service volume for seven days by default, then deleted. A configurable storage ceiling triggers oldest-first cleanup before the seven-day period if disk space is exhausted. Infrastructure backups or provider snapshots may retain encrypted or access-controlled copies for their own backup lifecycle; they are not available through the service API.

## Service providers and data chains

The live service at qa.honeygate.app uses Cloudflare for public network delivery and an infrastructure hosting provider for compute and storage. Payment verification uses the Coinbase CDP facilitator API and the selected public blockchain. Screenshots and reports are stored on the service's local filesystem; they are not uploaded to external object storage by the application.

## User controls

- You may retrieve your report at any time during the retention period using your job ID.
- There is no account system. Job IDs are unguessable UUIDs; treat them as access tokens.
- After the active retention period, the job is deleted from the live service and can no longer be retrieved through its API. Backup copies follow the infrastructure provider's separate lifecycle.
- Self-hosted instances may configure a shorter retention period or a smaller storage ceiling.

## Contact

For questions or concerns, use the feedback link at the `/` endpoint or the GitHub issues page linked in the service card.
