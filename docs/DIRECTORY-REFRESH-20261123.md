# Prepared MCP Registry metadata refresh

Prepared only; no registry workflow dispatched or directory publication performed by
this change. Registry metadata version `0.2.2` is separate from service version `0.2.1`
and published downloadable client `0.3.1`. Those application/package versions remain
unchanged, as do the namespace, repository identity, endpoint, title, icons and website.

The approved 112-character summary exceeds the official schema's 100-character limit.
The fitted 99-character summary is:

> Browser QA: screenshots, accessibility and layout findings; free diagnostics, explicit paid checks.

This is a short capability summary, not the complete six-tool inventory. Free diagnostics
are client doctor checks; paid browser QA still requires explicit payment approval.
No new MCP tool, payment permission, certification or adoption claim is introduced.

Primary-source readback on November 23, 2026:

- [Registry query](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Baffles78%2Fviewport-witness)
  returned exactly versions `0.2.0` and `0.2.1` for this namespace; `0.2.1` had
  `isLatest: true`. `0.2.2` was unused at preparation time, not reserved.
- The pinned [official schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
  permits descriptions of 1–100 characters. Retrieved schema SHA256:
  `3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0`.
- The existing publish guard checks exact selected main source, unchanged committed
  manifest and successful push CI. It does not require root package-version equality.
  The existing publisher validates the manifest before GitHub OIDC publication.

After exact-source review and green CI, the coordinator owns publication using the
existing guarded workflow and readback of the published version/description. A source
commit alone is not proof that the directory has changed. Recheck version availability
before dispatch if another publisher could have used it in the meantime.

The existing external [gold-402 entry](https://github.com/Haustorium12/gold-402/blob/main/directory/apis.md)
was located by its `ViewportWitness` link to `https://qa.honeygate.app/v1/checks`.
It still links `docs/GROWTH-ACTIVATION.md` as its release-check client guide. The
coordinator handles that existing-entry edit separately; this patch does not modify
the external repository, submit a PR, alter Glama, or make paid service calls.
