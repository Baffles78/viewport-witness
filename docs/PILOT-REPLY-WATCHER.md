# Pilot reply watcher

This is a local Windows Task Scheduler fallback, not a Codex app Automation or a production app deployment. It reads the five approved conversations from the ignored private outreach record. Run `node operations/pilot_reply_check.test.mjs` before installation. Install once with `powershell -File operations/install_pilot_reply_check.ps1` after independent review.

An hourly task uses the existing authenticated desktop Codex CLI (Sol, low effort, read-only sandbox) to read Gmail, the Daydreams GitHub issue, and signed-in Chrome X conversations. It does not send builder messages, enroll prospects, pay, or change the app. Third-party instructions are untrusted. The local task has the user's existing connector access; the read-only shell sandbox does not itself revoke connector write capabilities, so its prompt explicitly prohibits those actions.

The wrapper validates structured source IDs, deduplicates replies and sends fixed notices linking to the original conversation through the existing VPS Telegram sender. It does not copy Telegram credentials, browser cookies, or OAuth secrets. State and a durable notification outbox stay in ignored `artifacts/five-builder-pilot/REPLY-WATCH-STATE.json`. No raw mail or browser transcript is saved. A crash between Telegram acceptance and state persistence can duplicate an alert; it cannot silently mark an unacknowledged alert sent.

Access failures are not counted as zero replies. They alert once per channel transition, with recovery alerts. Runtime failures exit nonzero and appear in Windows task history; they are not successful checks. Inspect the task's LastTaskResult and the private state's last_checked_at if alerts stop. A stale reply-check.lock after forced termination requires checking that no checker is active before removing the lock.

This is best effort: the PC must be awake, signed in, online and retain working Gmail/GitHub/browser/SSH connections. X may become unreadable or not expose stable message IDs. Hourly runs consume the existing Codex subscription usage. The wrapper refuses checks after December 6, 2026, at midnight Eastern. Successful unchanged runs remain quiet. Enrollment remains the owner's decision.

Rollback: `Unregister-ScheduledTask -TaskName 'ViewportWitness Pilot Reply Checks' -Confirm:$false`. Preserve private receipts and state. No VPS timer, app release, payment configuration, or existing alert service is modified.
