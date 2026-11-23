# Report clarity and client 0.3.1 release

Released on 2026-11-23 UTC (2026-11-22 local). This receipt records coordinator-observed
deployment and unpaid checks. Independent live acceptance verified the image/source,
egress controls, health/readiness, OpenAPI and unsigned requests.

- Runtime source: `3cfd37915f2771bf3a77e927cab58c3cc2fd33b1`.
- Runtime image SHA256: `01ed3379663d5728b92708f2fd497dabfb762e03da63e84c970fb13cfb1a2314`.
- Published [client-v0.3.1](https://github.com/Baffles78/viewport-witness/releases/tag/client-v0.3.1)
  source: `0bdc7a2b6bac57761b2aa6b20a4a55c0e1273d65`.
- Archive: `viewport-witness-client-0.3.1.tgz`; SHA256:
  `5e502469d35a3a39af35f26e204b4d2705e92b4da11c44e574a38072677a6bd4`.
- Exact-source independent acceptance preceded release. Runtime
  [CI 45113155537](https://github.com/Baffles78/viewport-witness/actions/runs/45113155537)
  and client [CI 45114475205](https://github.com/Baffles78/viewport-witness/actions/runs/45114475205)
  passed. Client clean-install smoke passed on actual Node.js 22.12.0.

The isolated test-mode rehearsal returned PASS across all three viewports. Its coverage
recorded three distinct violation rules, nine viewport-rule occurrences and three
incomplete rule checks. Incomplete checks require manual review and do not become
confirmed violations. PASS retains the existing blocking-severity policy.

After deployment, live health and readiness returned HTTP 200. OpenAPI exposed the
additive coverage schema, and all five paid routes returned HTTP 402 without payment.
Protected settings and environment were unchanged from the approved before/after
comparison; only the approved source/image changed. No funds, signing credentials or
paid reports were used in this release verification. These unpaid checks do not prove
live signing or settlement. Production retained fifteen jobs, zero active jobs and
zero unresolved settlements; the environment hash was unchanged. No new paid job or
production report was created: report-content proof came from the isolated image rehearsal.

An independent clean install from the published asset on actual Node.js 22.12.0 returned
`readyForPreview: true` for a public URL without credentials. A private URL returned
`TARGET_NOT_PUBLIC` with exit code 2, and `setup --help` passed without prompting.

The 2026-11-23T04:52:06.919363Z pre-release backup passed full readback, decryption and integrity
checks, including fifteen complete jobs. Preserved rollback source:
`44cad78aa9e8e26910beba7655fcc0dfd329c078`; image SHA256:
`afed62dfc35b778aa362c91a0f1c351de068f2cf800a401dfb99598aa43e0c97`;
local rollback tag: `viewport-witness:rollback-44cad78-clarity`.

Earlier client archives remain unchanged. This documentation update does not rebuild
or replace the published 0.3.1 archive.
