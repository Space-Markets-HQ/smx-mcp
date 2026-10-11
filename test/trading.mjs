// Offline trading cut-off checks: the MCP order path (smx_trading_guide with a market id) refuses
// closed and halted markets with market_closed / market_halted. SMX API mocked; no network.
import assert from "node:assert/strict";
process.env.SMX_MCP_TELEMETRY = "0";
process.env.SMX_RPC = "http://127.0.0.1:9"; // any chain read fails fast
const { chainTrading, tradingRefusal } = await import("../dist/trading.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/server.js");

// Chain fallback: closed at/after resolutionDate or when resolved; open before.
const now = Date.parse("2026-10-09T00:00:00Z");
assert.equal(chainTrading({ resolutionDate: now / 1000 - 1, state: 0 }, now).status, "closed");
assert.equal(chainTrading({ resolutionDate: now / 1000 + 3600, state: 0 }, now).status, "open");
assert.equal(chainTrading({ resolutionDate: now / 1000 + 3600, state: 1 }, now).status, "closed");
assert.equal(tradingRefusal("m", chainTrading({ resolutionDate: now / 1000 + 3600, state: 0 }, now)), null);
assert.equal(tradingRefusal("m", { status: "halted", open: false, closeAt: null, halted: { reason: "r", haltedAt: "t" }, source: "smx-api" }).error, "market_halted");

const API = {
  "closed-mkt": { status: "closed", open: false, closeAt: "2026-01-01T00:00:00.000Z", closeSource: "config", halted: null },
  "halt-mkt": { status: "halted", open: false, closeAt: "2099-01-01T00:00:00.000Z", closeSource: "config", halted: { reason: "outcome known", haltedAt: "2026-10-09T08:00:00.000Z" } },
};
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = u.match(/\/agent\/trading\/([^/?]+)$/);
  if (m) {
    seen.push(u);
    const body = API[decodeURIComponent(m[1])];
    return new Response(JSON.stringify(body ?? { error: "unknown_market" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, init);
};

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer({ paidTools: false }).connect(a);
const client = new Client({ name: "trading-cutoff-check", version: "0" });
await client.connect(b);

const closed = await client.callTool({ name: "smx_trading_guide", arguments: { id: "closed-mkt" } });
assert.equal(closed.isError, true);
assert.match(closed.content[0].text, /^market_closed: Trading on closed-mkt closed at 2026-01-01/);
assert.doesNotMatch(closed.content[0].text, /submitOrder\(orderBook/);

const halted = await client.callTool({ name: "smx_trading_guide", arguments: { id: "halt-mkt" } });
assert.equal(halted.isError, true);
assert.match(halted.content[0].text, /^market_halted: .*outcome known/);

// No id: the general guide still works and carries the cut-off rule.
const guide = await client.callTool({ name: "smx_trading_guide", arguments: {} });
assert.notEqual(guide.isError, true);
assert.match(guide.content[0].text, /tradingCutoff/);

assert.ok(seen.some((u) => u.endsWith("/agent/trading/closed-mkt")) && seen.some((u) => u.endsWith("/agent/trading/halt-mkt")));
await client.close();
globalThis.fetch = realFetch;
console.log("trading cut-off OK: MCP refuses closed (market_closed) and halted (market_halted) markets");
