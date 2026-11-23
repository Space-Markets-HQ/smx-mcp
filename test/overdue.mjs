// Overdue books stay listed. Offline: no chain, no secrets. Trading end comes from fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.SMX_MCP_TELEMETRY = "0";
process.env.SMX_RPC = "http://127.0.0.1:9";

const { listingDecisions, marketPresentation, OVERDUE_LABEL } = await import("../dist/listing.js");
const { overdueBookRefusal } = await import("../dist/trading.js");
const { orderReads, buildOrder } = await import("../dist/order-build.js");
const { clearRulesCache } = await import("../dist/rules.js");
const { serverReads, createServer } = await import("../dist/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
assert.match(readme, /Trading end is enforced by the SMX app and API/);
assert.match(readme, /Overdue: awaiting resolution/);
assert.match(changelog, /Trading end is enforced by the SMX app and API/);
assert.doesNotMatch(readme, /launching/i);
assert.doesNotMatch(changelog, /launching/i);

const fixed = 1_700_000_000;
const day = 86400;
const eightDaysAgo = fixed - 8 * day;
const chain = (index, marketId, extra) => ({
  index, marketId, state: 0, resolutionDate: eightDaysAgo, bestBid: 1000, bestAsk: 2000, nextOrderId: 4, ...extra,
});
const decisions = listingDecisions([
  chain(0, "open-overdue"),
  chain(1, "done-mkt", { state: 1, resolved: true, finalPrice: 10000 }),
  chain(2, "ops-drill-1"),
  chain(3, "quiet-old", { nextOrderId: 0 }),
], fixed);
assert.equal(decisions.get(0).listed, true, "Open book 8 days past its resolution date stays listed");
assert.equal(decisions.get(1).listed, true);
assert.equal(decisions.get(2).listed, false);
assert.equal(decisions.get(2).excludedReason, "drill");
assert.equal(decisions.get(3).excludedReason, "never-traded");

// A past-resolution version stays listed and does not replace a version still before its resolution date.
const family = listingDecisions([
  { index: 0, marketId: "x", state: 0, resolutionDate: fixed + day, bestBid: 0, bestAsk: 0, nextOrderId: 2 },
  { index: 1, marketId: "x-v2", state: 0, resolutionDate: fixed + day, bestBid: 0, bestAsk: 0, nextOrderId: 2 },
  { index: 2, marketId: "x-v3", state: 0, resolutionDate: eightDaysAgo, bestBid: 0, bestAsk: 0, nextOrderId: 2 },
], fixed);
assert.equal(family.get(2).listed, true);
assert.equal(family.get(1).listed, true);
assert.equal(family.get(0).excludedReason, "superseded");

const noFeed = { api: null, indexerDueBy: null, indexerTradingEnd: null, configuredCloseAt: null };
const overdue = marketPresentation({ state: 0, resolutionDate: eightDaysAgo }, { nowMs: fixed * 1000, ...noFeed });
assert.equal(overdue.overdue, true);
assert.equal(overdue.status, "overdue");
assert.equal(overdue.displayLabel, OVERDUE_LABEL);
assert.equal(overdue.displayStatus, "Overdue: awaiting resolution");
assert.equal(overdue.dueBy, new Date(eightDaysAgo * 1000).toISOString());
assert.equal(overdue.hoursOverdue, 8 * 24);

const resolved = marketPresentation(
  { state: 1, resolved: true, resolutionDate: eightDaysAgo },
  { nowMs: fixed * 1000, ...noFeed },
);
assert.equal(resolved.displayStatus, "Resolved");
assert.equal(resolved.displayLabel, "Resolved");
assert.equal(resolved.status, "resolved");
assert.equal(resolved.overdue, false);
assert.equal(resolved.hoursOverdue, 0);

const apiDue = new Date((fixed - 2 * day) * 1000).toISOString();
const indexerDue = new Date((fixed - 3 * day) * 1000).toISOString();
const preferred = marketPresentation({ state: 0, resolutionDate: eightDaysAgo }, {
  nowMs: fixed * 1000,
  api: { status: "open", closeAt: new Date((fixed + day) * 1000).toISOString(), dueBy: apiDue },
  indexerDueBy: indexerDue,
  indexerTradingEnd: null,
  configuredCloseAt: null,
});
assert.equal(preferred.dueBy, apiDue);
assert.equal(preferred.hoursOverdue, 48);
assert.equal(preferred.displayStatus, OVERDUE_LABEL);

const fromIndexer = marketPresentation({ state: 0, resolutionDate: fixed + 10 * day }, {
  nowMs: fixed * 1000,
  api: null,
  indexerDueBy: indexerDue,
  indexerTradingEnd: new Date((fixed - day) * 1000).toISOString(),
  configuredCloseAt: null,
});
assert.equal(fromIndexer.overdue, true);
assert.equal(fromIndexer.dueBy, indexerDue);
assert.equal(fromIndexer.hoursOverdue, 72);
assert.equal(fromIndexer.status, "overdue");

const apiOpenIgnoresIndexerEnd = marketPresentation({ state: 0, resolutionDate: fixed + 10 * day }, {
  nowMs: fixed * 1000,
  api: { status: "open", closeAt: new Date((fixed + day) * 1000).toISOString(), dueBy: null },
  indexerDueBy: null,
  indexerTradingEnd: new Date((fixed - day) * 1000).toISOString(),
  configuredCloseAt: new Date((fixed - day) * 1000).toISOString(),
});
assert.equal(apiOpenIgnoresIndexerEnd.overdue, false);
assert.equal(apiOpenIgnoresIndexerEnd.displayLabel, "Open");

const halted = marketPresentation({ state: 0, resolutionDate: fixed + day }, {
  nowMs: fixed * 1000,
  api: { status: "halted", closeAt: new Date((fixed + day) * 1000).toISOString(), dueBy: null },
  indexerDueBy: null,
  indexerTradingEnd: null,
  configuredCloseAt: null,
});
assert.equal(halted.overdue, false);
assert.equal(halted.displayLabel, "Trading closed");
assert.equal(halted.displayStatus, "Trading closed");

assert.equal(overdueBookRefusal("soon", { state: 0, resolutionDate: fixed + day }, null, null, fixed * 1000), null);
const refused = overdueBookRefusal("open-overdue", { state: 0, resolutionDate: eightDaysAgo }, null, null, fixed * 1000);
assert.equal(refused.error, "market_closed");
assert.equal(refused.message, "Overdue: awaiting resolution");
assert.equal(overdueBookRefusal("done-mkt", { state: 1, resolved: true, resolutionDate: eightDaysAgo }, null, null, fixed * 1000), null);

const realFetch = globalThis.fetch;
const realFind = orderReads.findRow;
const baseRow = {
  index: 0,
  marketId: "open-overdue",
  state: 0,
  resolutionDate: Math.floor(Date.now() / 1000) - 8 * day,
  bestBid: 1000,
  bestAsk: 2000,
  nextOrderId: 4,
  marketAddr: "0x0000000000000000000000000000000000000002",
  bookAddr: "0x0000000000000000000000000000000000000003",
  registry: "0x8F3B0Ae76690ef0972aD3Cf9010797d266FcDa4a",
  title: "open-overdue",
  listing: { listed: true },
};
try {
  globalThis.fetch = async () => { throw new Error("offline"); };
  orderReads.findRow = async () => baseRow;
  const built = await buildOrder({
    id: "open-overdue", outcome: "Yes", action: "buy", qty: 10, limitPrice: 40,
    wallet: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(built.ok, false);
  assert.equal(built.err.error, "market_closed");
  assert.equal(built.err.message, OVERDUE_LABEL);
  assert.equal(built.data, undefined);
  assert.equal(JSON.stringify(built).includes("submitOrder"), false);

  orderReads.findRow = async () => ({ ...baseRow, marketId: "early-close", resolutionDate: Math.floor(Date.now() / 1000) + day });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/agent/trading/")) {
      return Response.json({ status: "closed", open: false, closeAt: new Date(Date.now() - 3600_000).toISOString(), halted: null });
    }
    return new Response("no", { status: 404 });
  };
  const early = await buildOrder({
    id: "early-close", outcome: "No", action: "buy", qty: 10, limitPrice: 40,
    wallet: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(early.ok, false);
  assert.equal(early.err.error, "market_closed");
  assert.equal(early.err.message, OVERDUE_LABEL);
  assert.equal(JSON.stringify(early).includes("submitOrder"), false);
} finally {
  orderReads.findRow = realFind;
  globalThis.fetch = realFetch;
}

const nowMs = Date.now();
const dueBy = new Date(nowMs - 48 * 3600_000).toISOString();
const tradingEnd = new Date(nowMs - 3600_000).toISOString();
const rows = [
  chain(0, "open-overdue", { resolutionDate: Math.floor(nowMs / 1000) - 8 * day }),
  chain(1, "done-mkt", { state: 1, resolved: true, finalPrice: 10000, resolutionDate: Math.floor(nowMs / 1000) - 8 * day }),
  chain(2, "ops-drill-1", { resolutionDate: Math.floor(nowMs / 1000) - 30 * day }),
  chain(3, "still-open", { resolutionDate: Math.floor(nowMs / 1000) + 10 * day }),
  chain(4, "end-passed", { resolutionDate: Math.floor(nowMs / 1000) + 10 * day }),
].map((r) => ({
  ...r,
  marketAddr: "0x0000000000000000000000000000000000000002",
  bookAddr: "0x0000000000000000000000000000000000000003",
  registry: "0x8F3B0Ae76690ef0972aD3Cf9010797d266FcDa4a",
  title: r.marketId,
  listing: listingDecisions([r], Math.floor(nowMs / 1000)).get(r.index),
}));
// listingDecisions reindexes by the single-element array's index, which is 0. Recompute as a group.
const grouped = listingDecisions(rows, Math.floor(nowMs / 1000));
for (const r of rows) r.listing = grouped.get(r.index);

const realAll = serverReads.allMarkets;
const realDepth = serverReads.bookDepth;
serverReads.allMarkets = async () => rows;
serverReads.bookDepth = async () => ({ bids: [], asks: [], activeOrdersScanned: 0 });
clearRulesCache();
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/\/agent\/trading\/?$/.test(u)) return Response.json({ markets: {} });
  const one = u.match(/\/agent\/trading\/([^/?]+)$/);
  if (one && decodeURIComponent(one[1]) === "closed-mkt") {
    return Response.json({ status: "closed", open: false, closeAt: "2026-01-01T00:00:00.000Z", halted: null });
  }
  if (one) return Response.json({ error: "unknown_market" }, { status: 404 });
  if (u.includes("/v1/markets")) {
    return Response.json({
      markets: [
        { id: "open-overdue", dueBy, why: "fixture" },
        { id: "end-passed", dueBy: tradingEnd, tradingEnd, why: "fixture" },
      ],
    });
  }
  return new Response("no", { status: 404 });
};

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: "overdue-check", version: "0" });
await client.connect(b);
try {
  const list = await client.callTool({ name: "smx_list_markets", arguments: {} });
  assert.notEqual(list.isError, true, list.content?.[0]?.text);
  const markets = list.structuredContent.markets;
  const ids = markets.map((m) => m.id);
  assert.equal(ids.includes("ops-drill-1"), false);
  const late = markets.find((m) => m.id === "open-overdue");
  assert.ok(late);
  assert.equal(late.status, "overdue");
  assert.equal(late.overdue, true);
  assert.equal(late.displayLabel, "Overdue: awaiting resolution");
  assert.equal(late.displayStatus, "Overdue: awaiting resolution");
  assert.equal(late.dueBy, dueBy);
  assert.ok(late.hoursOverdue >= 47.5 && late.hoursOverdue <= 48.5, `hoursOverdue ${late.hoursOverdue}`);
  const done = markets.find((m) => m.id === "done-mkt");
  assert.equal(done.displayStatus, "Resolved");
  assert.equal(done.displayLabel, "Resolved");
  assert.equal(done.status, "resolved");
  assert.equal(done.overdue, false);
  const open = markets.find((m) => m.id === "still-open");
  assert.equal(open.displayLabel, "Open");
  assert.equal(open.status, "open");
  const ended = markets.find((m) => m.id === "end-passed");
  assert.equal(ended.status, "overdue");
  assert.equal(ended.displayLabel, OVERDUE_LABEL);
  assert.equal(ended.dueBy, tradingEnd);
  assert.ok(ended.hoursOverdue >= 0.5 && ended.hoursOverdue <= 1.5, `end hours ${ended.hoursOverdue}`);

  const unlisted = await client.callTool({ name: "smx_list_markets", arguments: { include_unlisted: true } });
  const drill = unlisted.structuredContent.markets.find((m) => m.id === "ops-drill-1");
  assert.equal(drill.listed, false);
  assert.equal(drill.excludedReason, "drill");

  const one = await client.callTool({ name: "smx_get_market", arguments: { id: "open-overdue" } });
  assert.notEqual(one.isError, true, one.content?.[0]?.text);
  assert.equal(one.structuredContent.displayStatus, "Overdue: awaiting resolution");
  assert.equal(one.structuredContent.displayLabel, "Overdue: awaiting resolution");
  assert.equal(one.structuredContent.status, "overdue");
  assert.equal(one.structuredContent.dueBy, dueBy);

  const guide = await client.callTool({ name: "smx_trading_guide", arguments: { id: "open-overdue" } });
  assert.equal(guide.isError, true);
  assert.match(guide.content[0].text, /^market_closed: Overdue: awaiting resolution/);
  assert.doesNotMatch(guide.content[0].text, /submitOrder\(orderBook/);
  assert.equal(guide.structuredContent.message, OVERDUE_LABEL);

  const closed = await client.callTool({ name: "smx_trading_guide", arguments: { id: "closed-mkt" } });
  assert.equal(closed.isError, true);
  assert.match(closed.content[0].text, /^market_closed: Trading on closed-mkt closed at 2026-01-01/);
} finally {
  serverReads.allMarkets = realAll;
  serverReads.bookDepth = realDepth;
  globalThis.fetch = realFetch;
  clearRulesCache();
  await client.close();
}

console.log("overdue OK: 8-day Open book stays listed, resolved is Resolved, drill stays excluded");
