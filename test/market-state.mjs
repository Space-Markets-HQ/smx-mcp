// Closed, paused, resolved and expired markets return a structured error with state and reason.
// Offline: trading helpers are pure; the MCP cases mock fetch and never touch the network.
import assert from "node:assert/strict";
process.env.SMX_MCP_TELEMETRY = "0";
process.env.SMX_RPC = "http://127.0.0.1:9";

const { chainTrading, chainRowRefusal, interpretUpstreamMarketError, tradingRefusal } = await import("../dist/trading.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/server.js");

const now = Date.parse("2026-10-09T00:00:00Z");
const at = (sec) => new Date(sec * 1000).toISOString();

const closed = tradingRefusal("closed-mkt", {
  status: "closed", open: false, closeAt: "2026-01-01T00:00:00.000Z", halted: null, source: "smx-api",
});
assert.equal(closed.error, "market_closed");
assert.equal(closed.state, "closed");
assert.equal(closed.reason, "market closed at 2026-01-01T00:00:00.000Z");
assert.match(closed.message, /^Trading on closed-mkt closed at 2026-01-01/);

const paused = tradingRefusal("pause-mkt", {
  status: "halted", open: false, closeAt: null, halted: { reason: "paused", haltedAt: "2026-10-01T00:00:00.000Z" }, source: "smx-api",
});
assert.equal(paused.error, "market_paused");
assert.equal(paused.state, "paused");
assert.equal(paused.reason, "market paused");

const resolvedChain = chainTrading({ resolutionDate: now / 1000 + 3600, state: 1 }, now);
assert.equal(resolvedChain.status, "closed");
const resolved = tradingRefusal("res-mkt", resolvedChain);
assert.equal(resolved.error, "market_resolved");
assert.equal(resolved.state, "resolved");
assert.equal(resolved.reason, `market resolved at ${at(now / 1000 + 3600)}`);

const expiredChain = chainTrading({ resolutionDate: now / 1000 - 1, state: 0 }, now);
assert.equal(expiredChain.status, "closed");
const expired = tradingRefusal("exp-mkt", expiredChain);
assert.equal(expired.error, "market_expired");
assert.equal(expired.state, "expired");
assert.equal(expired.reason, `market expired at ${at(now / 1000 - 1)}`);

assert.equal(chainRowRefusal("open-mkt", { state: 0, resolutionDate: now / 1000 + 3600 }, now), null);
const rowResolved = chainRowRefusal("res-mkt", { state: 1, resolved: true, resolutionDate: now / 1000 + 3600 }, now);
assert.equal(rowResolved.state, "resolved");
assert.notEqual(rowResolved.message, "res-mkt is not open on chain.");
const rowExpired = chainRowRefusal("exp-mkt", { state: 0, resolutionDate: now / 1000 - 60 }, now);
assert.equal(rowExpired.state, "expired");
assert.match(rowExpired.reason, /^market expired at /);

assert.equal(interpretUpstreamMarketError({ error: "upstream broke", code: "unavailable" }), null);
assert.equal(interpretUpstreamMarketError({ error: "unknown market", code: "unknown_market" }), null);
const fromText = interpretUpstreamMarketError({ error: "market closed at 2026-01-01T00:00:00.000Z", code: "error" });
assert.equal(fromText.code, "market_closed");
assert.equal(fromText.state, "closed");
assert.equal(fromText.reason, "market closed at 2026-01-01T00:00:00.000Z");
assert.equal(interpretUpstreamMarketError({ error: "market paused", code: "market_paused" }).reason, "market paused");
assert.equal(interpretUpstreamMarketError({ error: "market resolved", code: "market_resolved" }).state, "resolved");
assert.equal(interpretUpstreamMarketError({ error: "market expired at 2026-02-02T00:00:00.000Z", code: "market_expired" }).reason, "market expired at 2026-02-02T00:00:00.000Z");
assert.equal(interpretUpstreamMarketError({ error: "bad request: opens are closed right now (close_only_session)", code: "market_closed" }).reason, "market closed (close_only_session)");

const TRADING = {
  "closed-mkt": { status: "closed", open: false, closeAt: "2026-01-01T00:00:00.000Z", closeSource: "config", halted: null },
  "pause-mkt": { status: "paused", open: false, closeAt: null, halted: null, paused: { pausedAt: "2026-10-01T00:00:00.000Z" } },
};
const PERPS = {
  "PERP-CLOSED": { error: "market closed at 2026-01-01T00:00:00.000Z", code: "market_closed" },
  "PERP-PAUSE": { error: "market paused", code: "market_paused" },
  "PERP-RESOLVED": { error: "market resolved", code: "market_resolved" },
  "PERP-EXPIRED": { error: "market expired at 2026-02-02T00:00:00.000Z", code: "market_expired" },
  "PERP-GENERIC": { error: "upstream broke", code: "unavailable" },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const trading = u.match(/\/agent\/trading\/([^/?]+)$/);
  if (trading) {
    const body = TRADING[decodeURIComponent(trading[1])];
    return new Response(JSON.stringify(body ?? { error: "unknown_market" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
  }
  if (u.includes("/perps/v0/quote")) {
    const market = new URL(u).searchParams.get("market");
    const body = PERPS[market] ?? { error: "unknown market", code: "unknown_market" };
    return new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, init);
};

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: "market-state-check", version: "0" });
await client.connect(b);

function payload(r) {
  assert.equal(r.isError, true);
  assert.ok(r.structuredContent, "error is missing structuredContent");
  const text = r.content[0].text;
  assert.match(text, new RegExp(`^${r.structuredContent.error}: `));
  return r.structuredContent;
}

const guideClosed = payload(await client.callTool({ name: "smx_trading_guide", arguments: { id: "closed-mkt" } }));
assert.equal(guideClosed.state, "closed");
assert.equal(guideClosed.reason, "market closed at 2026-01-01T00:00:00.000Z");
assert.match(guideClosed.message, /^Trading on closed-mkt closed at 2026-01-01/);

const guidePaused = payload(await client.callTool({ name: "smx_trading_guide", arguments: { id: "pause-mkt" } }));
assert.equal(guidePaused.state, "paused");
assert.equal(guidePaused.reason, "market paused");
assert.match(guidePaused.message, /^market paused$/);

for (const [market, state, reason] of [
  ["PERP-CLOSED", "closed", "market closed at 2026-01-01T00:00:00.000Z"],
  ["PERP-PAUSE", "paused", "market paused"],
  ["PERP-RESOLVED", "resolved", "market resolved"],
  ["PERP-EXPIRED", "expired", "market expired at 2026-02-02T00:00:00.000Z"],
]) {
  const got = payload(await client.callTool({ name: "perps_quote", arguments: { market, side: "long", size_musdc: 10 } }));
  assert.equal(got.state, state, market);
  assert.equal(got.reason, reason, market);
  assert.equal(got.error, `market_${state}`, market);
}

const generic = await client.callTool({ name: "perps_quote", arguments: { market: "PERP-GENERIC", side: "long", size_musdc: 10 } });
assert.equal(generic.isError, true);
assert.match(generic.content[0].text, /^unavailable: upstream broke/);
assert.notEqual(generic.structuredContent?.state, "closed");
assert.notEqual(generic.structuredContent?.state, "paused");

await client.close();
globalThis.fetch = realFetch;
console.log("market state errors OK");
