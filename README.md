# smx-mcp: SMX by Space Markets (testnet) MCP server

MCP server for **SMX**, the Space Markets testnet venue for humans and agents, and the **Space Markets Index (SMI)**,
published by Space Markets, Inc. Space Markets, Inc. is the publisher of this package; SMX is operated by SMX Markets Ltd (BVI). **Testnet only: Base Sepolia (chain id 84532).** Test tokens have no monetary value.
All tools are free and need no key or account. Not available to US persons or in restricted jurisdictions.

**Terms of Service:** https://smx.space/terms.html · **Privacy policy:** not yet published (see Licence and data)

Two separate products, kept separate in every tool:

- **SMI** (`smi_*` tools): information on orbital launch activity and other space-sector data. SMI results never
  contain market prices. Data from GCAT (J. McDowell, planet4589.org/space/gcat), CC BY 4.0, modified by Space Markets.
  Not affiliated with or endorsed by SpaceX. Data only, not advice.
- **SMX event markets** (`smx_*` tools): testnet markets priced in test USDC. Read from the Base Sepolia contracts and
  the SMX agent API.

This server **never signs, sends or holds keys and never resolves markets.** `smx_build_order`, `smx_build_cancel`,
`smx_build_claim` and `perps_build_order` return UNSIGNED Base Sepolia transactions (`to`, `data`, `value`, `chainId`) that you
sign and send from your own wallet. `smx_trading_guide` returns the steps and `smx_check_cancel_safety` helps you follow the
claim-before-cancel rule (`smx_build_cancel` adds the claims first automatically).

## Tools

| Tool | Cost | What it returns |
|---|---|---|
| `smi_get_latest` | free | Latest SMI print: headline (SMI Launch Cadence + formula) and a one-line summary per sub-index; `sub_index` returns one in full |
| `smi_get_methodology` | free | SMI methodology: version, change log, conflicts statement, headline formula, counting rules |
| `smx_list_markets` | free | SMX markets from the on-chain MarketRegistry (same listing rules as the agent API): state, status, outcome, bid/ask, YES midpoint, minimum order |
| `smx_get_market` | free | One market plus the resting order book aggregated by price level, contracts, links |
| `smx_trading_guide` | free | How to trade from your own wallet: steps, addresses, order rules, the claim-before-cancel rule |
| `smx_check_cancel_safety` | free | Unclaimed-fill check for your order ids (`fills(orderId, n)` for every batch, plus a `claim` simulation). `safeToCancel=false` means do not cancel |

All tools are annotated `readOnlyHint: true` and return `structuredContent` plus a one-line text summary.

### Perps (testnet, Base Sepolia, MockUSDC)
`perps_list_markets`, `perps_quote`, `perps_build_order`, `perps_positions`, `perps_account`. These proxy the SMX perps API (`SMX_PERPS_API`, default `https://smx-perps-preview.fly.dev/perps/v0`) and cover all markets on both engines, including PERP-XRAY and the countdowns. They return UNSIGNED transactions only, plus `reduce_only` status and machine-readable error `code`s. Sign them with your own wallet.

## Install

Requires Node.js 20+. Until the package is published, replace `npx -y smx-mcp` with
`node /absolute/path/to/smx-mcp/dist/index.js` (after `npm ci && npm run build`).

### Claude Desktop

`claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "smx": {
      "command": "npx",
      "args": ["-y", "smx-mcp"]
    }
  }
}
```

Add `"env": { "SMX_MCP_TELEMETRY": "1" }` only if you want to opt in to usage counting.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "smx": {
      "command": "npx",
      "args": ["-y", "smx-mcp"]
    }
  }
}
```

### Any MCP client

- **stdio:** command `npx`, args `["-y", "smx-mcp"]`. No env needed.
- **Streamable HTTP:** run `npx -y smx-mcp --http 8787` and point the client at `http://localhost:8787/mcp`
  (stateless, JSON responses). `GET /health` for checks.
- **Claude Code:** `claude mcp add smx -- npx -y smx-mcp`
- **MCP Inspector:** `npx @modelcontextprotocol/inspector node dist/index.js`

## Network endpoints and credentials

This server makes outbound HTTPS calls only to:

| Endpoint | Used for |
|---|---|
| `https://smx.space` (SMI API, agent API) | market, trading-status and SMI data; carries the version header and, only if you opt in, the telemetry headers below |
| `https://smx-perps-preview.fly.dev` (SMX perps API, `SMX_PERPS_API`) | perps markets, quotes, positions and unsigned perps transactions (testnet) |
| `https://smx-indexer-preview.fly.dev` | order book, clears, candles, stats, account orders (testnet indexer) |
| `https://sepolia.base.org` (Base Sepolia public RPC) | read-only contract calls for market state and unsigned order building |

Credentials: none. All tools are free; the server reads no keys and makes no payments. Order tools return UNSIGNED transactions; the
server never signs, sends or stores trading keys. No install scripts, no shell execution, no file access beyond
`~/.config/smx-mcp/install-id`, which is only created if you opt in to telemetry.

## Telemetry
**Off by default.** By default requests to smx.space carry only X-SMX-Client (the package version, like a user agent); no id is created or sent. If you set `SMX_MCP_TELEMETRY=1` (opt-in), requests to smx.space also carry X-SMX-Install (a random install id stored in ~/.config/smx-mcp/install-id) and X-SMX-Tool (tool name). They are used only to count anonymous usage, are not sold or transferred, and are not used to train models. Nothing is sent to any other host. Like any web request, smx.space sees your IP address.

Details: the id file can also live in `$XDG_CONFIG_HOME/smx-mcp/` or `$SMX_MCP_CONFIG_DIR`; delete it to get a new id. Hosted
HTTP mode (`--http`) uses one random id per server process, prefixed `hosted-`, and a per-process id prefixed
`ephemeral-` is used if the file cannot be written. Without `SMX_MCP_TELEMETRY=1` only `X-SMX-Client` is sent. The headers
are added only when the request goes to https://smx.space: if `SMX_ORIGIN` points at another host they are not sent,
and redirects are followed hop by hop so a redirect to another host never carries them. On the SMX side these values
are logged next to a salted hash of the IP, never the raw IP.

## Licence and data
The code is MIT-licensed. The MIT licence covers this code only, not the data it returns. SMI and SMX data come from smx.space under its published terms (SMI: https://smx.space/smi/terms/). GCAT data is CC BY 4.0, modified by Space Markets. Provided as-is, without warranty. Not affiliated with or endorsed by SpaceX.

Publisher: Space Markets, Inc. Terms of Service: https://smx.space/terms.html (currently the SMX testnet notice). Privacy policy: not yet published; a link will be added here before listing. Use of SMX is not available to US persons or in restricted jurisdictions.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SMX_RPC` | `https://sepolia.base.org` | Base Sepolia RPC (chain id is checked; any other chain is refused) |
| `SMX_ORIGIN` | `https://smx.space` | SMX origin for SMI and agent API reads |
| `SMX_MCP_TELEMETRY` | off | `1` opts in to the install id and tool header (see above) |
| `SMX_MCP_CONFIG_DIR` | `~/.config/smx-mcp` | Where the install id is stored |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | HTTP mode |

## Develop and test

```bash
npm ci
npm run build
npm test              # unit checks, telemetry headers (local echo server), copy-rules check (free live reads)
npm run smoke         # stdio client: every free tool against live endpoints
npm run smoke:http    # HTTP transport: tools/list + two free calls
```

The copy check enforces: no old codename, "mock", "odds" or "mainnet" in any description; SMI descriptions avoid
settle/settlement/benchmark/live/real-time/reference rate/official/tradeable/signal; SMI outputs carry no price keys and
include the publisher and disclaimer; no payment wording or regulated-venue terms; no trading or resolve tools.

Links: https://smx.space/skill.md · https://smx.space/llms.txt · https://smx.space/openapi.yaml · https://smx.space/smi-api/skill.md
