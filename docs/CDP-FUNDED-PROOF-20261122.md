# Funded CDP Base proof — 2026-11-22

The approved operator test completed using the published client 0.2.0 and an existing
CDP-managed EVM account. This verifies the customer CDP signing path for one production
purchase; it is not evidence of external customer demand.

## Bound inputs and result

- Published source: `44cad78aa9e8e26910beba7655fcc0dfd329c078`.
- Client archive SHA-256: `ee0e98ae75ebbf717b999a5c73e7ad330f3f7f9044fc60208f0ff35399ffb0e5`.
- Windows PowerShell 5.1, Node.js 24.13.0 and npm 11.8.0 on the owner's trusted computer.
- One explicitly approved payment of 80,000 native USDC atomic units ($0.08) on Base mainnet.
- Successful onchain receipt with exactly one matching payer-to-service USDC transfer.
- Production job settled and completed; report verdict PASS, with successful page loads and
  nonempty screenshots at 375x812, 812x375 and 1440x900.
- Client reported successful retrieval and subsequent recovery without another payment.
  The coordinator observed one additional service job, no unresolved settlements and the
  expected remaining wallet balance.

The coordinator checked the production SQLite settlement record, live report, Base chain ID,
successful transaction receipt, token contract, sender, recipient, amount and remaining balance.
Detailed payer, transaction and job identifiers are retained privately, not published here.

## DNS interruption and reconciliation

The first attempt stopped during target validation, before the durable payment checkpoint or
signing adapter. The owner's network supported Windows hostname lookup but refused Node's direct
A/AAAA DNS queries. An unpaid preview reproduced the same error. Both query types and the actual
unpaid client preview then passed with an explicit resolver used only by the Node processes.

Before retry, the coordinator confirmed the missing financial checkpoint, unchanged funded balance,
no new server job and no unresolved settlement. A reviewed helper preserved the interrupted attempt's
records, retained the same manifest/run ID and payment limit, and carried the resolver setting into
the client's child processes. No Windows-wide DNS setting, URL-safety check, package byte, payment
policy or production configuration was changed. Credentials were entered through masked prompts,
kept in memory/child environments and excluded from saved diagnostics.

## Limits

This proof covers the existing-account CDP connector, native USDC on Base and this one report.
It does not certify every CDP account policy, other networks/products, future provider behavior,
all Windows network configurations, external customer adoption or repeated use. New payments
still require explicit spending authority; uncertain outcomes still require reconciliation.
Published archives remain immutable. Account creation/funding remain outside the client package.
