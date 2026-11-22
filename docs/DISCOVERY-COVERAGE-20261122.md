# Discovery coverage assessment — 2026-11-22

The live service's five products are indexed. The former discovery check conflated
selected search misses with catalog coverage. The corrected check reports catalog
membership separately from relevance-ranked search visibility and optional endpoint
validation. No registration, metadata deployment or paid indexing call was made.

## Evidence

The public Coinbase merchant endpoint returned `pagination.total: 5` for the
existing public Base recipient. All five exact qa.honeygate.app URLs were present:
checks, verify, compare, extract and security-gate. The diagnostic also paginates
the existing public Solana recipient and bounds response size and page count.
Incomplete enumeration yields unknown coverage, never an invented missing entry.

All five official read-only endpoint validations returned `valid: true`, simulated
`accepted`, active index status and no required preflight failure. Validation is
not a payment, settlement, new indexing action or buyer-demand signal.

Selected domain-filtered intent searches still did not surface verify, compare or
security-gate. Search relevance is a different observation from index membership;
no successful ranking improvement is claimed. Existing descriptions and schemas
are already accepted. Further metadata changes can be proposed from real buyer
query evidence; spending to manipulate ranking is not part of this work.

## Reproduce

```sh
node --test scripts/bazaar-coverage.test.mjs
node scripts/check-agent-discovery.mjs --validate-endpoints --require-bazaar
```

`--require-bazaar` requires complete merchant-catalog membership.
`--require-search` additionally requires the selected intent queries to surface
their expected products. Without strict flags, discovery ranking remains advisory.
Validation is optional to avoid unnecessary remote probes during routine checks.
Requests do not load a wallet or attach authorization/payment headers. The API
remains usable directly through its published HTTP/OpenAPI and MCP documents.

## Primary sources

- [Coinbase discovery interfaces](https://docs.cdp.coinbase.com/x402/buyer/discover-services)
  describes relevance-ranked search and merchant pagination.
- [Merchant catalog API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/list-merchant-discovery-info)
  defines resources and pagination.
- [Read-only validator](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/validate-x402-endpoint)
  explicitly performs no payment and does not index a resource.
- [Seller discovery guidance](https://docs.cdp.coinbase.com/x402/seller/get-discovered)
  separates validation, indexing after settled payment, and ranking.
