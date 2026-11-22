# ViewportWitness recovery backup

Owner: Aria. Writer: Aria, using already loaded preservation context. Exact-source independent review is required before installation. This is deterministic operations, with no agent or PC dependency.

Daily at 03:25 UTC, a separate oneshot takes an online SQLite backup of the live Docker named volume (including committed WAL), encrypts it in APEXREC1 AES-256-GCM, uploads to existing R2 under `viewport-witness/`, reads the entire object back, decrypts, and checks database integrity, byte identity and all table row counts. Only then does it atomically update `/var/lib/viewport-witness-backups/latest-success.json`. Failures return nonzero and preserve the previous receipt. Keys and database row values are never logged. Table names and aggregate counts appear in recovery receipts.

Uses existing host Python cryptography, rclone configuration and separately stored consolidation recovery key. No key is copied into Git/R2 or changed. No archive or R2 object is automatically deleted. Unique dated objects are immutable by normal operation; review storage retention separately. Working plaintext exists within a root-restricted temporary directory and is removed after ordinary success or handled exceptions. A timeout/OOM/kill can leave restricted temporary copies; inspect and explicitly clean these operational artifacts after resolving a failure. Memory and timeout limits bound stalled jobs; source database is opened read-only.

Source is deployed through a separate pull-only checkout at `/opt/viewport-witness-operations` pinned to the accepted commit; this does not change the live app checkout/image or restart any application. Before installing, create `/var/lib/viewport-witness-backups` root:root 0700, validate units with `systemd-analyze verify`, then install symlinks to the two versioned unit files, daemon-reload, run the service once and check its verified receipt, then enable the timer. Existing application/database recovery is preserved. Rollback: disable/stop only this timer; retained encrypted backups and recovery key remain intact. Do not delete product data.

Tests: `python3 operations/test_backup_sqlite.py`. Tests include a committed WAL record, a tampered offsite readback preserving old success, malformed key rejection before transfer and corrupt database failure.

A successful job proves saved SQLite data recovery, not public application/payment integration or alert delivery. The recurring schedule requires later evidence of an actual timer-triggered completion. An intentionally disabled or never-firing timer is not currently covered by a separate receipt-staleness alarm; check timer status and receipt age in operational acceptance. The systemd stop-post hook covers process errors, timeout and OOM exits. Failures append a fixed sanitized finding through the existing `/usr/local/bin/apex-error` helper into `/opt/apex-errors/errors.jsonl`, for the retained VPS alerter. No direct Telegram sender, routine message, or Sarah dependency is added. End-to-end delivery on a real failure is not proven by fixture tests.

# ViewportWitness error watch

The public `/health` check (apex-vps-http-health) only proves the app answers. `error_watch.py` catches errors that leave `/health` green. Every 5 minutes (`deploy/vps/viewport-witness-watch.timer`) it checks that the container is healthy, looks for new `error`, `exception`, `unhandled` or `fatal` lines in the container logs, and checks that all five paid routes still answer 402 with headers under `WATCH_HEADER_LIMIT` (default 3900 bytes; nginx fails at 4096). Each problem is reported once through `/usr/local/bin/apex-error`, so the existing alerter sends it to Telegram, and is muted for `ALERT_REPEAT_SECONDS` (default 3600) while it continues. It never restarts anything and makes no payments.

Install from the pull-only `/opt/viewport-witness-operations` checkout: `systemd-analyze verify` both units, symlink them into `/etc/systemd/system`, `daemon-reload`, run the service once and check its output says `ok`, then `systemctl enable --now viewport-witness-watch.timer`. Remove: `systemctl disable --now viewport-witness-watch.timer`.

Tests: `python3 operations/test_error_watch.py`.

Every paid-route health probe sends `X-ViewportWitness-Source: monitor`. The existing
growth counters retain those events under `source=monitor`, separately from agent-client
and unknown traffic. This is a caller-declared operational label, not authenticated buyer
identity. The shared uptime check requests only `/health`, which is not counted as a
documentation request or payment challenge by the product's growth middleware.

The labeling cutover is prospective: older `source=unknown` counters include unlabeled
probes and must not be relabeled or presented as unique visitors. The cutover UTC day is
mixed; use the next full UTC day for a complete post-cutover daily comparison. The release
receipt records the exact installation and observed counter changes. Monitor labels do
not make remaining unknown traffic verified organic demand. Controlled purchase job IDs
must be recorded separately and excluded from customer-demand summaries.

# New feedback notifications

Owner-approved on 2026-11-22: check every 15 minutes and send new production feedback
to Baffles's existing authorized Telegram DM. `feedback_notify.py` reads the live SQLite
database with `mode=ro`; no Docker socket, app endpoint, payment or AI call is needed.
It ignores test/testnet and expired feedback. Each message contains at most ten short,
untrusted suggestions with product, purchase blocker, declared intent and optional price.
No customer identity, job, wallet or payment record is read. There is no notification
when nothing new arrives and no automatic roadmap or ticket changes.

The existing `/etc/apex-telegram-bot.env` supplies the existing bot and owner destination;
do not copy or print credentials or add recipients. Messages are plain text with link
previews disabled. State in `/var/lib/viewport-witness-feedback` is root-only and keeps
notified feedback IDs plus a bounded pending message, never the bot token. The pending
message is committed before sending and cleared only after Telegram acknowledges the
correct chat. Failures retain it for the next check. A crash/timeout after Telegram accepts
but before the local receipt is saved can produce a duplicate; delivery is at least once,
not a transactional exactly-once guarantee. Deleted/expired pending rows are not forwarded.
State corruption fails closed rather than silently forgetting prior notifications.

Install the independently accepted commit in `/opt/viewport-witness-operations`, validate
`deploy/vps/viewport-witness-feedback.{service,timer}` with `systemd-analyze verify`, symlink
only those units and run `daemon-reload`. Run the service once (quiet if empty), then enable
the timer. First scheduled check occurs after 15 seconds, then every 15 minutes. Confirm
an actual timer-triggered completion and its next run. `--test` sends one clearly labeled
setup check to the same owner, without inserting synthetic feedback. Preserve the app image,
protected app environment, database, existing timers and services; no app restart is needed.
Stop with `systemctl disable --now viewport-witness-feedback.timer` and stop its oneshot
if running; retain state to avoid duplicate alerts if resumed. Failure diagnostics use the
existing sanitized error book; raw feedback and Telegram HTTP exception strings are not logged.

Tests: `python3 operations/test_feedback_notify.py` (including readonly SQLite, retry,
deduplication, same-timestamp arrival, bounded batches, secret-safe errors and quiet runs).
Review the automation on 2026-12-22; retire if feedback is disabled or owner asks to stop.
Registry: `vault/automations/registry.yaml`, entry `viewport-witness-feedback`.

## Quickstart conversion report

Run `python3 operations/quickstart_summary.py` on the VPS for the private last-30-day setup
funnel. It reads the app database through the existing read-only summary and loads controlled
job exclusions from `/var/lib/viewport-witness-controlled/*.json`. No service, timer or wallet
is changed. Monitor/test-client sources and nonproduction modes are excluded. It refuses
missing/broken exclusion evidence or unavailable analytics instead of claiming zero sales.
Tests: `python3 operations/test_quickstart_summary.py`. Interpretation and retention:
`docs/GROWTH-ACTIVATION.md`, quickstart funnel section.
