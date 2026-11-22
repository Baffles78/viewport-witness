# Customer workflow pilot

Status: prepared, not a completed customer study or a spending authorization.
Owner: Aria/Codex. Goal: observe whether a buyer can purchase useful evidence,
repair their own site, verify the result and choose to use the service again.
Do not contact prospects, create accounts or send a payment from this guide.

## Bounded run

Use one caller-owned public HTTPS page with a real, known repair opportunity.
Keep the exact URL unchanged across baseline and comparison. Authentication,
private staging, cookies and credentials are outside the service boundary.

| Stage | Existing operation | Maximum report price | Evidence to retain |
| --- | --- | --- | --- |
| Baseline | `check_page` / `POST /v1/checks` | 0.08 USDC | Job ID, authoritative settlement receipt, report, originals and annotations |
| Repair | Caller changes/deploys their site | No service purchase | Deployment reference, time, intended repair |
| Verify repair | `compare_page` / `POST /v1/compare` | 0.12 USDC | Exact baseline ID, new job ID, settlement, repair states, raw/filtered diffs |
| Later repeat use | `check_page` on a later deployment | 0.08 USDC | New deployment reference, distinct job and authoritative settlement |

The proposed three-report ceiling is **0.28 USDC**, excluding any network/provider
fees. It is not approved spending. Each current challenge must match the approved
network, USDC asset, recipient and operation before signing. Stop on a higher
quote, unavailable baseline or unclear payment outcome. A repeated purchase in an
operator-controlled test proves the workflow, not external repeat demand.

## Start without paying

For an operator rehearsal, set `VW_USAGE_SOURCE=test-client` in the current shell.
Reuse the existing pinned client from [QUICKSTART.md](QUICKSTART.md) to preview a
single baseline. Do not add `--execute` or load a signing connector. Save its quote
and missing-configuration names. Do not put secrets into this repository or guide.

The approved source version will support this comparison input (do not send it to
the deployed service until hosted exclusions are released):

```json
{
  "url": "https://YOUR-PUBLIC-PAGE",
  "baselineJobId": "COMPLETED-UNEXPIRED-BASELINE-ID",
  "visualExclusions": {
    "phonePortrait": [{ "x": 10, "y": 10, "width": 120, "height": 30 }]
  }
}
```

For the first pilot, prefer no exclusions unless a real dynamic region requires
one. Inspect unmasked changes as well; exclusions never clear accessibility,
layout or browser-error findings. A completed job with report FAIL is useful
evidence of page problems, not failed delivery. Missing measurements yield
`could_not_verify`; structural locators do not prove the same DOM node was fixed.

## Execution checkpoints

1. A participant approves their exact target, payer/provider, network, recipient,
   report budget and fees. The owner separately approves any operator-funded run.
2. Preview and review the challenge. Execute the baseline only with that authority.
   Preserve the original run directory and returned ID. Do not submit a second
   purchase after uncertain settlement; resume/reconcile the accepted attempt.
3. Download the report and evidence before normal seven-day expiry. Note setup
   time, unclear instructions, missing information and whether findings are useful.
4. The caller fixes their site using their own repository/deployment authority.
5. Compare within baseline retention using a fresh authorized payment. A baseline
   older than seven days may require a newly approved baseline purchase; stop
   rather than silently expanding this run's budget.
6. Review repair states and screenshots with the caller. Capture what remains
   unclear. Do not publish their page evidence or feedback without permission.
7. Observe later voluntary use after another deployment. Do not force a second
   immediate check to manufacture repeat demand. Missing follow-up stays unknown.

## Private evaluation record

Keep participant details, transaction references and screenshots in local/private
evidence, not a public GitHub issue. Record only aggregate conclusions publicly.

| Question | Record |
| --- | --- |
| Operator-controlled or external buyer? | Unknown until established |
| Preview and setup completed without assistance? | Time and concrete blocker |
| Payment authoritatively settled and report completed? | Separate payment/job evidence |
| Did findings cause a useful repair? | Caller observation plus measured comparison |
| Did the caller trust and understand the evidence? | Their words, recorded with permission |
| Later voluntary repeat purchase? | Observed / declined / unknown |
| Price or wallet/provider friction? | Specific step, not inferred intent |

Success for an operator run is a verified purchase/report/repair/comparison path.
Success for demand validation additionally requires an unrelated buyer and later
voluntary reuse. Quotes, listings, test-mode fixtures and internal spending do not
establish either external revenue or buyer demand. The next reserved decision is
the exact participant/target and, if operator-funded, a specific spending approval.
