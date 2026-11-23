# Desktop pilot monitor recovery

Prepared source recovery only. The coordinator must review the exact revision before
activating the scheduled task. This patch does not modify a task, run a model, notify
anyone or copy credentials. Public B03 alerts remain owned by the VPS watcher.

The missing desktop runner is restored from `a207af8b5b2080f0295aec1aff70b3b0ff1b689e`,
including `77737a62f7d362ff16bedb6f0b0b2c18fab09f47` public-notification suppression.
Its state location is now independent of the checkout containing its executable:
`C:/projects/viewport-witness/artifacts/five-builder-pilot`. Existing `OUTREACH-STATE.json`,
`REPLY-WATCH-STATE.json`, lock, failure marker and durable outbox stay there unchanged
until a real authorized check. Never initialize a second state directory or reset a lock
to bypass an uncertain run. Previously queued B03 notices are suppressed before sending.

## Stable activation target

After review, create a dedicated detached Git worktree at
`C:/projects/viewport-witness-operations-desktop`, pinned to the accepted exact revision.
Keep it outside the mutable application checkout and ordinary checkout cleanup. It needs
only the recovered operations script, Node builtins and the existing sanctioned resolver:
`C:/projects/vault/tools/agent-handoff/codex-executable.mjs`. No npm install is required.
The resolver selects the existing desktop Codex executable after desktop updates; there
is no npm CLI, API-key or provider fallback. Existing signed-in desktop access is required.

Task action after coordinator activation: use an absolute trusted Node executable as
the executable, the quoted absolute argument
`"C:/projects/viewport-witness-operations-desktop/operations/pilot_reply_check.mjs"`,
and the dedicated worktree as working directory. Do not keep the old application-checkout
script path. Task settings and registration remain the coordinator's responsibility.

Before activation, run the same absolute entry with `--dry-run`. This validates the module
and synthetic five-contact report from any working directory. It prints only paths,
expiry and fixture counts; it never reads/writes private state, imports the desktop
resolver, starts a model, invokes SSH or flushes pending notifications. Tests use the
actual CLI with blocked filesystem mutation and subprocess APIs. A successful dry run
does not establish authenticated mail/browser access or delivery health.

## Runtime limits and dependencies

The hourly awake/signed-in-PC schedule is unchanged. The monitor stops at
`2026-12-07T05:00:00Z` (end of December 6 Eastern), before state or resolver access.
Model execution is limited to ten minutes, its instruction budget to eight minutes,
and captured output to 4 MiB. It requests five bounded structured conversation results.
Outgoing owner alerts use existing SSH access to the VPS and its existing
`feedback_notify.telegram_send`, with a 45-second process deadline. Only acknowledged
delivery advances incoming IDs. No prospect follow-up, enrollment or payment is performed.

The model runs with the historical `danger-full-access` setting. Read-only instructions
and structured output are behavior requirements, **not OS filesystem/network confinement**.
Do not describe this watcher as sandboxed. It is configured for this Windows PC, while
the code itself is not an enforcement barrier against running on another machine.
Authenticated channel checks and one bounded real run remain separate coordinator checks.
