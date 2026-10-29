/**
 * Unsigned transaction builder for SMX event-market orders (Base Sepolia only).
 * This module NEVER signs, sends or holds keys: it reads chain state and returns {to, data, value, chainId}
 * for the user's own wallet to sign. Every tx targets the user's own SMX Account, the Factory,
 * test USDC or a registry-listed OrderBook.
 */
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { allMarkets, pickMarket, pub, type MarketRow } from "./chain.js";
import { CHAIN_ID, CONTRACTS, SMX_INDEXER, SMX_ORIGIN } from "./config.js";
import { configuredClose } from "./closes.js";
import { getJson } from "./fetch.js";
import { apiTrading, chainRowRefusal, chainTrading, tradingRefusal, type Trading, type TradingRefusal } from "./trading.js";

export const FEE_RATE_BPS = 25n; // 0.25%, Account.FEE_RATE_BPS on chain
export const PRICE_MAX = 10000n;
export const TICK_BPS = 100n;
export const USER_SIDE = { BuyYes: 0, SellYes: 1, BuyNo: 2, SellNo: 3 } as const;
export const GAS = { requestAccess: 120000n, deployAccount: 3500000n, mint: 150000n, approve: 100000n, deposit: 300000n, submitOrder: 600000n, cancelOrder: 900000n, claim: 900000n };

export const factoryAbi = parseAbi([
  "function access(address) view returns (uint8)",
  "function accountOf(address) view returns (address)",
  "function requestAccess()",
  "function deployAccount() returns (address)",
]);
export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
]);
export const accountAbi = parseAbi([
  "function owner() view returns (address)",
  "function submitOrder(address book, uint8 userSide, uint64 userPrice, uint128 qty) returns (uint256)",
  "function cancelOrder(address book, uint256 orderId)",
  "function deposit(uint256 amount)",
  "function availableBalance() view returns (uint256)",
  "function reserved() view returns (uint256)",
  "function reservedByMarket(bytes32) view returns (uint256)",
]);
export const obAbi = parseAbi([
  "function previewSubmit(address account, uint8 userSide, uint64 userPrice, uint128 qty) view returns (uint256)",
  "function orders(uint256) view returns (address trader, int128 quantity, uint64 price, uint64 submittedAt)",
  "function batchNonce() view returns (uint256)",
  "function fills(uint256 orderId, uint256 batchNonce) view returns (address trader, uint96 filledQty)",
  "function claim(uint256 orderId, uint256 batchNonce) returns (uint256 payout)",
]);

export type UnsignedTx = { step: string; to: Address; data: Hex; value: "0x0"; chainId: typeof CHAIN_ID; gas: string; note?: string };
export type OffchainStep = { step: string; offchain: true; method: "POST"; url: string; body: Record<string, unknown>; note: string };
export type BuildError = { error: string; message: string; [k: string]: unknown };

const tx = (step: string, to: Address, data: Hex, gas: bigint, note?: string): UnsignedTx => ({ step, to: getAddress(to), data, value: "0x0", chainId: CHAIN_ID, gas: `0x${gas.toString(16)}`, ...(note ? { note } : {}) });
const ZERO = "0x0000000000000000000000000000000000000000";

/** Pure order math (micro test USDC, 6 decimals). Price is in cents of the side bought/sold (1-99). */
export function orderMath(outcome: "Yes" | "No", action: "buy" | "sell", qty: number, priceCents: number) {
  const userSide = outcome === "Yes" ? (action === "buy" ? USER_SIDE.BuyYes : USER_SIDE.SellYes) : action === "buy" ? USER_SIDE.BuyNo : USER_SIDE.SellNo;
  const userPrice = BigInt(Math.round(priceCents * 100));
  // Internal (YES-terms) translation, identical to OrderBook._translate.
  const internalBuy = userSide === USER_SIDE.BuyYes || userSide === USER_SIDE.SellNo;
  const internalPrice = userSide <= 1 ? userPrice : PRICE_MAX - userPrice;
  const q = BigInt(qty);
  const collateralRaw = internalBuy ? q * internalPrice : q * (PRICE_MAX - internalPrice);
  const feeRaw = internalBuy ? (FEE_RATE_BPS * q * (PRICE_MAX - internalPrice)) / 10000n : (FEE_RATE_BPS * q * internalPrice) / 10000n;
  return { userSide, userPrice, internalSide: internalBuy ? "Buy" : "Sell", internalPriceBps: Number(internalPrice), collateralMicro: collateralRaw * 100n, maxFeeMicro: feeRaw * 100n, collateralRaw };
}

export function validateOrder(qty: number, priceCents: number): BuildError | null {
  if (!Number.isInteger(qty) || qty < 1) return { error: "invalid_qty", message: "qty must be a whole number of shares >= 1." };
  if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99) return { error: "invalid_price", message: "limitPrice is in cents, a whole number 1-99 (the contract's 1% grid)." };
  return null;
}

async function findRow(id: string): Promise<MarketRow | undefined> {
  return pickMarket(await allMarkets(), id);
}

/** Trading status for building orders: SMX API, else closes config, else chain. */
export async function tradingFor(id: string, row: MarketRow | undefined, nowMs = Date.now()): Promise<Trading> {
  const api = await apiTrading(id);
  if (api) return api;
  const chain = chainTrading(row, nowMs);
  const cfg = configuredClose(id);
  if (cfg && chain.status === "open" && Date.parse(cfg) <= nowMs) return { ...chain, status: "closed", open: false, closeAt: cfg, source: chain.source };
  return cfg ? { ...chain, closeAt: cfg } : chain;
}

export async function accountState(wallet: Address) {
  const [access, account] = await Promise.all([
    pub.readContract({ address: CONTRACTS.factory, abi: factoryAbi, functionName: "access", args: [wallet] }) as Promise<number>,
    pub.readContract({ address: CONTRACTS.factory, abi: factoryAbi, functionName: "accountOf", args: [wallet] }) as Promise<Address>,
  ]);
  return { access: Number(access), account: account && account !== ZERO ? getAddress(account) : null };
}

export type BuildOrderInput = { id: string; outcome: "Yes" | "No"; action: "buy" | "sell"; qty: number; limitPrice: number; wallet: string; mintTestUsdc?: boolean };

export async function buildOrder(inp: BuildOrderInput): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; err: BuildError | TradingRefusal }> {
  const bad = validateOrder(inp.qty, inp.limitPrice);
  if (bad) return { ok: false, err: bad };
  const wallet = getAddress(inp.wallet);
  const row = await findRow(inp.id);
  if (!row) return { ok: false, err: { error: "unknown_market", message: "Unknown market id. Call smx_list_markets for valid ids." } };
  const trading = await tradingFor(inp.id, row);
  const refused = tradingRefusal(inp.id, trading) ?? chainRowRefusal(inp.id, row);
  if (refused) return { ok: false, err: refused };

  const m = orderMath(inp.outcome, inp.action, inp.qty, inp.limitPrice);
  if (row.minOrderQty !== undefined && inp.qty < row.minOrderQty) return { ok: false, err: { error: "below_min_size", message: `Minimum order is ${row.minOrderQty} shares.` } };
  if (row.minOrderCollateralRaw !== undefined && m.collateralRaw < BigInt(row.minOrderCollateralRaw))
    return { ok: false, err: { error: "below_min_collateral", message: `Order too small: shares x price must be at least ${row.minOrderCollateralRaw} (raw bps units, $1).`, minShares: Math.ceil(row.minOrderCollateralRaw / (m.internalSide === "Buy" ? m.internalPriceBps : 10000 - m.internalPriceBps)) } };

  const { access, account } = await accountState(wallet);
  const txs: Array<UnsignedTx | OffchainStep> = [];
  let escrowMicro = m.collateralMicro; // fresh account: no offsetting position
  let freeMicro = 0n;
  if (!account) {
    if (access === 0) txs.push(tx("requestAccess", CONTRACTS.factory, encodeFunctionData({ abi: factoryAbi, functionName: "requestAccess" }), GAS.requestAccess, "Signals intent to trade. Then the off-chain approve step."));
    if (access !== 2) txs.push({ step: "approveAccess", offchain: true, method: "POST", url: `${SMX_ORIGIN}/app/__approve`, body: { address: wallet, chainId: CHAIN_ID }, note: "Testnet auto-approve (no signature). Wait until Factory.access(wallet) == 2 before deployAccount." });
    txs.push(tx("deployAccount", CONTRACTS.factory, encodeFunctionData({ abi: factoryAbi, functionName: "deployAccount" }), GAS.deployAccount, "Creates your own SMX Account (about 2.8M gas). Read Factory.accountOf(wallet) afterwards, then call smx_build_order again for exact funding."));
  } else {
    const [avail, reserved, curMkt, after] = await Promise.all([
      pub.readContract({ address: account, abi: accountAbi, functionName: "availableBalance" }) as Promise<bigint>,
      pub.readContract({ address: account, abi: accountAbi, functionName: "reserved" }) as Promise<bigint>,
      pub.readContract({ address: account, abi: accountAbi, functionName: "reservedByMarket", args: [idBytes32(inp.id)] }) as Promise<bigint>,
      pub.readContract({ address: row.bookAddr, abi: obAbi, functionName: "previewSubmit", args: [account, m.userSide, m.userPrice, BigInt(inp.qty)] }).catch(() => null) as Promise<bigint | null>,
    ]);
    freeMicro = avail > reserved ? avail - reserved : 0n;
    if (after !== null) escrowMicro = after > curMkt ? after - curMkt : 0n;
  }
  // Keep the max fee free too (charged at claim at the clear price; never more than at the limit).
  const needMicro = escrowMicro + m.maxFeeMicro;
  const shortfall = needMicro > freeMicro ? needMicro - freeMicro : 0n;
  if (shortfall > 0n) {
    const spender = account;
    const walletUsdc = (await pub.readContract({ address: CONTRACTS.testUsdcCollateral, abi: usdcAbi, functionName: "balanceOf", args: [wallet] })) as bigint;
    if (walletUsdc < shortfall && inp.mintTestUsdc !== false)
      txs.push(tx("mintTestUsdc", CONTRACTS.testUsdcCollateral, encodeFunctionData({ abi: usdcAbi, functionName: "mint", args: [wallet, shortfall - walletUsdc] }), GAS.mint, "SMX test USDC (no value)."));
    if (spender) {
      const allowance = (await pub.readContract({ address: CONTRACTS.testUsdcCollateral, abi: usdcAbi, functionName: "allowance", args: [wallet, spender] })) as bigint;
      if (allowance < shortfall) txs.push(tx("approve", CONTRACTS.testUsdcCollateral, encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [spender, shortfall] }), GAS.approve, "Lets your own Account pull the deposit."));
      txs.push(tx("deposit", spender, encodeFunctionData({ abi: accountAbi, functionName: "deposit", args: [shortfall] }), GAS.deposit));
    }
  }
  if (account) txs.push(tx("submitOrder", account, encodeFunctionData({ abi: accountAbi, functionName: "submitOrder", args: [row.bookAddr, m.userSide, m.userPrice, BigInt(inp.qty)] }), GAS.submitOrder, "Account.submitOrder on your own SMX Account."));

  return {
    ok: true,
    data: {
      marketId: inp.id, orderBook: row.bookAddr, wallet, account, accountStatus: account ? "ready" : ["none", "requested", "approved"][access],
      order: { outcome: inp.outcome, action: inp.action, qty: inp.qty, limitPriceCents: inp.limitPrice, userSide: m.userSide, userPriceBps: Number(m.userPrice), internalSide: m.internalSide, internalPriceBps: m.internalPriceBps },
      costs: { escrowMicroUsdc: escrowMicro.toString(), maxFeeMicroUsdc: m.maxFeeMicro.toString(), feeRule: "0.25% (Account.FEE_RATE_BPS = 25) x shares x the other side's price, charged at claim at the clear price", freeBalanceMicroUsdc: freeMicro.toString(), depositMicroUsdc: shortfall.toString() },
      trading: { status: trading.status, closeAt: trading.closeAt, source: trading.source },
      transactions: txs,
      complete: Boolean(account),
      signing: "Unsigned. Sign and send each transaction in order from your own wallet on Base Sepolia (84532). This server never signs or holds keys.",
    },
  };
}

export function idBytes32(id: string): Hex {
  const hex = Buffer.from(id, "utf8").toString("hex").padEnd(64, "0");
  return `0x${hex}` as Hex;
}

/** Fills (batch>=1) with filledQty > 0 for these order ids. */
async function fillsOf(book: Address, orderIds: number[]) {
  const nonce = Number(await pub.readContract({ address: book, abi: obAbi, functionName: "batchNonce" }));
  const out: Array<{ orderId: number; batchNonce: number; filledQty: string }> = [];
  for (const id of orderIds) for (let n = 1; n <= nonce; n++) {
    const r = (await pub.readContract({ address: book, abi: obAbi, functionName: "fills", args: [BigInt(id), BigInt(n)] }).catch(() => null)) as readonly [Address, bigint] | null;
    if (r && r[1] > 0n) out.push({ orderId: id, batchNonce: n, filledQty: r[1].toString() });
  }
  return out;
}

async function indexedOrderIds(account: Address, id: string): Promise<number[]> {
  try {
    const r = await getJson(`${SMX_INDEXER}/v1/accounts/${account}/history`);
    const orders = ((r.body as { orders?: Array<{ market?: string; orderId?: number }> })?.orders ?? []).filter((o) => o.market === id);
    return orders.map((o) => Number(o.orderId)).filter((n) => Number.isFinite(n));
  } catch { return []; }
}

export async function buildClaim(inp: { id: string; wallet: string; orderIds?: number[] }) {
  const wallet = getAddress(inp.wallet);
  const row = await findRow(inp.id);
  if (!row) return { ok: false as const, err: { error: "unknown_market", message: "Unknown market id." } };
  const { account } = await accountState(wallet);
  if (!account) return { ok: false as const, err: { error: "no_account", message: "This wallet has no SMX Account, so there is nothing to claim." } };
  const ids = inp.orderIds?.length ? inp.orderIds : await indexedOrderIds(account, inp.id);
  const fills = await fillsOf(row.bookAddr, ids);
  // Claim is permissionless, but only unclaimed fills succeed: keep those whose claim simulates OK.
  const txs: UnsignedTx[] = [];
  const skipped: unknown[] = [];
  for (const f of fills) {
    const data = encodeFunctionData({ abi: obAbi, functionName: "claim", args: [BigInt(f.orderId), BigInt(f.batchNonce)] });
    try { await pub.call({ account: wallet, to: row.bookAddr, data }); txs.push(tx(`claim ${f.orderId}/${f.batchNonce}`, row.bookAddr, data, GAS.claim, `Claims ${f.filledQty} filled shares into your Account.`)); }
    catch { skipped.push({ ...f, reason: "already claimed or not claimable" }); }
  }
  return { ok: true as const, data: { marketId: inp.id, orderBook: row.bookAddr, wallet, account, orderIdsChecked: ids, transactions: txs, skipped, signing: "Unsigned. claim() is permissionless and pays your own Account; sign from your wallet." } };
}

export async function buildCancel(inp: { id: string; wallet: string; orderId: number }) {
  const wallet = getAddress(inp.wallet);
  const row = await findRow(inp.id);
  if (!row) return { ok: false as const, err: { error: "unknown_market", message: "Unknown market id." } };
  const { account } = await accountState(wallet);
  if (!account) return { ok: false as const, err: { error: "no_account", message: "This wallet has no SMX Account." } };
  const o = (await pub.readContract({ address: row.bookAddr, abi: obAbi, functionName: "orders", args: [BigInt(inp.orderId)] })) as readonly [Address, bigint, bigint, bigint];
  if (o[1] === 0n) return { ok: false as const, err: { error: "order_not_open", message: `Order ${inp.orderId} is not resting (filled, cancelled or unknown).` } };
  if (getAddress(o[0]) !== account) return { ok: false as const, err: { error: "not_order_owner", message: `Order ${inp.orderId} belongs to ${o[0]}, not your Account ${account}.` } };
  // Stranded-fill rule: claim every unclaimed fill first, in the same sequence.
  const claims = await buildClaim({ id: inp.id, wallet, orderIds: [inp.orderId] });
  const claimTxs = claims.ok ? claims.data.transactions : [];
  const cancel = tx("cancelOrder", account, encodeFunctionData({ abi: accountAbi, functionName: "cancelOrder", args: [row.bookAddr, BigInt(inp.orderId)] }), GAS.cancelOrder, "Account.cancelOrder on your own SMX Account. Releases unused escrow.");
  return { ok: true as const, data: { marketId: inp.id, orderBook: row.bookAddr, wallet, account, orderId: inp.orderId, unclaimedFillsClaimedFirst: claimTxs.length, transactions: [...claimTxs, cancel], signing: "Unsigned. Send any claim transactions BEFORE the cancel (cancelling with an unclaimed fill forfeits it on v1 contracts)." } };
}
