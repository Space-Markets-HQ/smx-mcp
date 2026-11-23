// Offline launch-cap checks. The caps API is not deployed; fetch is stubbed. No secrets, no chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
process.env.SMX_MCP_TELEMETRY = "0";
process.env.SMX_RPC = "http://127.0.0.1:9";

const { CAPS_TIMEOUT_MS, capsCheck, capsCheckUrl, fetchLaunchCaps } = await import("../dist/trading.js");
const { LAUNCH_CAPS_NOTE } = await import("../dist/copy.js");
const { orderReads, buildOrder } = await import("../dist/order-build.js");
const { clearRulesCache } = await import("../dist/rules.js");
const { serverReads, createServer } = await import("../dist/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

assert.equal(CAPS_TIMEOUT_MS, 4_000);
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert.ok(readme.includes(LAUNCH_CAPS_NOTE), "README is missing the launch-caps paragraph");
assert.match(readme, /not on chain/);
assert.doesNotMatch(readme, /launching/i);
assert.doesNotMatch(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), /launching/i);

const WALLET = "0x0000000000000000000000000000000000000001";
const LIMITS = { walletUsdc: 25, marketOiUsdc: 500 };
const checkBody = (extra) => ({ enabled: true, allowed: true, kind: null, walletUsedUsdc: 0, marketOiUsdc: 10, limits: LIMITS, ...extra });

const realFetch = globalThis.fetch;
let seen = [];
function installFetch(capsFor) {
  seen = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seen.push(u);
    assert.ok(init?.signal, "caps and trading reads must set a timeout signal");
    if (u.includes("/agent/trading/")) return Response.json({ status: "open", open: true, closeAt: null, halted: null });
    if (/\/agent\/caps\/[^/?]+\/0x/i.test(u)) return capsFor(u);
    if (/\/agent\/caps\/?$/.test(u)) return Response.json({ enabled: true, walletUsdc: 25, marketOiUsdc: 500, counting: "orders" });
    return new Response("no", { status: 404 });
  };
}

const row = {
  index: 0,
  marketId: "cap-mkt",
  state: 0,
  resolutionDate: Math.floor(Date.now() / 1000) + 86400 * 30,
  bestBid: 4800,
  bestAsk: 5200,
  nextOrderId: 3,
  marketAddr: "0x0000000000000000000000000000000000000002",
  bookAddr: "0x0000000000000000000000000000000000000003",
  registry: "0x8F3B0Ae76690ef0972aD3Cf9010797d266FcDa4a",
  title: "cap-mkt",
  listing: { listed: true },
};
const realFind = orderReads.findRow;
const realRead = orderReads.readContract;
orderReads.findRow = async () => row;
orderReads.readContract = async ({ functionName }) => {
  if (functionName === "access") return 2;
  if (functionName === "accountOf") return "0x0000000000000000000000000000000000000004";
  if (functionName === "availableBalance") return 10n ** 18n;
  return 0n;
};

const order = (outcome) => buildOrder({
  id: "cap-mkt", outcome, action: "buy", qty: 20, limitPrice: 40, wallet: WALLET, mintTestUsdc: false,
});

try {
  installFetch(() => Response.json(checkBody({ allowed: true, kind: null })));
  const allowedDirect = await capsCheck("cap-mkt", WALLET, "yes", 40, 20);
  assert.deepEqual(allowedDirect, { ok: true, capsUnknown: false });
  assert.ok(seen.some((u) => u === capsCheckUrl("cap-mkt", WALLET, "yes", 40, 20)));
  const allowed = await order("Yes");
  assert.equal(allowed.ok, true, JSON.stringify(allowed.err));
  assert.equal(allowed.data.capsUnknown, false);
  assert.equal(allowed.data.transactions.some((t) => t.step === "submitOrder"), true);

  installFetch(() => Response.json(checkBody({ allowed: false, kind: "wallet", walletUsedUsdc: 25 })));
  const walletCap = await order("Yes");
  assert.equal(walletCap.ok, false);
  assert.equal(walletCap.err.error, "cap_exceeded");
  assert.equal(walletCap.err.kind, "wallet");
  assert.equal(walletCap.err.charged, false);
  assert.deepEqual(walletCap.err.limits, LIMITS);
  assert.equal(walletCap.data, undefined);
  assert.equal(JSON.stringify(walletCap).includes("submitOrder"), false);

  installFetch(() => Response.json(checkBody({ allowed: false, kind: "market_oi", marketOiUsdc: 500 })));
  const oiCap = await order("No");
  assert.equal(oiCap.ok, false);
  assert.equal(oiCap.err.error, "cap_exceeded");
  assert.equal(oiCap.err.kind, "market_oi");
  assert.equal(oiCap.err.charged, false);
  assert.deepEqual(oiCap.err.limits, LIMITS);
  assert.equal(JSON.stringify(oiCap).includes("submitOrder"), false);
  assert.ok(seen.some((u) => u.includes("side=no&price=40&qty=20")));

  installFetch(() => { throw new Error("offline"); });
  const downDirect = await capsCheck("cap-mkt", WALLET, "yes", 40, 20);
  assert.deepEqual(downDirect, { ok: true, capsUnknown: true });
  const down = await order("Yes");
  assert.equal(down.ok, true, JSON.stringify(down.err));
  assert.equal(down.data.capsUnknown, true);
  assert.equal(down.data.transactions.some((t) => t.step === "submitOrder"), true);

  installFetch(() => new Response("missing", { status: 404 }));
  const missing = await order("Yes");
  assert.equal(missing.ok, true, JSON.stringify(missing.err));
  assert.equal(missing.data.capsUnknown, true);
  assert.equal(missing.data.transactions.some((t) => t.step === "submitOrder"), true);

  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal(await fetchLaunchCaps(), null);
  globalThis.fetch = async (url) => {
    if (String(url).includes("/agent/caps")) return Response.json({ enabled: false, walletUsdc: 1, marketOiUsdc: 2, counting: "off" });
    return new Response("no", { status: 404 });
  };
  assert.equal(await fetchLaunchCaps(), null);
  globalThis.fetch = async (url) => {
    if (/\/agent\/caps\/?$/.test(String(url))) return Response.json({ enabled: true, walletUsdc: 25, marketOiUsdc: 500, counting: "orders" });
    return new Response("no", { status: 404 });
  };
  assert.deepEqual(await fetchLaunchCaps(), { enabled: true, walletUsdc: 25, marketOiUsdc: 500 });
} finally {
  orderReads.findRow = realFind;
  orderReads.readContract = realRead;
  globalThis.fetch = realFetch;
}

const listed = {
  ...row,
  nextOrderId: 0,
};
const realAll = serverReads.allMarkets;
const realDepth = serverReads.bookDepth;
serverReads.allMarkets = async () => [listed];
serverReads.bookDepth = async () => ({ bids: [], asks: [], activeOrdersScanned: 0 });
clearRulesCache();

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: "caps-check", version: "0" });
await client.connect(b);
try {
  const guide = await client.callTool({ name: "smx_trading_guide", arguments: {} });
  assert.notEqual(guide.isError, true);
  assert.equal(guide.structuredContent.launchCaps, LAUNCH_CAPS_NOTE);

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/\/agent\/caps\/?$/.test(u)) return Response.json({ enabled: true, walletUsdc: 25, marketOiUsdc: 500, counting: "orders" });
    if (u.includes("/agent/trading")) return Response.json({ markets: {} });
    return new Response("no", { status: 404 });
  };
  clearRulesCache();
  const list = await client.callTool({ name: "smx_list_markets", arguments: {} });
  assert.notEqual(list.isError, true, list.content?.[0]?.text);
  assert.deepEqual(list.structuredContent.markets[0].launchCaps, { enabled: true, walletUsdc: 25, marketOiUsdc: 500 });
  const one = await client.callTool({ name: "smx_get_market", arguments: { id: "cap-mkt" } });
  assert.notEqual(one.isError, true, one.content?.[0]?.text);
  assert.deepEqual(one.structuredContent.launchCaps, { enabled: true, walletUsdc: 25, marketOiUsdc: 500 });

  globalThis.fetch = async () => new Response("missing", { status: 404 });
  clearRulesCache();
  const bare = await client.callTool({ name: "smx_list_markets", arguments: {} });
  assert.equal(bare.structuredContent.markets[0].launchCaps, undefined);
} finally {
  serverReads.allMarkets = realAll;
  serverReads.bookDepth = realDepth;
  globalThis.fetch = realFetch;
  clearRulesCache();
  await client.close();
}

console.log("caps OK: allowed, wallet cap, open-interest cap, unreachable and 404");
