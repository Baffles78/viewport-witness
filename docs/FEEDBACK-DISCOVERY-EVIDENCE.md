# Purchase-blocker feedback invitations

Prepared 2026-11-22 on `codex/purchase-blocker-feedback-guidance`, based on `04f3916`.
Owner/writer: Codex, standard/medium. This note records the prepared candidate, not a live release.

Agents previously had to find the free feedback endpoint in service documentation.
This candidate adds a short optional invitation where application-level purchase blockers
are returned: JSON API 4xx/5xx responses, MCP initialization, all five paid MCP tool
descriptions, and locally shaped MCP tool errors. OpenAPI and the two agent guides explain
price, payment setup, missing capabilities and service errors as reasons to leave feedback.

Original error/status/recovery fields and payment headers are preserved. Feedback is
caller-authorized, free and optional; it does not retry work, authorize or settle payments,
or resolve uncertainty. Successful/pending job results, JSON-RPC envelopes and feedback's
own endpoint errors are not decorated. Existing feedback guidance is preserved if present.
No feedback is submitted automatically, and invitations do not create jobs or notifications.

Validation: 575 tests in 48 files pass, including real dual-rail x402 402 challenges on all
five paid HTTP routes within the existing 3,700-byte header budget; six discovery tests
cover error/status/header/recovery preservation, app failures, MCP instructions/tool listing,
blocked MCP work and unchanged successful results. TypeScript, ESLint, build, size and
diff checks pass. No payment, SSRF, dependency, storage or notification-scheduler changes.

Invitations can be ignored by agents. CDN/firewall failures that never reach the application
cannot carry application guidance, and SDK-generated MCP payment errors remain unmodified;
MCP initialization and tool descriptions provide the invitation before those errors.
There is no new MCP submission tool; feedback submission remains the existing HTTP API.

Public deployment requires independent exact-source acceptance and the owner's release gate.
