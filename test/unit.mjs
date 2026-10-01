// Offline unit checks: x402 challenge policy, SMI price stripping, listing policy.
import assert from "node:assert/strict";
const { requirementOk } = await import("../dist/x402.js");
const { stripPrices } = await import("../dist/smi.js");
const { listingDecisions, midOf } = await import("../dist/listing.js");
const good = { scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x5799fe0715C04f479f7f80Fbe6C4CFb384A8E0e9", amount: "10000" };
assert.equal(requirementOk(good), null);
assert.match(requirementOk({ ...good, network: "eip155:8453" }), /not eip155:84532/); // Base mainnet refused
assert.match(requirementOk({ ...good, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), /not Circle testnet USDC/);
assert.match(requirementOk({ ...good, payTo: "0x000000000000000000000000000000000000dEaD" }), /not the SMX receiver/);
assert.match(requirementOk({ ...good, amount: "10001" }), /exceeds/);
assert.deepEqual(stripPrices({ a: 1, list_price: 2, nested: [{ priceUsd: 3, b: 4 }] }), { a: 1, nested: [{ b: 4 }] });
const d = listingDecisions([
  { index: 0, marketId: "x-v1", state: 0, resolutionDate: 9e9, bestBid: 0, bestAsk: 0, nextOrderId: 3 },
  { index: 1, marketId: "x-v2", state: 0, resolutionDate: 9e9, bestBid: 0, bestAsk: 0, nextOrderId: 3 },
  { index: 2, marketId: "y-drill-1", state: 0, resolutionDate: 9e9, bestBid: 0, bestAsk: 0, nextOrderId: 3 },
], 1e9);
assert.equal(d.get(1).listed, true); assert.equal(d.get(0).excludedReason, "superseded"); assert.equal(d.get(2).excludedReason, "drill");
assert.equal(midOf({ state: 0, bestBid: 0, bestAsk: 10001 }).midBps, null); // empty book: no fake 50c
assert.equal(midOf({ state: 0, bestBid: 4800, bestAsk: 5200 }).midBps, 5000);
console.log("unit OK");
