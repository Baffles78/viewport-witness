# Claude implementation brief

Follow `AGENTS.md` and `docs/BUILD-SPEC.md` exactly. You are the sole implementation writer for the bounded build. Work only in this repository. Do not deploy, spend money, create accounts, generate wallets, handle secrets, or enable mainnet payments. Finish with tests, a concise evidence note, and a commit on the current feature branch.

## Agent skills

### Issue tracker

GitHub Issues for this repo (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The default five: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, created when needed. See `docs/agents/domain.md`.
