# MCP Installation and Discovery Guide

ViewportWitness exposes a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) endpoint at the following address:

```
https://qa.honeygate.app/mcp
```

Transport: **Streamable HTTP** (stateless JSON-RPC over HTTP POST).

---

## Connecting vs paying

**Connecting** means pointing an MCP-capable client at the endpoint URL. Any MCP client that supports streamable-http transport can connect and call `tools/list` to discover what tools are available.

**Paying** for a tool call requires a separate capability: an x402-aware client that can sign a crypto payment and attach it to the tool call via the standard x402 MCP `_meta` payment exchange. Standard AI assistants (ChatGPT, Claude, Cursor, Codex, VS Code, etc.) can connect and discover the tools, but **cannot automatically sign x402 payments**. You need an x402-enabled client or script to actually run paid tools.

---

## Available tools

| Tool | Cost | Read-only? |
|------|------|-----------|
| `check_page` | $0.08 USDC | No (enqueues a paid job) |
| `verify_page` | $0.10 USDC | No (enqueues a paid job) |
| `compare_page` | $0.12 USDC | No (enqueues a paid job) |
| `get_report` | Free | Yes |

Payment is via x402 on Base (or Solana if advertised). See `GET https://qa.honeygate.app/.well-known/x402` for current payment options and rail details.

---

## ChatGPT

1. Enable Developer mode under **Settings > Security and login**.
2. Open **ChatGPT Plugins**, select the plus button, and create a connection.
3. Enter `https://qa.honeygate.app/mcp` as the public MCP server URL.
4. Review the four discovered tools before enabling the connection in a chat.

Discovery works without payment. Paid calls still require an x402-capable payment path.

## Claude

In Claude or Claude Desktop, add a custom connector under **Settings > Connectors** and use:

```
https://qa.honeygate.app/mcp
```

For Claude Code:

```bash
claude mcp add --transport http --scope user viewport-witness https://qa.honeygate.app/mcp
```

## Codex

```bash
codex mcp add viewport-witness --url https://qa.honeygate.app/mcp
```

## Cursor

Add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "viewport-witness": {
      "url": "https://qa.honeygate.app/mcp"
    }
  }
}
```

## VS Code

Add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "viewport-witness": {
      "type": "http",
      "url": "https://qa.honeygate.app/mcp"
    }
  }
}
```

After connecting, call `tools/list` (or the equivalent discovery command) to see the four tools and their input schemas.

---

## Using paid tools

To call `check_page`, `verify_page`, or `compare_page`, your client must send a valid x402 payment in `_meta`. The flow is:

1. Client calls `tools/list` — discovers the tool and that it is paid.
2. Client sends a tool call without payment — server returns a 402 challenge with payment requirements (network, payTo address, amount).
3. Client signs a payment transaction using a funded wallet and resends the tool call with the payment in `_meta[x402]`.
4. Server verifies and settles the payment, then enqueues the browser job.
5. Server returns `{ id, status: "queued", pollUrl }`.
6. Client polls `get_report` with the job ID until status is `"complete"`.

An x402-aware SDK is required for steps 2–4. See [x402.org](https://x402.org) for client libraries.

---

## Self-hosted (test mode)

A local instance started with `PAYMENT_MODE=test` (the default) runs without payment:

```bash
npm install
npx playwright install chromium
npm run dev
```

Configure your MCP client to use `http://localhost:3000/mcp` instead. In test mode all tools run without x402 payment and results are labeled `paymentMode: "test"` — these do not represent real payment settlements.

---

## Registry entry

The official MCP Registry manifest is `server.json` at the repository root and uses the verified GitHub namespace `io.github.Baffles78/viewport-witness`. Check the registry itself for current publication status; a prepared manifest or workflow run is not evidence that publication has completed.

---

## Privacy and terms

- Privacy policy: `GET https://qa.honeygate.app/privacy`
- Terms of service: `GET https://qa.honeygate.app/terms`
