// Offline read-only guarantee (CI-able, no network): no tool can place, cancel or claim orders, or send any transaction.
// 1) The built code never creates a wallet client or calls a write/send method.
// 2) Every contract ABI function is a view, except OrderBook.claim, which is only ever passed to simulateContract (eth_call).
// 3) The only signing is the x402 payment authorization for paid reads (user's own key, Base Sepolia, $0.01 cap; see unit.mjs).
// 4) No tool name or input schema accepts an order, side, price/qty to submit, or a private key.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const dist = readdirSync("dist").filter((f) => f.endsWith(".js")).map((f) => [f, readFileSync(`dist/${f}`, "utf8")]);
const WRITE = /\b(createWalletClient|writeContract|sendTransaction|sendRawTransaction|eth_sendTransaction|eth_sendRawTransaction|deployContract|signTransaction)\b/;
for (const [f, src] of dist) assert.ok(!WRITE.test(src), `dist/${f} contains a write/send call: ${src.match(WRITE)?.[0]}`);

const chain = readFileSync("src/chain.ts", "utf8");
const abiFns = [...chain.matchAll(/"function ([A-Za-z0-9_]+)\(([^"]*)"/g)].map((m) => ({ name: m[1], sig: m[0] }));
assert.ok(abiFns.length > 10, "ABI parse failed");
const nonView = abiFns.filter((f) => !/\) view returns/.test(f.sig));
assert.deepEqual(nonView.map((f) => f.name), ["claim"], `unexpected non-view ABI functions: ${nonView.map((f) => f.name)}`);
const claimUses = [...chain.matchAll(/functionName: "claim"/g)].length;
const claimSim = [...chain.matchAll(/simulateContract\(\{[^}]*functionName: "claim"/g)].length;
assert.equal(claimUses, claimSim, "OrderBook.claim is used outside simulateContract");
for (const [f, src] of dist) assert.ok(!/submitOrder|cancelOrder|clearBatch|claimSettlement|resolve\(/.test(src.replace(/call: "[^"]*"|"[^"]*(submitOrder|cancelOrder|clearBatch|claimSettlement)[^"]*"/g, "")), `dist/${f} references a trading call outside guide text`);

delete process.env.X402_PRIVATE_KEY; delete process.env.SMX_X402_PRIVATE_KEY;
const { createServer } = await import("../dist/server.js");
const [a, b] = InMemoryTransport.createLinkedPair();
await createServer({ paidTools: true }).connect(a);
const client = new Client({ name: "read-only-check", version: "0" });
await client.connect(b);
const { tools } = await client.listTools();
for (const t of tools) {
  assert.ok(!/place|submit|cancel_order|order_create|claim_|resolve|trade|transfer|approve|deposit|withdraw/i.test(t.name), `${t.name}: looks like a write tool`);
  assert.equal(t.annotations?.readOnlyHint, true, `${t.name}: readOnlyHint`);
  assert.equal(t.annotations?.destructiveHint, false, `${t.name}: destructiveHint`);
  const props = Object.keys(t.inputSchema?.properties ?? {});
  assert.ok(!props.some((p) => /side|qty|quantity|price|private|key|signature|amount/i.test(p)), `${t.name}: write-like input ${props}`);
}
await client.close();
console.log(`read-only OK: ${tools.length} tools, ${abiFns.length} ABI functions (non-view: claim, simulate only), no write calls in dist/`);
