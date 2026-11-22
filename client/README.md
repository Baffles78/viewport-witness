# ViewportWitness ready-to-run client

This README includes prepared, unpublished dependency migration source requiring Node.js
22.12.0 or newer and npm. The published `client-v0.1.0` asset below is unchanged and keeps
its original Node.js 22+ guidance. Publishing the migration requires a fresh package version,
tag and asset name; never overwrite the existing v0.1.0 release.

The published client needs no checkout, TypeScript build or local browser installation.
This package calls the hosted service; it does not run a server or browser worker.

Preview one public HTTPS page without loading a wallet or paying:

```sh
npx --yes --package=https://github.com/Baffles78/viewport-witness/releases/download/client-v0.1.0/viewport-witness-client-0.1.0.tgz -- viewport-witness --url https://example.com --run-id my-deployment-001 --output out/my-deployment-001 --network base --wallet cdp
```

The versioned GitHub release tarball is the distribution. It is not an npm registry listing.
For repeated use, install that same tarball with `npm install --global <tarball-URL>` and
run `viewport-witness` with the same arguments. Runtime dependencies are locked by the
included npm shrinkwrap. No install/build scripts are included in this client package.

A complete three-viewport report is $0.08 USDC; the preview shows current terms but no report.
Only public HTTPS pages are supported. Review price, network, token and recipient and grant
explicit spending authority before adding `--recipient APPROVED_RECIPIENT --execute` to the
same command. Do not substitute the displayed recipient for independent approval.
`--wallet cdp` reuses an existing CDP Base account; configure CDP_API_KEY_ID,
CDP_API_KEY_SECRET, CDP_WALLET_SECRET and VW_PAYER_ADDRESS locally. Never paste credentials
into commands, this service, feedback or reports. Account creation/funding is not provided.
An existing custom connector can use `--wallet-module /absolute/path/to/connector.mjs`.
Funded CDP-provider acceptance remains unverified; the underlying generic Base flow was tested.

Retrieve an already accepted job without a wallet or a permitted new payment:

```sh
npx --yes --package=https://github.com/Baffles78/viewport-witness/releases/download/client-v0.1.0/viewport-witness-client-0.1.0.tgz -- viewport-witness --resume --output out/my-deployment-001
```

Keep the output/checkpoint for recovery. Uncertain payment attempts require reconciliation;
never change a checkpoint/run ID to bypass that stop. Review saved report evidence before
sharing; API reports expire after seven days by default.

A random local `quickstart-usage.json` links setup and purchase measurement. The service
stores its hash, not the raw ID. Set `VW_DISABLE_USAGE_TRACKING=1` to omit it. Operator tests
must set `VW_USAGE_SOURCE=test-client` before preview and execution. See
[privacy](https://qa.honeygate.app/privacy) and the
[full quickstart](https://qa.honeygate.app/quickstart).
