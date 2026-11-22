# Simpler first-purchase client

Prepared 2026-11-22, based on `034a408`. Owner/writer: Codex, standard/medium.

The unpaid preview now includes selected public network, native-USDC asset, recipient,
atomic amount and optional Solana fee payer, with `spendingApproved: false`. It never
loads a connector. The existing preview renderer moved into a small module; quote selection,
budget calculation, signing, settlement and replay/reconciliation rules are unchanged.
Only allowlisted public fields are returned; provider metadata is not copied wholesale.

`--wallet cdp --network base` selects the existing customer-owned CDP account connector.
Missing configuration is reported by environment variable name without exposing values or
loading the SDK on preview. No account creation, funding, key import or new payment rail.
Execution still requires explicit run, network, independently approved recipient and wallet.

`--resume --output <existing-directory>` retrieves an accepted job without a wallet. An
immutable, bounded `first-check.json` points to its generated manifest basename. Legacy runs
can specify the original basename explicitly. Unaccepted/uncertain/missing checkpoints stop.
The child CLI rechecks accepted-only state after taking its original exclusive lock, then
uses the fixed always-throw payment adapter. Existing checkpoint identity is preserved while
terminal result fields may update; original reports remain, with refreshed output in `resumed/`.
Recovery rejects directory junctions and linked/nonregular output files before fetching,
rechecks output before writing, and replaces report files atomically instead of following links.

Validation: 585 tests in 50 files passed, including real CLI refusal tests for missing CDP
configuration, unsafe recovery, directory junctions and linked reports. Independent review
found the linked-output preservation defect; it was fixed with the two regression tests.
TypeScript, ESLint, build, diff and file-size checks pass.
The oversized release client shrank from 544 to 526 lines; its ceiling was lowered using
the sanctioned script. New public helper modules remain below the normal size limit.

Manual read-only live checks with the new client: preview quoted 80000 atomic USDC on Base,
showed the published recipient and four missing CDP variable names without loading a wallet;
legacy `--resume` retrieved the previously paid, still-retained controlled example.com report
as PASS without a payer connector. Test requests used inherited NODE_OPTIONS classification,
so the wrapper applies to the child too. No new signing or payment was performed.

The earlier funded proof covers the generic existing Base-wallet route. The CDP shortcut
reuses its prior connector; funded CDP-provider access remains unverified. Wallet setup and
spending consent remain required. This is a repository client/docs update; no running app,
public API, payment setting, protected environment or notification timer is changed.
