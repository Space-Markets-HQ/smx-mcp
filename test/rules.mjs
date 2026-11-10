// Rules link and short rules text on smx_list_markets and smx_get_market.
// Offline: indexer field mapping, 60s cache, 4s timeout, and a down indexer.
// Live (Base Sepolia + the SMX indexer): TEST-V8-F15SHIPCATCH-30NOV26, then the same
// tools again with the indexer call failing. A down indexer must not fail the tool.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const F15 = "TEST-V8-F15SHIPCATCH-30NOV26";
const F15_URL = "https://smx.space/app/markets/TEST-V8-F15SHIPCATCH-30NOV26";
const MOON = "moon-race-us-china-test-v2";

const { SERVER_VERSION, MARKET_QUESTIONS, rulesUrlFor } = await import("../dist/config.js");
const { RULES_SOURCE, clearRulesCache, fetchRules, ruleFromIndexerMarket, rulesFromBody } = await import("../dist/rules.js");
const { createServer } = await import("../dist/server.js");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const srv = JSON.parse(readFileSync("server.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
assert.equal(pkg.version, "0.2.3");
assert.equal(SERVER_VERSION, "0.2.3");
assert.equal(srv.version, "0.2.3");
assert.equal(srv.packages[0].version, "0.2.3");
assert.equal(lock.version, "0.2.3");
assert.equal(lock.packages[""].version, "0.2.3");
assert.match(readFileSync("CHANGELOG.md", "utf8"), /## 0\.2\.3 — 2026-11-10/);

assert.equal(rulesUrlFor(F15), F15_URL);
assert.equal(rulesUrlFor("a b/c"), "https://smx.space/app/markets/a%20b%2Fc");
assert.equal(RULES_SOURCE, "https://smx-indexer-preview.fly.dev/v1/markets");

const whyOnly = ruleFromIndexerMarket({
  id: F15, why: "WHY TEXT", question: "Q from indexer", tradingEnd: "2026-11-30T23:59:00Z",
});
assert.equal(whyOnly.rule.rules, "WHY TEXT");
assert.equal(whyOnly.rule.rulesHash, null);
assert.equal(whyOnly.rule.close, "2026-11-30T23:59:00Z");
assert.equal(whyOnly.rule.question, "Q from indexer");
assert.equal(whyOnly.rule.rulesVersion, null);

const v3 = ruleFromIndexerMarket({
  id: F15,
  why: "WHY TEXT",
  question: "Q from indexer",
  tradingEnd: "2026-11-30T23:59:00Z",
  rulesHash: "hash-top",
  rules: { summary: "SUMMARY", hash: "hash-nested", close: "2026-11-30T22:00:00Z", version: 3 },
});
assert.equal(v3.rule.rules, "SUMMARY");
assert.equal(v3.rule.rulesHash, "hash-top");
assert.equal(v3.rule.close, "2026-11-30T22:00:00Z");
assert.equal(v3.rule.question, "Q from indexer");
assert.equal(v3.rule.rulesVersion, 3);

const nestedHash = ruleFromIndexerMarket({ id: "other", why: "w", rules: { hash: "nested-only", summary: "s", version: "v3" } });
assert.equal(nestedHash.rule.rules, "s");
assert.equal(nestedHash.rule.rulesHash, "nested-only");
assert.equal(nestedHash.rule.rulesVersion, "v3");

const blankSummary = ruleFromIndexerMarket({ id: F15, why: "WHY TEXT", rules: { summary: "  " } });
assert.equal(blankSummary.rule.rules, "WHY TEXT");
assert.equal(ruleFromIndexerMarket({ why: "missing id" }), null);
assert.equal(ruleFromIndexerMarket(null), null);
assert.equal(rulesFromBody({ nope: true }), null);
assert.equal(rulesFromBody({ markets: [{ why: "x" }, { id: F15, why: "WHY TEXT" }] }).size, 1);

const realFetch = globalThis.fetch;
function isRulesList(url) {
  try {
    const u = new URL(String(url));
    const want = new URL(RULES_SOURCE);
    return u.origin === want.origin && u.pathname === want.pathname;
  } catch { return false; }
}
async function underFetch(impl, fn) {
  clearRulesCache();
  globalThis.fetch = impl;
  try { return await fn(); }
  finally { globalThis.fetch = realFetch; clearRulesCache(); }
}

let calls = 0;
await underFetch(async (url, init) => {
  if (!isRulesList(url)) return realFetch(url, init);
  calls++;
  return Response.json({ markets: [{ id: F15, why: "WHY TEXT", question: "Q from indexer", tradingEnd: "2026-11-30T23:59:00Z" }] });
}, async () => {
  const a = await fetchRules(1_000);
  const b = await fetchRules(1_000 + 59_999);
  assert.equal(calls, 1, "60s cache");
  assert.equal(a, b);
  assert.equal(a.get(F15).rules, "WHY TEXT");
  assert.equal(await fetchRules(1_000 + 60_000).then((m) => m.get(F15).rules), "WHY TEXT");
  assert.equal(calls, 2, "cache expires at 60s");
});

await underFetch(async (url, init) => {
  if (!isRulesList(url)) return realFetch(url, init);
  return Response.json({
    markets: [{
      id: F15, why: "WHY TEXT", tradingEnd: "2026-11-30T23:59:00Z", rulesHash: "hash-top",
      rules: { summary: "SUMMARY", hash: "hash-nested", close: "2026-11-30T22:00:00Z", version: 3 },
    }],
  });
}, async () => {
  const row = (await fetchRules()).get(F15);
  assert.equal(row.rules, "SUMMARY");
  assert.equal(row.rulesHash, "hash-top");
  assert.equal(row.close, "2026-11-30T22:00:00Z");
  assert.equal(row.rulesVersion, 3);
});

await underFetch(async (url, init) => {
  if (isRulesList(url)) throw new Error("indexer down");
  return realFetch(url, init);
}, async () => {
  assert.equal((await fetchRules()).size, 0);
});

let mode = "down";
calls = 0;
await underFetch(async (url, init) => {
  if (!isRulesList(url)) return realFetch(url, init);
  calls++;
  if (mode === "down") return new Response(JSON.stringify({ error: "down" }), { status: 503, headers: { "content-type": "application/json" } });
  return Response.json({ markets: [{ id: F15, why: "WHY TEXT" }] });
}, async () => {
  assert.equal((await fetchRules()).size, 0);
  mode = "up";
  assert.equal((await fetchRules()).get(F15).rules, "WHY TEXT");
  assert.equal(calls, 2, "a failed indexer read is not cached");
});

await underFetch(async (url, init) => {
  if (!isRulesList(url)) return realFetch(url, init);
  return new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } });
}, async () => {
  assert.equal((await fetchRules()).size, 0);
});

await underFetch(async (url, init) => {
  if (!isRulesList(url)) return realFetch(url, init);
  return new Promise((resolve, reject) => {
    const signal = init?.signal;
    const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}, async () => {
  const started = Date.now();
  const map = await Promise.race([
    fetchRules(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("rules timeout was not applied")), 8_000)),
  ]);
  const elapsed = Date.now() - started;
  assert.equal(map.size, 0);
  assert.ok(elapsed >= 3_500 && elapsed < 7_500, `indexer timeout elapsed ${elapsed}ms`);
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await createServer().connect(serverTransport);
const client = new Client({ name: "rules-check", version: "0" });
await client.connect(clientTransport);
const { tools } = await client.listTools();
for (const name of ["smx_list_markets", "smx_get_market"]) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, name);
  assert.match(tool.description, /rules link and short rules text/);
}

function body(r) {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return r.structuredContent;
}
function assertRulesShape(m, { rules }) {
  assert.equal(m.rulesUrl, rulesUrlFor(m.id), m.id);
  assert.equal(m.rulesSource, RULES_SOURCE, m.id);
  assert.equal(m.rules, rules, m.id);
  assert.equal(m.rulesHash, null, m.id);
  assert.equal(m.rulesClose, null, m.id);
}

await underFetch(async (url, init) => {
  if (isRulesList(url)) throw new Error("indexer down");
  return realFetch(url, init);
}, async () => {
  const list = body(await client.callTool({ name: "smx_list_markets", arguments: {} }));
  const f15 = list.markets.find((m) => m.id === F15);
  assert.ok(f15, "F15 missing while the indexer is down");
  for (const m of list.markets) assertRulesShape(m, { rules: null });
  const moon = list.markets.find((m) => m.id === MOON);
  assert.ok(moon, "moon race missing while the indexer is down");
  assert.equal(moon.question, MARKET_QUESTIONS[MOON]);
  const one = body(await client.callTool({ name: "smx_get_market", arguments: { id: F15 } }));
  assert.equal(one.rules, null);
  assert.equal(one.rulesHash, null);
  assert.equal(one.rulesClose, null);
  assert.equal(one.rulesUrl, F15_URL);
  assert.equal(one.rulesSource, RULES_SOURCE);
  assert.equal(one.links.rules, F15_URL);
  assert.equal(one.testnet, true);
});

clearRulesCache();
const indexed = await fetchRules();
const expectF15 = indexed.get(F15);
assert.equal(typeof expectF15?.rules, "string");
assert.ok(expectF15.rules.length > 0, "F15 rules text");
const one = body(await client.callTool({ name: "smx_get_market", arguments: { id: F15 } }));
assert.equal(one.rulesUrl, F15_URL);
assert.equal(one.rules, expectF15.rules);
assert.equal(one.rulesHash, expectF15.rulesHash);
assert.equal(one.rulesClose, expectF15.close);
assert.equal(one.rulesSource, RULES_SOURCE);
assert.equal(one.links.rules, F15_URL);
assert.equal(one.question, expectF15.question ?? MARKET_QUESTIONS[F15] ?? null);
assert.equal(one.testnet, true);
assert.equal(one.network, "base-sepolia");

const list = body(await client.callTool({ name: "smx_list_markets", arguments: {} }));
const listed = list.markets.find((m) => m.id === F15);
assert.ok(listed, "F15 missing from smx_list_markets");
assert.equal(listed.rules, expectF15.rules);
assert.equal(listed.rulesHash, expectF15.rulesHash);
assert.equal(listed.rulesClose, expectF15.close);
assert.equal(listed.rulesUrl, F15_URL);
assert.equal(listed.question, one.question);
for (const m of list.markets) {
  const row = indexed.get(m.id);
  assert.equal(m.rulesUrl, rulesUrlFor(m.id), m.id);
  assert.equal(m.rulesSource, RULES_SOURCE, m.id);
  assert.equal(m.rules, row?.rules ?? null, m.id);
  assert.equal(m.rulesHash, row?.rulesHash ?? null, m.id);
  assert.equal(m.rulesClose, row?.close ?? null, m.id);
  assert.equal(m.question, row?.question ?? MARKET_QUESTIONS[m.id] ?? null, m.id);
}
const moon = list.markets.find((m) => m.id === MOON);
assert.ok(moon);
assert.equal(moon.question, indexed.get(MOON)?.question ?? MARKET_QUESTIONS[MOON]);

await client.close();
console.log(`rules OK: F15 rulesUrl ${F15_URL}, rules ${expectF15.rules.length} chars, hash ${expectF15.rulesHash}, close ${expectF15.close}`);
