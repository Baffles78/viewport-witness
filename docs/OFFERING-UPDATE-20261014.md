# Offering update: prepared and locally tested

Approved scope: deployed-page positioning, complete tool enumeration, simpler setup instructions,
and a durable sample report with three real screenshots. Base: `a72a34a0f7196486c29477776b897d695ae6a2d2`.

## Delivered behavior

- `/agents` leads with checking a deployed public website before sign-off and links to the sample.
- `/samples/example/` serves a saved local test report, provenance and links to three screenshots.
  It uses no scripts, styles or embedded images, so the existing restrictive site CSP can remain intact.
- `/skill.md` enumerates all six tools. `docs/QUICKSTART.md` connects the sample, unpaid budget
  preview and customer-authorized execution using the existing client.
- The generator checks only Example Domain in an isolated test database. The copied sample files
  do not depend on job retention. JSON screenshot links point to the durable copies.
- Prices, payment handling, production settings and tool names are unchanged.

## Validation

- Build, TypeScript, lint, JavaScript syntax and Git whitespace checks passed.
- 395 unit/integration tests passed. New route checks validate test provenance, real PNG dimensions
  and refusal to expose unrelated files or the database.
- The actual browser worker and local API generated all three screenshots and a report on
  `https://example.com`: PASS, zero blocking issues, nine non-blocking accessibility observations.
  These observations remain visible. No wallet or payment was used.
- The existing release-check client produced an unpaid preview without invoking a payment adapter.
- Browser QA covered landing-to-sample navigation, phone and desktop layouts, no phone horizontal
  overflow, report links, and opening the 375×812 screenshot under a local copy of the existing CSP.
  The sample HTML had no console errors. Chrome's standalone PNG viewer logged blocked internal
  styling under that CSP, but loaded and displayed the image at its actual dimensions.
- Codex performed a direct standards/spec self-review. No other agent or independent reviewer was used.

## Local reproduction

Run `npm ci`, `npm run build`, then `node scripts/generate-example-sample.mjs` from a development
checkout with Chromium installed. If Node DNS points at a unavailable local resolver, use the
process-only `VW_SAMPLE_DNS_SERVERS` override documented in the quickstart. Do not disable SSRF checks.

The first dependency download was stopped after excessive latency; an offline cached install
completed. The local Node resolver pointed at unavailable `127.0.0.1`; a process-only override to
the working network resolver allowed the normal target policy to run. Windows and production DNS
were not changed. Temporary test databases remain as recovery copies.

## Release and rollback

This revision is prepared and locally tested, not deployed or owner-accepted. Public sample and
new GitHub-main documentation links become available only after merging and deployment. A production
container build was not run in this session; the Dockerfile explicitly includes the sample directory.
Deployment, exact-revision postchecks and owner acceptance remain separate steps.

For source rollback, revert this update's commit rather than resetting unrelated work. For a deployed
rollback, use the existing preserved image and service rollback procedure in `deploy/vps/README.md`;
retain production data, settings, credentials and backups. No rollback is needed in production now.

## Task record

Outcome: approved implementation completed and tested. Owner intervention during implementation:
none. Subscription usage-limit interruptions: none observed; remaining allowance unavailable.
Other-agent rescue/delegation: none. Corrections: an expected trailing slash in the new test was
corrected to the actual report URL; a Windows import path was changed to a file URL; screenshot
presentation was adjusted to honor the existing CSP. One shell edit was rejected by automatic
approval review with only "blocked by policy"; the same edits were completed using the file patch
tool. No approval controls were changed and no user retry was needed.
