# Claude implementation brief

Follow `AGENTS.md` and `docs/BUILD-SPEC.md` exactly. You are the sole implementation writer for the bounded build. Work only in this repository. Do not deploy, spend money, create accounts, generate wallets, handle secrets, or enable mainnet payments. Finish with tests, a concise evidence note, and a commit on the current feature branch.

## Agent skills

### Issue tracker

GitHub Issues for this repo (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The default five: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, created when needed. See `docs/agents/domain.md`.

## Keeping the code organized

These rules apply to every agent and person working here. `AGENTS.md` points here.

### One job per file

- Each file does one thing and is named for what it does (`src/worker/layout.ts`, `src/payment/identity.ts`).
- A new feature gets its own file. Large entry files (`src/server.ts`, `src/api/index.ts`, `src/mcp.ts`, `src/openapi.ts`, `src/db.ts`, `src/worker/runner.ts`) only get a short hook that imports and calls it.

### Where each kind of code goes

| Kind of code | Location |
| --- | --- |
| Process start-up and wiring | `src/server.ts` (keep it thin) |
| HTTP app setup and middleware order | `src/api/index.ts` |
| HTTP routes, one router per product area | `src/api/routes/<area>.ts` |
| MCP tools | `src/mcp.ts` (server, paid-tool payment wrapper: risky); shared schemas in `src/mcp/tool-schemas.ts`; new tools go in `src/mcp/<tool>.ts` (like `get-report.ts`) and are registered from `src/mcp.ts` |
| OpenAPI document | Sections in `src/openapi/` (`paths-*.ts`, `schemas-*.ts`), assembled in `src/openapi.ts` |
| x402 payments, admission, payer identity | `src/payment/` and `src/x402-adapter.ts` (risky: ask first) |
| URL safety and SSRF blocking | `src/ssrf.ts` (risky: ask first) |
| Saving and loading data (SQLite) | `src/db.ts` now; new tables or queries go in `src/db/<area>.ts` |
| Browser worker (Playwright, viewports, checks) | `src/worker/`: `runner.ts` (queue and jobs), `browser.ts` (one viewport), one file per check (`accessibility.ts`, `page-assertions.ts`, `layout.ts`, `interaction.ts`), `verdict.ts`, `comparison.ts` |
| Lightweight HTML products | `src/web-products.ts` (bounded, SSRF-pinned fetch: risky), `src/web-extract.ts`, `src/web-security-gate.ts`, `src/web-analysis-runner.ts` + `src/web-parser-worker.ts` |
| Report shaping for agents | `src/agent-result.ts`, `src/report-guidance.ts`, `src/recheck.ts` |
| Settings read from the environment | `src/config.ts` only; every threshold and price stays configurable via `.env` |
| Shared types | `src/types.ts` |
| Unit and integration tests | `tests/<feature>.test.ts`, named after the file or feature they cover |
| Browser end-to-end tests | `tests/*.e2e.ts` and `tests/e2e.test.ts` |
| Developer and release scripts | `scripts/*.mjs`, with tests as `scripts/*.test.mjs` |
| Backups and server operations | `operations/` (Python), `deploy/` (VPS, nginx, systemd: risky, ask first) |
| Static agent-facing docs | `llms.txt`, `skill.md`, `agents.html`, `server.json`, `plugin/` |
| Human docs | `README.md`, `docs/` |

### Size limits

- Aim for files under 300 lines. The hard limit is 500.
- `npm run check:size` enforces this on code files (it also runs in CI).
- Files that were already over 500 lines are listed in `scripts/file-size-ceilings.json` at their size when the rule started. They may shrink but never grow. When one shrinks, run `npm run check:size -- --update` to lower its ceiling and commit the change. Never add an entry or raise a number; split the file instead.

### Reuse before writing

- Before writing a helper, search `src/` for code that already does it (`grep -rn` for the key word) and reuse it.
- No duplicate helpers. If two copies exist, merge them into one shared file.

### No copies, no hand-edited output

- No `-old`, `-v2`, `-backup` or `copy` files. Git history keeps old versions.
- Never hand-edit generated or build files: `dist/`, `package-lock.json` (use npm), and `samples/` (regenerate with `scripts/generate-example-sample.mjs` or the release demo scripts).

### Cleaning up

- One small change per commit or pull request: move one feature out of a big file, remove one confirmed-unused file, or merge one set of duplicates.
- Behavior must not change. Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run check:size` before and after. If the code being moved has no test, add a simple one first.
- Delete something only after searching code, configs, scripts, docs and the Dockerfile to confirm nothing uses it.
- Stop and ask the owner before anything risky: deleting data, changing how the app is deployed or signed, or touching payment, x402, SSRF, login or other security code.
