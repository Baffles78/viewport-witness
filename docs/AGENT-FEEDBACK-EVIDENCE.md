# Agent feedback — local delivery evidence

Prepared 2026-11-22 on `codex/agent-feedback`, based on `c50075f`.
Owner/writer: Codex; standard/medium implementation scope. Local source preparation only.
No branch publication, public issue, deployment, spending or production-data mutation.

## Delivered

- Free HTTP `GET/POST /v1/feedback`, discovered through the root service card,
  OpenAPI, `/llms.txt` and `/skill.md`. The existing GitHub feedback path remains available.
- Product, purchase blocker, short requested capability, stated purchase intent and optional
  price suggestion. `not_stated` avoids inventing purchase intent. No job or payer required.
- Strict schema, 2KB body limit, short feature labels, key/domain/phrase guards, deduplicated
  retries and configurable daily, storage and retention bounds. Storage errors return 503,
  never a false saved receipt. No public submission listing or raw-body logging.
- Private, read-only `feedback-summary` CLI: product/blocker/intent groups plus capabilities
  and suggested price ranges across the entire retained 30-day reporting window. Test mode
  is distinct from production. No feedback is described as verified demand or a sale.
- Privacy and runbook instructions, including 90-day feedback retention, backup caveat and
  the limitation that anonymous global quotas can be exhausted by an abusive client.

## Checks

- TypeScript typecheck and production build: passed.
- ESLint, file-size limits and `git diff --check`: passed.
- Full unit/integration suite: 47 files, 569 tests passed, including 11 feedback tests.
- HTTP checks run locally through the full app, including payment-free production-mode
  feedback, malformed/oversized requests, rejection guards, quota, duplicate handling,
  failed storage, private discovery and persistence/read-only access.
- Built owner-summary CLI smoke: passed against an isolated local test-mode SQLite record.
  No browser-worker behavior changed; a browser or paid production run was not needed.

## Independent source verification

The independent read-only `feedback_review` agent found and rechecked four corrections:
separated key-shaped input, bare domain/IP input, complete capability/price aggregation,
and privacy/retention documentation. Its focused rerun passed all 11 tests, with no remaining
concrete findings in that scope. A subsequent small addition permits `not_stated` purchase
intent; the full suite and build passed afterward. This is bounded source verification,
not exact-source independent release acceptance or proof of live behavior.

## Remaining release boundary

Public publication/deployment needs owner approval and the existing exact-source independent
review/release gate. The repository is public, so no branch or PR was pushed. Feedback is
available only in the prepared local source until that process is completed. No automatic
feedback solicitation, notifications, ticket creation or roadmap decisions are implemented.
