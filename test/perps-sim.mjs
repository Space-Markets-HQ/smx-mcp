// LIVE read-only sim: perps_build_order via MCP, then eth_call/estimateGas each returned tx (never sent).
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
process.env.SMX_MCP_TELEMETRY = "0";
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/server.js");
const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const [a, b] = InMemoryTransport.createLinkedPair();
await createServer({ paidTools: false }).connect(a);
const c = new Client({ name: "perps-sim", version: "0" }); await c.connect(b);
const W = process.env.SIM_WALLET ?? "0x7f07522a704233ac6Cf773f6301f60793Aeb0c07";
const out = [];
for (const args of [
  { action: "faucet", amount_musdc: 100, address: W },
  { action: "open", market: "PERP-A", side: "long", margin_musdc: 10, leverage: 2, address: W },
  { action: "open", market: "PERP-XRAY", side: "short", margin_musdc: 10, leverage: 2, address: W },
  { action: "open", market: "PERP-NOPE", side: "long", margin_musdc: 10, address: W },
]) {
  const r = await c.callTool({ name: "perps_build_order", arguments: args });
  const d = r.structuredContent ?? {};
  const row = { args: `${args.action} ${args.market ?? ""}`, isError: !!r.isError, code: r.isError ? r.content[0].text.split(":")[0] : undefined, txs: [] };
  let calls = (d.transactions ?? []).map((t) => ({ to: t.to, data: t.data, value: BigInt(t.value ?? 0) }));
  let sim; try { sim = (await pub.simulateCalls({ account: W, calls })).results.map((x) => x.status + (x.error ? ` ${x.error.shortMessage?.split("\n")[0]}` : "")); } catch (e) { sim = [`simulateV1 err ${e.shortMessage}`]; }
  for (const [i, t] of (d.transactions ?? []).entries()) {
    assert.equal(Number(t.chainId ?? 84532), 84532);
    row.txs.push({ step: t.step ?? t.label ?? i, to: t.to, seq: sim[i] });
  }
  out.push(row);
}
console.log(JSON.stringify(out, null, 1));
await c.close();
