// Offline checks for the unsigned write tools (no network).
import assert from "node:assert/strict";
process.env.SMX_MCP_TELEMETRY = "0";
process.env.SMX_RPC = "http://127.0.0.1:9";
const { orderMath, validateOrder, idBytes32, FEE_RATE_BPS } = await import("../dist/order-build.js");
const { configuredClose } = await import("../dist/closes.js");
const { WRITE_TOOL_DEFS } = await import("../dist/write-tools.js");

assert.equal(FEE_RATE_BPS, 25n);
// Buy 100 Yes @ 40c: escrow 40 USDC, max fee 0.25% x 100 x 0.60 = 0.15 USDC.
let m = orderMath("Yes", "buy", 100, 40);
assert.equal(m.userSide, 0); assert.equal(m.collateralMicro, 40_000_000n); assert.equal(m.maxFeeMicro, 150_000n);
// Buy 100 No @ 40c = internal Sell Yes @ 60c: escrow 40 USDC, fee 0.25% x 100 x 0.60.
m = orderMath("No", "buy", 100, 40);
assert.equal(m.userSide, 2); assert.equal(m.internalSide, "Sell"); assert.equal(m.internalPriceBps, 6000); assert.equal(m.collateralMicro, 40_000_000n); assert.equal(m.maxFeeMicro, 150_000n);
assert.equal(orderMath("Yes", "sell", 1, 30).userSide, 1); assert.equal(orderMath("No", "sell", 1, 30).userSide, 3);
assert.equal(validateOrder(0, 50).error, "invalid_qty"); assert.equal(validateOrder(1, 0).error, "invalid_price"); assert.equal(validateOrder(1, 100).error, "invalid_price"); assert.equal(validateOrder(1.5, 50).error, "invalid_qty"); assert.equal(validateOrder(10, 50), null);
assert.equal(idBytes32("ab"), "0x6162" + "0".repeat(60));
assert.equal(configuredClose("fcc-25mhz-fnprm-oct29-test"), "2026-10-28T14:30:00.000Z");
process.env.SMX_MARKET_CLOSES_JSON = '{"x":"2026-01-01T00:00:00Z"}';
assert.equal(configuredClose("x"), "2026-01-01T00:00:00.000Z");
delete process.env.SMX_MARKET_CLOSES_JSON;
assert.deepEqual(Object.keys(WRITE_TOOL_DEFS), ["smx_build_order", "smx_build_cancel", "smx_build_claim"]);
for (const d of Object.values(WRITE_TOOL_DEFS)) { assert.match(d.description, /UNSIGNED/); assert.ok(!Object.keys(d.inputSchema).some((k) => /key|private|signature/i.test(k))); }

// Through MCP: invalid input and closed market are refused before any chain read.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = await import("../dist/server.js");
const [a, b] = InMemoryTransport.createLinkedPair();
await createServer({ paidTools: false }).connect(a);
const client = new Client({ name: "write-tools-check", version: "0" });
await client.connect(b);
const names = (await client.listTools()).tools.map((t) => t.name);
for (const n of Object.keys(WRITE_TOOL_DEFS)) assert.ok(names.includes(n), n);
const W = "0x7f07522a704233ac6Cf773f6301f60793Aeb0c07";
const r = await client.callTool({ name: "smx_build_order", arguments: { id: "x", outcome: "Yes", action: "buy", qty: 0, limitPrice: 50, wallet: W } });
assert.equal(r.isError, true);
await client.close();
console.log("write tools OK (offline): fee 0.25%, side/price translation, closes config, schemas");
