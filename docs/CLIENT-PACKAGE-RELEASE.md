# Ready-to-run client release and five-builder pilot — 2026-11-22

Owner/writer: coordinating Codex. Baffles requested the ready-to-run client and five-builder
pilot, with outreach drafts reviewed before sending. Source base: 892daecd951dd073c6d2c0409339d70b51e06264.
Reasoning profile: standard implementation; independent exact-source release acceptance.

The release is `client-v0.1.0`, a GitHub prerelease asset named
`viewport-witness-client-0.1.0.tgz`, runnable by pinned URL through npx. npm registry publishing
is not authenticated; this distribution needs no npm account or new credentials. It calls
the existing service and needs Node.js 22/npm, but no checkout, build or browser installation.
Do not replace the service's existing latest release label or redeploy the application.

**Later release (not part of the v0.1.0 history below):**
The dependency update is deployed and client-v0.2.0 is published, requiring Node.js 22.12.0
or newer. See [its release evidence](DEPENDENCY-RELEASE-20261122.md). Client-v0.1.0 remains
unchanged; its original dependency findings below describe that older archive.

The package contains selected compiled client modules, the existing CLI scripts, CDP connector,
one bin entrypoint and client README. It excludes source/server/worker, browser dependencies,
private artifacts, sample outputs and credentials. A committed npm-generated shrinkwrap pins
104 runtime packages; no install/build scripts in the client manifest. Root server dependencies,
payment policy, signer contracts, settlement and retention behavior are unchanged.
The only existing CLI change exports its main function for the bin wrapper, preserving direct use.

Build with `npm run build:client`; smoke with `npm run test:client-package`. The latter installs
the tarball via npm exec into a clean directory/cache, verifies CLI help and connector module
imports, then runs a synthetic unsigned preview through the installed bin with no wallet,
checkpoint or permitted payment. It checks package contents and server dependency exclusions.
The existing 596 tests, typecheck and lint pass. CI also runs browser E2E and package smoke.
Published-asset checks must additionally use the actual public tarball URL and verify SHA256.

Known dependency advisory: issue #60 tracks GHSA-mrhx-c7xc-m3w5 in the existing Zod 3.25.76
dependency graph. Client audit reports six affected package entries propagated from that one
advisory. It is not a clean audit. No automatic/forced dependency update was made: changing
payment SDK major versions needs a separately reviewed compatibility patch. The reviewer must
assess the distribution delta against the bounded existing client: fixed service origin,
64KB challenge bound in the signing adapter, bounded reports, one-to-five pages, explicit
network/recipient/budget approval, and no signing library/connector on preview. Do not claim
this release fixes or proves all dependency paths unaffected. Record acceptance and limits.

Release gate: commit source, build final archive, record hash/file inventory, independently
review that source and artifact, require green CI, then publish the archive and SHA256SUMS
under the exact reviewed source tag. Keep a source/artifact receipt on the PR. Release notes
must identify client-only pilot status and the existing advisory. Smoke Windows and Linux
entrypoints, live unpaid preview with test-client attribution and accepted-job recovery using
the existing controlled report, without any new signing/payment. Keep proof artifacts private.
If publication fails, leave it prepared and report the concrete blocker; never claim live.

Recovery: stop advertising a failed asset and mark the release withdrawn; never overwrite a
published version with changed bytes. A fix needs a new version and review. Revert quickstart
package instructions to the repository fallback if necessary. Existing service remains online.

The pilot packet and five tailored outreach drafts are private local artifacts, deliberately
excluded from Git and the package. Public source evidence identifies prospects only; no funded
wallet, willingness, compatibility, enrollment or conversion is inferred. Four priority prospects
plus one browser-tooling stretch prospect are proposed. Nothing is sent before Baffles reviews
the recipient, channel and exact draft. No incentives, wallet funding or paid promotion.
The 14-day clock starts with the first approved send; anonymous aggregate funnel counts stay
separate from named prospect self-reports. No task is handed to an agent by unsolicited message.

Learning: package the existing guarded client rather than introducing a second payment flow.
A working package does not prove demand; the pilot must expose actual setup blockers and
useful report evidence, with repeat use after a distinct deployment as a later signal.
