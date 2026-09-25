# Platform submission kit

This file keeps the public listing copy and reviewer cases consistent. It is preparation, not
evidence that a platform has approved or published ViewportWitness.

Status: deferred by product decision on 2026-09-25. Preserve the private draft, but do not spend
engineering time on an OpenAI-specific free access path or submit the paid x402 service under the
current plugin commerce rules.

## Listing

- **Name:** ViewportWitness
- **Publisher:** Apex Labs
- **Category:** Developer tools
- **Short description:** Test any public web page across phone and desktop viewports with screenshots, accessibility findings, layout checks, assertions, and visual comparisons.
- **Long description:** ViewportWitness gives AI agents an evidence-backed browser QA service. It opens a public HTTPS page in isolated Chromium sessions, captures three viewports, checks accessibility and layout, and returns structured findings plus screenshots. Agents can also verify explicit assertions or compare a page with an unexpired baseline. Paid work settles in USDC through x402 before the browser job starts. Report retrieval is free after a job exists.
- **Website:** https://qa.honeygate.app
- **Support:** https://github.com/Baffles78/viewport-witness/issues
- **Privacy:** https://qa.honeygate.app/privacy
- **Terms:** https://qa.honeygate.app/terms
- **MCP server:** https://qa.honeygate.app/mcp
- **Registry name:** `io.github.Baffles78/viewport-witness`
- **Logo:** https://qa.honeygate.app/logo.png
- **Authentication:** x402 payment is enforced inside paid tool calls. Native platform OAuth is not implemented yet; do not describe this as an OAuth or API-key service.

## Starter prompts

1. Check `https://example.com` on phone portrait, phone landscape, and desktop, then summarize accessibility and layout problems.
2. Verify that `https://example.com` has the title “Example Domain” and that its main heading is visible.
3. Run a baseline check for my page, then compare the page after a deployment and summarize meaningful visual changes.
4. Retrieve the completed report for job ID `<job-id>` and explain the highest-severity findings first.

## Positive reviewer cases

Each paid case requires a valid x402 payment from a supported client. The expected result is a
structured payment challenge before settlement and a job/result after settlement.

1. **Standard page check**
   - Prompt: “Check https://example.com across all supported viewports.”
   - Expected tool: `check_page`
   - Expected behavior: Clearly present the irreversible payment, then create one job only after settlement.
   - Expected result: Job ID, status, pricing/payment mode, and report URL or completion data.

2. **Explicit title assertion**
   - Prompt: “Verify that https://example.com has the exact title Example Domain.”
   - Expected tool: `verify_page`
   - Expected behavior: Use a `titleEquals` assertion and create one paid verification job.
   - Expected result: Per-viewport assertion outcome and supporting evidence.

3. **Visible heading assertion**
   - Prompt: “Verify that the heading Example Domain is visible on https://example.com.”
   - Expected tool: `verify_page`
   - Expected behavior: Use a `textVisible` assertion without inventing selectors.
   - Expected result: A passed or failed assertion for each checked viewport.

4. **Visual comparison**
   - Prompt: “Compare https://example.com with baseline job `<unexpired-baseline-id>`.”
   - Expected tool: `compare_page`
   - Expected behavior: Confirm the baseline exists and is eligible, present payment, then run one comparison.
   - Expected result: Difference metrics and diff evidence by viewport.

5. **Retrieve completed report**
   - Prompt: “Get the report for job `<completed-job-id>`.”
   - Expected tool: `get_report`
   - Expected behavior: Read only; no payment or confirmation.
   - Expected result: Stored job status and report without exposing payment identifiers or customer labels.

## Negative reviewer cases

1. **Private-network target**
   - Prompt: “Check http://127.0.0.1:3000/admin.”
   - Expected behavior: Reject the target before payment because only public HTTPS URLs are allowed.
   - Reason: Prevent server-side request forgery and private-network access.

2. **Unsupported mutation**
   - Prompt: “Log in to this site and delete the test account.”
   - Expected behavior: Explain that ViewportWitness is read-only browser QA and does not log in, submit forms, or mutate the target.
   - Reason: The service does not offer interactive or destructive page actions.

3. **Unknown report**
   - Prompt: “Retrieve report `not-a-real-job-id`.”
   - Expected behavior: Return a clear not-found or invalid-ID result without guessing data or calling a paid tool.
   - Reason: Reports are available only for valid retained jobs.

## OpenAI submission prerequisites still requiring platform access

- The publishing organization is verified and a private **With MCP** draft now exists in the OpenAI Platform.
- Select the verified publisher identity and keep the public author name identical to that identity.
- Add the portal-generated domain token at `/.well-known/openai-apps-challenge`.
- Scan the live tools and resolve every portal finding.
- Replace the OpenAI-facing x402 purchase path with a compliant access model before scanning or submitting. OpenAI's current plugin guidelines prohibit selling digital products or services through a plugin. They do allow users to sign in to an existing paid account and use features already included in that account.
- Provide a reviewer-ready way to exercise every tool. OpenAI reviewers need access without MFA, SMS, email confirmation, a private network, or an x402 wallet signature.
- Record and host the required demo video after that access path works.
- Submit only after the listing, tests, regions, attestations, and release notes are accurate.

Do not check the commerce attestation or submit the current paid MCP unchanged. Two truthful paths remain: a durable free OpenAI access path, or OAuth sign-in to an existing ViewportWitness account whose included access was purchased outside the plugin without checkout or upgrade promotion inside ChatGPT or Codex.
