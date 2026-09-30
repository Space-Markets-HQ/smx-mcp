// Copy rules check (CI-able). Lists every tool in-process (paid tools included) and calls the free tools against
// live endpoints, then asserts the copy rules. No payments: X402 keys are removed from the environment first.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
delete process.env.X402_PRIVATE_KEY; delete process.env.SMX_X402_PRIVATE_KEY;
const { createServer, INSTRUCTIONS } = await import("../dist/server.js");
const { SMI_FORBIDDEN, GLOBAL_FORBIDDEN } = await import("../dist/copy.js");

const [a, b] = InMemoryTransport.createLinkedPair();
const server = createServer({ paidTools: true });
await server.connect(a);
const client = new Client({ name: "copy-check", version: "0" });
await client.connect(b);
const { tools } = await client.listTools();
const fails = [];
const word = (w) => new RegExp(`(^|[^a-z])${w.replace(/[-]/g, "[- ]?")}([^a-z]|$)`, "i");
const check = (cond, msg) => { if (!cond) fails.push(msg); };

for (const w of GLOBAL_FORBIDDEN) check(!word(w).test(INSTRUCTIONS), `instructions contain "${w}"`);
for (const t of tools) {
  const text = `${t.title ?? ""} ${t.description ?? ""} ${JSON.stringify(t.inputSchema)}`;
  for (const w of GLOBAL_FORBIDDEN) check(!word(w).test(text), `${t.name}: description contains "${w}"`);
  check(t.annotations?.readOnlyHint === true, `${t.name}: not readOnlyHint`);
  if (t.name.startsWith("smi_")) {
    for (const w of SMI_FORBIDDEN) check(!word(w).test(text), `${t.name}: SMI description contains "${w}"`);
    check(/Space Markets, Inc\./.test(t.description), `${t.name}: missing publisher "Space Markets, Inc."`);
    check(!/trade|order|market price|midpoint|bid|ask\b/i.test(t.description.replace(/no market prices/i, "")), `${t.name}: SMI description mixes in SMX market wording`);
  }
  if (/paid|history|launch|print/.test(t.name) && t.name !== "smi_get_latest") check(/testnet USDC, no real value/.test(t.description), `${t.name}: paid tool missing "testnet USDC, no real value"`);
}
check(!tools.some((t) => /place|cancel_order|submit|resolve|claim_/.test(t.name)), "a trading/resolve tool is exposed");

const calls = [
  ["smi_get_latest", {}], ["smi_get_latest", { sub_index: "launch_access" }], ["smi_get_latest", { sub_index: "compute_energy" }],
  ["smi_get_methodology", {}], ["smx_list_markets", { include_unlisted: true }], ["smx_get_market", { id: "moon-race-us-china-test-v2" }],
  ["smx_trading_guide", {}], ["smi_get_history", {}],
];
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  const s = JSON.stringify(r);
  check(!new RegExp(["pre", "dix"].join(""), "i").test(s), `${name} output contains the old codename`);
  if (name.startsWith("smi_")) {
    const keys = []; const walk = (v) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(r.structuredContent ?? {});
    check(!keys.some((k) => /price|bid|ask|mid/i.test(k) && !/^(mid|midweek)$/.test(k)), `${name}: SMI output has a price-like key (${keys.filter((k) => /price|bid|ask|mid/i.test(k)).join(",")})`);
    if (!r.isError) check(/Space Markets, Inc\./.test(s) && /Data only, not advice/.test(s), `${name}: SMI output missing publisher/disclaimer`);
  }
  if (name === "smi_get_history") check(r.isError && /no call was made/.test(s), "paid tool without key did not refuse cleanly");
  if (name.startsWith("smx_") && !r.isError) check(/"testnet":\s*true/.test(JSON.stringify(r.structuredContent)), `${name}: missing testnet:true`);
}
await client.close();
if (fails.length) { console.error(`COPY CHECK FAILED (${fails.length}):\n- ${fails.join("\n- ")}`); process.exit(1); }
console.log(`copy check OK: ${tools.length} tools, ${calls.length} live calls`);
