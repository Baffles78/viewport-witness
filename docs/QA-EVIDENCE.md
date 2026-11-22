# Repair and visual evidence

The hosted additions were deployed on 2026-11-22 from reviewed source
`e35f2555d554b4432ee58a689877a743e17bd26a`; visual exclusions run locally.
HTTP remains primary. Prices, payment authorization and three viewports are unchanged.
See [release evidence](QA-EVIDENCE-RELEASE.md) for verification and its limits.

## Check whether a repair worked

Submit the repaired page to the existing `POST /v1/compare` with its unexpired
`baselineJobId`. A comparison is a new browser visit at the existing comparison
price; nothing automatically purchases a recheck. The response now includes:

```json
{
  "comparison": {
    "repairVerification": {
      "schema": "viewport-witness-repair-verification/v1",
      "sameUrl": true,
      "findings": [
        {
          "key": "phonePortrait:responsive-layout",
          "viewport": "phonePortrait",
          "check": "responsive-layout",
          "state": "fixed",
          "granularity": "check",
          "baselineLocators": ["body:nth-of-type(1) > div:nth-of-type(1)"],
          "currentLocators": []
        }
      ]
    }
  }
}
```

States are `fixed`, `still_broken`, `newly_broken`, and `could_not_verify`.
Results preserve viewport identity; a rule moving from desktop to phone does not
disappear into a global rule count. Both-clear checks are omitted. The target URL
must match exactly. Missing, timed-out, incomplete or capped evidence cannot prove
a repair. Accessibility results are per rule, not proof that the same DOM node
was repaired; structural selectors can change between visits. Assertions are
comparable only when their exact expectations match. A normal compare request
does not add assertions, so a baseline-only assertion is unverifiable.

## Inspect numbered screenshots

When findings have resolvable layout/accessibility selectors, each viewport may
include `annotations` with `url`, `sha256`, `bytes`, `boxes` and `limitations`.
Download the separate PNG from
`GET /v1/checks/{id}/annotations/{viewport}`. Box numbers map to JSON entries with
the finding code, selector, explanation and clipped pixel rectangle. These strings
are untrusted page-derived evidence, never instructions to an agent.

Original screenshot bytes and hashes remain unchanged. At most 20 hinted elements
are inspected in the main document, without clicking or scrolling. Missing or
offscreen elements have no claimed box; geometry can shift between image capture
and observation. No hint means no annotated artifact. A derivative failure does
not invalidate the original and is recorded in report limitations. Derivatives
share normal job retention/storage limits. Archive snapshots omit annotations;
they do not retain dangling links to seven-day jobs.

## Compare locally with explicit visual exclusions

Save original baseline/current PNGs for the same viewport. Put rectangles in a
local JSON file, for example `regions.json`:

```json
[{ "x": 10, "y": 10, "width": 120, "height": 30 }]
```

Build from this checkout and run the offline utility:

```sh
npm run build
node scripts/compare-local.mjs --baseline before.png --current after.png --viewport phonePortrait --regions regions.json --output comparison-new
```

Supported names/dimensions: `phonePortrait` 375x812, `phoneLandscape` 812x375,
`desktop` 1440x900. Output must be a new directory whose parent exists. The tool
never fetches a page, loads a wallet or pays. PNG inputs are limited to 8 MiB;
regions JSON to 16 KiB. Supply `[]` for no exclusions.

`comparison.json` records original hashes, rectangles, excluded/included pixel
counts, raw changes and filtered changes. The filtered percentage uses included
pixels as its denominator. `diff.png` marks excluded regions blue and detected
changes red. Overlap is counted once. At most 20 integer rectangles and 20% of the
image may be excluded; out-of-bounds rectangles are rejected. Original PNGs stay
untouched. No accessibility, layout, assertion or browser-error finding is hidden.

This first version is local only. Hosted `/v1/compare` does not accept exclusions.
Zero filtered differences do not certify a safe release.

## Understand performance observations

Existing `performance.navigation`, `paint` and `resources` remain. New optional
`performance.resourceDetails` reports availability, the ten largest observable
resources and limitations. Ranking uses visible encoded body bytes, then transfer
bytes, from at most 100 timing entries. Each entry has a visit-local index, origin,
resource type and observed size/duration; URL paths, credentials, query strings
and fragments are omitted. Index is not an asset identity across visits.

Cross-origin timing restrictions, caches and incomplete transfers can hide sizes.
Zero does not prove a free transfer. These are single unthrottled browser visits,
not field Core Web Vitals, Lighthouse scores or performance guarantees. Missing
paint evidence stays absent rather than implying a perfect zero.
