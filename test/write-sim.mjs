// LIVE Base Sepolia simulation of every unsigned tx the write tools build (eth_call / eth_simulateV1 /
// estimateGas only; nothing is signed or sent; no keys anywhere). Wallets are used as `from` addresses only.
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAddress, generatePrivateKey } from "viem/accounts";
process.env.SMX_MCP_TELEMETRY = "0";
const { buildOrder, buildCancel, buildClaim } = await import("../dist/order-build.js");
const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.SMX_RPC ?? "https://sepolia.base.org", { retryCount: 3 }) });
const results = [];
const strip = (t) => ({ to: t.to, data: t.data, value: 0n });

async function simSequence(label, from, txs) {
  const onchain = txs.filter((t) => !t.offchain);
  // eth_simulateV1: runs the steps in order on one state (deposit before submit, etc).
  let seq;
  try {
    const r = await pub.simulateCalls({ account: from, calls: onchain.map(strip) });
    seq = r.results.map((x, i) => ({ step: onchain[i].step, status: x.status, gasUsed: x.gasUsed?.toString(), error: x.error?.shortMessage?.split("\n")[0] }));
  } catch (e) { seq = [{ error: `eth_simulateV1 unavailable: ${String(e.shortMessage ?? e.message).split("\n")[0]}` }]; }
  // First step standalone: eth_call + estimateGas.
  let first = null;
  if (onchain[0]) {
    try { await pub.call({ account: from, ...strip(onchain[0]) }); const g = await pub.estimateGas({ account: from, ...strip(onchain[0]) }); first = { step: onchain[0].step, ethCall: "ok", estimateGas: g.toString() }; }
    catch (e) { first = { step: onchain[0].step, ethCall: `revert: ${String(e.shortMessage ?? e.message).split("\n")[0]}` }; }
  }
  results.push({ label, from, steps: txs.map((t) => t.step), firstStep: first, sequence: seq });
  return seq;
}

const MKT = process.env.SIM_MARKET ?? "sw-g1-2026-10-14-test";
// A) brand-new wallet (random address, key discarded immediately; never funded, never used to sign).
const fresh = privateKeyToAddress(generatePrivateKey());
const a = await buildOrder({ id: MKT, outcome: "Yes", action: "buy", qty: 20, limitPrice: 5, wallet: fresh });
assert.ok(a.ok, JSON.stringify(a.err));
assert.deepEqual(a.data.transactions.map((t) => t.step), ["requestAccess", "approveAccess", "deployAccount", "mintTestUsdc"]);
const sa = await simSequence("fresh wallet: onboarding", fresh, a.data.transactions.filter((t) => t.step !== "deployAccount"));
// deployAccount must revert NotApproved until the off-chain approve lands: prove that by eth_call.
let dep = "ok"; try { await pub.call({ account: fresh, ...strip(a.data.transactions.find((t) => t.step === "deployAccount")) }); } catch (e) { dep = String(e.shortMessage ?? e.message).split("\n")[0]; }
results.push({ label: "fresh wallet: deployAccount before approval (expected revert NotApproved)", result: dep });

// B) existing SMX wallet with an Account (SMX test wallet, used only as `from`).
const W = process.env.SIM_WALLET ?? "0x7f07522a704233ac6Cf773f6301f60793Aeb0c07";
for (const [outcome, action, qty, px] of [["Yes", "buy", 20, 5], ["No", "buy", 20, 5], ["Yes", "sell", 20, 95], ["Yes", "buy", 5000000, 50]]) {
  const b = await buildOrder({ id: MKT, outcome, action, qty, limitPrice: px, wallet: W });
  assert.ok(b.ok, JSON.stringify(b.err));
  assert.equal(b.data.transactions.at(-1).step, "submitOrder");
  const s = await simSequence(`existing account: ${action} ${qty} ${outcome} @ ${px}c (${b.data.costs.depositMicroUsdc} micro deposit)`, W, b.data.transactions);
  if (!s[0].error?.startsWith("eth_simulateV1")) assert.ok(s.every((x) => x.status === "success"), JSON.stringify(s));
}

// C) closed market refusal (FCC close moved into the past via env config).
process.env.SMX_MARKET_CLOSES_JSON = JSON.stringify({ [MKT]: "2020-01-01T00:00:00Z" });
const c = await buildOrder({ id: MKT, outcome: "Yes", action: "buy", qty: 20, limitPrice: 5, wallet: W });
assert.equal(c.ok, false); assert.equal(c.err.error, "market_closed");
results.push({ label: "closed via closes config", result: c.err.error });
delete process.env.SMX_MARKET_CLOSES_JSON;

// D) claim + cancel builders against the same wallet's real orders.
const H = process.env.SIM_CLAIM_WALLET ?? "0x5799fe0715C04f479f7f80Fbe6C4CFb384A8E0e9"; // SMX house test wallet, `from` only
const cl = await buildClaim({ id: process.env.SIM_CLAIM_MARKET ?? "moon-race-us-china-test-v2", wallet: H });
results.push({ label: "build_claim", ok: cl.ok, err: cl.err?.error, claims: cl.ok ? cl.data.transactions.length : 0, checked: cl.ok ? cl.data.orderIdsChecked.length : 0, skipped: cl.ok ? cl.data.skipped.length : 0 });
if (cl.ok && cl.data.transactions.length) await simSequence("claims", H, cl.data.transactions);

{
  const cc = await buildCancel({ id: process.env.SIM_CANCEL_MARKET ?? "moon-race-us-china-test-v2", wallet: H, orderId: Number(process.env.SIM_CANCEL_ORDER ?? 6) });
  results.push({ label: "build_cancel", ok: cc.ok, err: cc.err, steps: cc.ok ? cc.data.transactions.map((t) => t.step) : [] });
  if (cc.ok) await simSequence("cancel (claims first)", H, cc.data.transactions);
  const wrong = await buildCancel({ id: "moon-race-us-china-test-v2", wallet: W, orderId: 6 });
  assert.equal(wrong.err?.error === "not_order_owner" || wrong.err?.error === "no_account", true);
  results.push({ label: "cancel someone else's order", result: wrong.err?.error });
}
console.log(JSON.stringify(results, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log("write sim OK");
