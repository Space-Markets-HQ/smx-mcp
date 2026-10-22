// Offline unit checks: SMI price stripping, listing policy.
import assert from "node:assert/strict";
const { stripPrices } = await import("../dist/smi.js");
const { listingDecisions, midOf } = await import("../dist/listing.js");
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
