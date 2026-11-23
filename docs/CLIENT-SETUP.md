# Client doctor and secure Windows setup

These commands are published in [client **0.3.0**](https://github.com/Baffles78/viewport-witness/releases/tag/client-v0.3.0).
Earlier archives remain unchanged. Client runtime: Node.js
22.12.0 or newer. Building this source checkout requires Node.js 22.13.0 or newer.
After `npm ci` and `npm run build`, use `node bin/viewport-witness.mjs` in place of
`viewport-witness` in the examples below. No credentials are needed to build or preview.

## Start without credentials

```powershell
viewport-witness doctor --url https://example.com
viewport-witness doctor --url https://example.com --json
viewport-witness setup --url https://example.com
```

Doctor reads runtime, strict public-target DNS, diagnostic OS lookup, service health
and an unpaid quote. It writes no manifests, checkpoints or reports. It displays the
validated price, native Base-USDC asset, network and recipient. `readyForPreview`
means those public preflight checks passed. It never grants spending authority.
Missing credentials are expected during this first stage.

If OS lookup works but strict DNS is refused, choose trusted DNS resolver IPs explicitly:

```powershell
viewport-witness doctor --url https://example.com --dns-servers 1.1.1.1,1.0.0.1
```

This sets only a dedicated client resolver. Both A and AAAA queries must complete
without operational errors, and every returned address must be public. OS lookup is
never an approval fallback. No automatic alternate DNS, Windows settings or service
worker policy changes occur. The same option passes through preview, execution and resume.

## Check an existing account

```powershell
viewport-witness setup --url https://example.com --check-account
```

The Windows helper runs public checks first, then asks for masked API key ID and
API key secret and an existing public Base payer address. Prefer the single-line
Ed25519 API key format. Prompts accept at most 8,190 characters. The existing account
must belong to the same CDP project, and the current computer's public IP must be allowed.
Use `--payer 0x...` to supply the public address beforehand if desired.

The account stage uses an API-key-only GET. No Wallet Secret is requested or used.
A successful GET does not prove signing permissions. The read-only balance check
uses the fixed Base mainnet RPC, verifies chain 8453, and queries only native USDC.
Insufficient balance is reported separately from an unknown/unavailable balance.
This helper cannot create or fund accounts, export keys or transfer assets.

API credentials remain SecureStrings between stages. A short-lived BSTR is converted
only when populating the child environment and freed in `finally`; child environment
entries are removed and SecureStrings disposed. No credential files, `setx`, profiles,
logs or transcripts are created. Inherited Node preload/debug/TLS-bypass variables are
removed from child processes. Script execution policy is respected, never bypassed.

## Execution is a separate, explicit choice

Only after independently approving the recipient and budget:

```powershell
viewport-witness setup --url https://example.com --run-id deployment-123 --network base --recipient APPROVED_PUBLIC_ADDRESS --budget 0.08 --execute
```

Every shown policy flag is required. After public and account/balance checks pass,
only this mode requests a masked Wallet Secret. It invokes the existing financial
runner once. Wallet Secret validity remains untested until that authorized flow.
No automatic signing/payment retry occurs.

Without `--output`, execution uses `%LOCALAPPDATA%\ViewportWitness\runs\deployment-123`,
not the current terminal directory. An existing lock or uncertain checkpoint stops
setup before credential prompts. Never delete markers or change run IDs to evade
reconciliation; a new ID is for a genuinely new deployment.

Retrieve an already accepted report without any credential prompt or payment:

```powershell
viewport-witness setup --resume --output "C:\Users\you\AppData\Local\ViewportWitness\runs\deployment-123"
```

Add the original explicit `--dns-servers` choice if needed. Recovery keeps the original
manifest/checkpoint and writes only the existing runner's `resumed` report directory.
An unpaid preview has no accepted report to resume. If payment outcome is uncertain,
preserve the checkpoint and reconcile it instead of purchasing a replacement.
