# Release check offer

## Pricing

- **$0.08 USDC per page** — browser QA report across three viewports (phone portrait, phone landscape, desktop).
- A five-page release check quotes **$0.40 USDC** based on this per-page rate.
- Actual prices are confirmed at execution time via the x402 payment challenge. Always check the quoted amount before authorising payment.

## Example: five-page check

```json
{
  "runId": "my-v1-release-20261001",
  "pages": [
    "https://example.com",
    "https://example.com/docs",
    "https://example.com/pricing",
    "https://example.com/blog",
    "https://example.com/contact"
  ],
  "maxBudgetUsdc": "0.40"
}
```

Run a preview (no payment) first:

```sh
node scripts/release-check.mjs --manifest examples/release-check.json --output out/
```

Preview output states explicitly that no verdict is available and no payment was made.

Replace these example targets with your own public HTTPS pages and give each new deployment a fresh runId. Reusing a runId resumes its existing evidence. A customer-owned payment adapter is required for paid execution; there is no default signer or automatic spending.

## Evaluation template

For operators tracking real completed buys, fill in the following after a paid run:

| Field                                             | Value                        |
| ------------------------------------------------- | ---------------------------- |
| runId                                             |                              |
| Pages checked                                     |                              |
| Quoted total (USDC)                               |                              |
| Actual settlement confirmed                       |                              |
| Completed customer purchases / tracked identities |                              |
| Repeat purchase after a different deployment      |                              |
| Elapsed time (wall clock)                         |                              |
| Verdict                                           | PASS / FAIL / INCONCLUSIVE   |
| Observed cost (worker seconds × rate)             | unknown unless rate supplied |
| Notes                                             |                              |

Observed cost is unknown without a supplied worker-second rate. Do not invent a conversion baseline or promise of sales based on this data.

Evaluate after 14 days of exposure or the first five unrelated completed customer release checks, whichever comes first. Record exposure and acquisition source as unknown unless observed. If there are no completed purchases, test the offer wording or workflow with prospective buyers before adding more features. If purchases occur without a repeat check after another deployment, investigate usefulness and integration friction. No outreach is sent by this implementation.

## Buyer trigger

A paid release check is appropriate **after deployment to a staging or production environment** and before sign-off. The CLI is not a deployment tool and does not access internal networks.

## Customer review before sharing

Report Markdown contains verdict summaries and links to retained browser evidence. Target query strings and URL credentials are removed from the Markdown, but screenshots and linked reports can reveal page content. Review them before sharing. Only public HTTPS pages are supported; authenticated or private-network targets are outside this offer. Reports expire under the service retention policy (default seven days).

## Repository status

This repository is **private**. The example workflow and manifest are not Marketplace publications. There is no automatic registry or public submission associated with running this tool.
