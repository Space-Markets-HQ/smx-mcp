// Registry list: offline de-dupe and listing rules, then a live Base Sepolia check.
// Set SMX_SKIP_CHAIN=1 to run only the offline half.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { parseRegistryList, DEFAULT_MARKET_REGISTRIES, CONTRACTS } = await import("../dist/config.js");
const { dedupeMarkets, listingDecisions } = await import("../dist/listing.js");
const { pickMarket } = await import("../dist/chain.js");

const FIRST = "0x8F3B0Ae76690ef0972aD3Cf9010797d266FcDa4a";
const SECOND = "0xcD293b4B311845C023772CDd8738849E1a274AcD";
const TWINS = [
  "TEST-V7-SS2LIFT-31DEC26",
  "TEST-V7-SS2LIFT-31JAN27",
  "TEST-V7-SS2LIFT-28FEB27",
  "TEST-V7-SSFLA-31JAN27",
  "TEST-V7-SSFLA-31MAR27",
  "TEST-V7-SHIPCATCH-31MAR27",
  "TEST-V7-SHIPCATCH-30JUN27",
  "TEST-V8-SS2LIFT-31MAR27",
  "TEST-V8-SSFLA-30APR27",
  "TEST-V8-SHIPCATCH-31JAN27",
];

assert.equal(SECOND.startsWith("0xcD29") && SECOND.endsWith("4AcD"), true);
assert.deepEqual([...DEFAULT_MARKET_REGISTRIES], [FIRST, SECOND]);
assert.deepEqual(parseRegistryList(undefined), [FIRST, SECOND]);
assert.deepEqual(parseRegistryList(""), [FIRST, SECOND]);
assert.deepEqual(parseRegistryList("nope, 0x1234"), [FIRST, SECOND]);
assert.deepEqual(parseRegistryList(FIRST), [FIRST]);
assert.deepEqual(parseRegistryList(`  ${SECOND.toLowerCase()} , ${SECOND} , ${FIRST} `), [SECOND, FIRST]);
if (!process.env.SMX_REGISTRIES) assert.deepEqual([...CONTRACTS.marketRegistries], [FIRST, SECOND]);

const twinRows = TWINS.map((marketId, i) => ({
  index: i, marketId, state: 0, resolutionDate: 9e9, bestBid: 0, bestAsk: 10001, nextOrderId: 0,
}));
const quiet = { index: 50, marketId: "quiet-book", state: 0, resolutionDate: 9e9, bestBid: 0, bestAsk: 0, nextOrderId: 0 };
const kept = { index: 51, marketId: "moon-race-us-china-test-v2", state: 0, resolutionDate: 9e9, bestBid: 4800, bestAsk: 5200, nextOrderId: 4 };
const decisions = listingDecisions([...twinRows, quiet, kept], 1_000_000_000);
for (const [i, id] of TWINS.entries()) assert.equal(decisions.get(i).listed, true, id);
assert.equal(decisions.get(50).excludedReason, "never-traded");
assert.equal(decisions.get(51).listed, true);

const dup = dedupeMarkets([
  { marketId: "same", registry: FIRST, index: 0, idWellFormed: true, book: "old" },
  { marketId: "only-old", registry: FIRST, index: 1, idWellFormed: true, book: "keep" },
  { marketId: "same", registry: SECOND.toLowerCase(), index: 2, idWellFormed: true, book: "new" },
  { marketId: "only-new", registry: SECOND, index: 3, idWellFormed: true, book: "twin" },
  { marketId: "bad", registry: FIRST, index: 4, idWellFormed: false, book: "m1" },
  { marketId: "bad", registry: SECOND, index: 5, idWellFormed: false, book: "m2" },
], [FIRST, SECOND]);
assert.deepEqual(dup.map((r) => r.book), ["keep", "new", "twin", "m1", "m2"]);

const chosen = pickMarket([
  { marketId: "same", listing: { listed: false, excludedReason: "superseded", detail: "older book" }, book: "old" },
  { marketId: "same", listing: { listed: true }, book: "new" },
  { marketId: "hidden", listing: { listed: false, excludedReason: "internal-codename", detail: "n" }, book: "no" },
], "same");
assert.equal(chosen.book, "new");
assert.equal(pickMarket([{ marketId: "hidden", listing: { listed: false, excludedReason: "internal-codename", detail: "n" } }], "hidden"), undefined);

for (const name of ["README.md", "CHANGELOG.md"]) {
  const text = readFileSync(name, "utf8");
  assert.match(text, /live on testnet/i, name);
  assert.doesNotMatch(text, /launching/i, name);
}

if (process.env.SMX_SKIP_CHAIN === "1") {
  console.log("registries OK (offline; chain check skipped)");
  process.exit(0);
}

const { allMarkets, registryReadStatus } = await import("../dist/chain.js");
const { buildOrder } = await import("../dist/order-build.js");
const { createServer } = await import("../dist/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const rows = await allMarkets();
const read = registryReadStatus();
assert.deepEqual(read.errors, [], read.errors.join("; "));
assert.ok(read.registries.includes(FIRST) && read.registries.includes(SECOND), read.registries.join(","));
const well = rows.filter((r) => r.idWellFormed !== false);
assert.equal(well.length, new Set(well.map((r) => r.marketId)).size, "duplicate well-formed market id");
const listed = new Map(rows.filter((r) => r.listing.listed).map((r) => [r.marketId, r]));
const existing = listed.get("moon-race-us-china-test-v2");
assert.ok(existing, "existing market missing");
assert.equal(existing.registry, FIRST);
for (const id of TWINS) {
  const r = listed.get(id);
  assert.ok(r, `not listed: ${id}`);
  assert.equal(r.registry, SECOND, id);
  assert.match(r.bookAddr, /^0x[0-9a-fA-F]{40}$/, id);
}
const quoted = listed.get("TEST-V7-SS2LIFT-31DEC26");
assert.equal(pickMarket(rows, quoted.marketId).bookAddr, quoted.bookAddr);

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer().connect(a);
const client = new Client({ name: "registries", version: "0" });
await client.connect(b);
const body = (r) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return r.structuredContent;
};

const listBody = body(await client.callTool({ name: "smx_list_markets", arguments: {} }));
assert.match(listBody.source, new RegExp(FIRST));
assert.match(listBody.source, new RegExp(SECOND));
const ids = listBody.markets.map((m) => m.id);
for (const id of TWINS) assert.ok(ids.includes(id), `list missing ${id}`);
assert.ok(ids.includes("moon-race-us-china-test-v2"));
assert.ok(!ids.includes("starship-reflight-mar27-test"));
assert.equal(new Set(ids).size, ids.length, "listed ids are not unique");
const listedTwin = listBody.markets.find((m) => m.id === "TEST-V7-SS2LIFT-31DEC26");
assert.equal(listedTwin.registry, SECOND);
assert.equal(listedTwin.orderBook, quoted.bookAddr);

const oneBody = body(await client.callTool({ name: "smx_get_market", arguments: { id: "TEST-V7-SS2LIFT-31DEC26" } }));
assert.equal(oneBody.registry, SECOND);
assert.equal(oneBody.orderBook, quoted.bookAddr);
assert.equal(oneBody.contracts.marketRegistry, SECOND);
const expectBid = quoted.bestBid > 0 ? quoted.bestBid : null;
assert.equal(oneBody.bestBidBps, expectBid);
assert.equal(oneBody.testnet, true);

const v8 = body(await client.callTool({ name: "smx_get_market", arguments: { id: "TEST-V8-SS2LIFT-31MAR27" } }));
assert.equal(v8.registry, SECOND);
assert.match(v8.priceSource, /midpoint|bid-only|ask-only|unquoted/);

const bookBody = body(await client.callTool({ name: "smx_get_book", arguments: { id: "TEST-V7-SS2LIFT-31DEC26" } }));
assert.equal(String(bookBody.book).toLowerCase(), quoted.bookAddr.toLowerCase());
assert.equal(typeof bookBody.bestBid, "number");
assert.ok(Array.isArray(bookBody.bids) && Array.isArray(bookBody.asks));

const clearsBody = body(await client.callTool({ name: "smx_get_clears", arguments: { id: "TEST-V7-SS2LIFT-31DEC26", limit: 5 } }));
assert.ok(Array.isArray(clearsBody.trades));

const built = await buildOrder({
  id: "TEST-V7-SS2LIFT-31DEC26",
  outcome: "Yes",
  action: "buy",
  qty: 200,
  limitPrice: 50,
  wallet: "0x0000000000000000000000000000000000000001",
  mintTestUsdc: false,
});
assert.equal(built.ok, true, built.ok ? "" : `${built.err.error}: ${built.err.message}`);
assert.equal(built.data.orderBook, quoted.bookAddr);
assert.equal(built.data.marketId, "TEST-V7-SS2LIFT-31DEC26");
assert.ok(built.data.transactions.length >= 1);
for (const tx of built.data.transactions) {
  if (tx.offchain) continue;
  assert.equal(tx.chainId, 84532);
  assert.equal(tx.value, "0x0");
  assert.match(tx.data, /^0x/);
}
const submit = built.data.transactions.find((t) => t.step === "submitOrder");
if (submit) assert.ok(submit.data.toLowerCase().includes(quoted.bookAddr.slice(2).toLowerCase()));

const oldBuilt = await buildOrder({
  id: "moon-race-us-china-test-v2",
  outcome: "Yes",
  action: "buy",
  qty: 200,
  limitPrice: 50,
  wallet: "0x0000000000000000000000000000000000000001",
  mintTestUsdc: false,
});
assert.equal(oldBuilt.ok, true, oldBuilt.ok ? "" : `${oldBuilt.err.error}: ${oldBuilt.err.message}`);
assert.equal(oldBuilt.data.orderBook, existing.bookAddr);

await client.close();
const lines = TWINS.map((id) => {
  const r = listed.get(id);
  return `${id} bid ${r.bestBid} ask ${r.bestAsk} book ${r.bookAddr}`;
});
console.log(`registries OK: ${TWINS.length} twins live on testnet from ${SECOND}\n${lines.join("\n")}`);
