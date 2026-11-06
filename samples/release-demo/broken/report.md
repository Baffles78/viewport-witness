> SYNTHETIC LOCAL DEMONSTRATION. No on-chain payment, production call or customer success is claimed.

# ViewportWitness release check

Result: **FAIL**

Pages: 1. Reserved payment ceiling: 80000 atomic USDC. This is not a revenue or actual-settlement receipt.

## Page 1: FAIL
https://example.com/
[Report evidence](report.json)
[phonePortrait screenshot](phonePortrait.png)
[phoneLandscape screenshot](phoneLandscape.png)
[desktop screenshot](desktop.png)
- phonePortrait: 1 serious accessibility issue(s).
- phonePortrait: browser or network errors were observed.
- phonePortrait: content overflow or off-screen elements detected.
- phoneLandscape: 1 serious accessibility issue(s).
- phoneLandscape: browser or network errors were observed.
Warnings: 0. PASS can still contain non-blocking findings.
Finding: Ensure buttons have discernible text
Suggested fix: Give each button a short visible label or an aria-label that describes its action.
Finding: The browser recorded JavaScript errors while rendering the page.
Suggested fix: Start with the first console error, correct its script or data dependency, and rerun the check.
Finding: Content extends beyond the tested viewport and may be clipped or require sideways scrolling.
Suggested fix: Inspect the hinted elements and their parents for fixed widths, large margins, nowrap, or absolute positioning; prefer max-width: 100% and wrapping layouts.

Review targets and report contents before sharing. Reports expire under the service retention policy.