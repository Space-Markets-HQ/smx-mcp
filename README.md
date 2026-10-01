# smx-mcp: SMX by Space Markets (testnet) MCP server

MCP server for **SMX**, the Space Markets venue for humans and agents, and the **Space Markets Index (SMI)**,
published by Space Markets, Inc. **Testnet only: Base Sepolia (chain id 84532).** Test tokens have no monetary value.

Two separate products, kept separate in every tool:

- **SMI** (`smi_*` tools): information on orbital launch activity and other space-sector data. SMI results never
  contain market prices. Data from GCAT (J. McDowell, planet4589.org/space/gcat), CC BY 4.0, modified by Space Markets.
  Not affiliated with or endorsed by SpaceX. Data only, not advice.
- **SMX event markets** (`smx_*` tools): testnet markets priced in test USDC. Read from the Base Sepolia contracts and
  the SMX agent API.

This server **cannot place, cancel or claim orders and never resolves markets.** Orders are signed by your own wallet;
`smx_trading_guide` returns the steps and `smx_check_cancel_safety` enforces the claim-before-cancel rule.

## Tools

| Tool | Cost | What it returns |
|---|---|---|
| `smi_get_latest` | free | Latest SMI print: headline (SMI Launch Cadence + formula) and a one-line summary per sub-index; `sub_index` returns one in full |
| `smi_get_methodology` | free | SMI methodology: version, change log, conflicts statement, headline formula, counting rules |
| `smx_list_markets` | free | SMX markets from the on-chain MarketRegistry (same listing rules as the agent API): state, status, outcome, bid/ask, YES midpoint, minimum order |
| `smx_get_market` | free | One market plus the resting order book aggregated by price level, contracts, links |
| `smx_trading_guide` | free | How to trade from your own wallet: steps, addresses, order rules, the claim-before-cancel rule |
| `smx_check_cancel_safety` | free | Unclaimed-fill check for your order ids (`fills(orderId, n)` for every batch, plus a `claim` simulation). `safeToCancel=false` means do not cancel |
| `smi_get_history` | $0.01 testnet USDC | SMI weekly launch counts for the year |
| `smi_get_launch` | $0.01 testnet USDC | One launch by GCAT id (e.g. `2026-221`) |
| `smi_get_print` | $0.01 testnet USDC | One archived SMI print (e.g. `2026-W39.r7`) |
| `smx_paid_list_markets` | $0.01 testnet USDC | Agent API `GET /agent/markets` |
| `smx_paid_get_market` | $0.01 testnet USDC | Agent API `GET /agent/markets/{id}` |
| `smx_paid_get_mid` | $0.01 testnet USDC | Agent API `GET /v1/markets/{id}/mid` |

All tools are annotated `readOnlyHint: true` and return `structuredContent` plus a one-line text summary.

### Paid tools (x402, testnet USDC, no real value)

Paid tools pay $0.01 in **Circle testnet USDC on Base Sepolia** via x402 from **your own** wallet key in
`X402_PRIVATE_KEY`. This package never contains a key. Without the variable, paid tools make no request and explain
how to set one up. Before signing, the server checks the 402 challenge: network must be `eip155:84532`, asset Circle
testnet USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, receiver `0x5799fe0715C04f479f7f80Fbe6C4CFb384A8E0e9`, and
amount at most 10000 atomic units ($0.01). Anything else is refused unsigned. Errors (400/404) are not charged.

Use a fresh **test** wallet (never one with real funds) and get Circle testnet USDC from https://faucet.circle.com
(choose Base Sepolia).

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
      "args": ["-y", "smx-mcp"],
      "env": { "X402_PRIVATE_KEY": "0xYOUR_BASE_SEPOLIA_TEST_KEY_optional" }
    }
  }
}
```

Leave out `env` to use only the free tools.

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "smx": {
      "command": "npx",
      "args": ["-y", "smx-mcp"],
      "env": { "X402_PRIVATE_KEY": "${env:X402_PRIVATE_KEY}" }
    }
  }
}
```

### Any MCP client

- **stdio:** command `npx`, args `["-y", "smx-mcp"]`, optional env `X402_PRIVATE_KEY`.
- **Streamable HTTP:** run `npx -y smx-mcp --http 8787` and point the client at `http://localhost:8787/mcp`
  (stateless, JSON responses). Paid tools are off over HTTP unless `SMX_MCP_HTTP_PAID=1` is set, so a hosted
  server never pays from its own wallet for callers. `GET /health` for checks.
- **Claude Code:** `claude mcp add smx -- npx -y smx-mcp`
- **MCP Inspector:** `npx @modelcontextprotocol/inspector node dist/index.js`

## Usage counting (anonymous) and opt-out

To count installs and calls per tool, requests this server makes **to smx.space** (the SMI API and the SMX agent
API) carry three headers. Nothing is sent to the Base Sepolia RPC or anywhere else, and chain-only tools send nothing.

| Header | Value | Sent |
|---|---|---|
| `X-SMX-Client` | `smx-mcp/<version>` | always |
| `X-SMX-Install` | random install id (UUID v4) | unless `SMX_MCP_TELEMETRY=0` |
| `X-SMX-Tool` | the tool that made the request, e.g. `smi_get_latest` | unless `SMX_MCP_TELEMETRY=0` |

- The install id is generated at random on first run and stored in `~/.config/smx-mcp/install-id`
  (or `$XDG_CONFIG_HOME/smx-mcp/`, or `$SMX_MCP_CONFIG_DIR`). It contains no personal data and is not derived from
  your machine, user name, wallet or IP. Delete the file to get a new id.
- **Opt out:** set `SMX_MCP_TELEMETRY=0`. No id is created, read or sent, and the tool header is dropped; only
  `X-SMX-Client` remains.
- **Hosted HTTP mode** (`--http`) uses one random id per server process, prefixed `hosted-`, so callers of a hosted
  server are never told apart.
- If the id file cannot be written, a per-process id prefixed `ephemeral-` is used.
- On the SMX side these values are logged next to a salted hash of the IP (never the raw IP), as for every request.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `X402_PRIVATE_KEY` (or `SMX_X402_PRIVATE_KEY`) | unset | Your own Base Sepolia test key for paid tools |
| `SMX_RPC` | `https://sepolia.base.org` | Base Sepolia RPC (chain id is checked; any other chain is refused) |
| `SMX_ORIGIN` | `https://smx.space` | SMX origin for SMI and agent API reads |
| `SMX_X402_MAX_ATOMIC` | `10000` | Per-call payment cap in atomic USDC units |
| `SMX_MCP_TELEMETRY` | on | `0` drops the install id and tool header (see above) |
| `SMX_MCP_CONFIG_DIR` | `~/.config/smx-mcp` | Where the install id is stored |
| `SMX_MCP_HTTP_PAID` | unset | `1` enables paid tools over HTTP (private single-user deployments only) |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | HTTP mode |

## Develop and test

```bash
npm ci
npm run build
npm test              # unit checks, telemetry headers (local echo server), copy-rules check (free live reads, no payments)
npm run smoke         # stdio client: every free tool against live endpoints
npm run smoke:http    # HTTP transport: tools/list + two free calls; asserts paid tools are off
node test/smoke.mjs --paid   # 2 paid calls ($0.02 testnet USDC) + one 404 that must not be charged
```

The copy check enforces: no old codename, "mock", "odds" or "mainnet" in any description; SMI descriptions avoid
settle/settlement/benchmark/live/real-time/reference rate/official/tradeable/signal; SMI outputs carry no price keys and
include the publisher and disclaimer; paid tools say "testnet USDC, no real value"; no trading or resolve tools.

Links: https://smx.space/skill.md · https://smx.space/llms.txt · https://smx.space/openapi.yaml · https://smx.space/smi-api/skill.md
