/** Read-only Base Sepolia reads (eth_call only). This module never signs or sends a transaction. */
import { createPublicClient, http, parseAbi, pad, stringToHex, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { CHAIN_ID, CONTRACTS, MARKET_TITLES, RPC_URL } from "./config.js";
import {
  type ChainMarket,
  decodeMarketId,
  isCanonicalMarketId,
  listingDecisions,
  type ListingDecision,
} from "./listing.js";

export const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL, { retryCount: 3, retryDelay: 800 }) });

const registryAbi = parseAbi([
  "function marketsCount() view returns (uint256)",
  "function markets(uint256 index) view returns (address market)",
  "function orderBookOf(bytes32 marketId) view returns (address)",
]);
const marketAbi = parseAbi([
  "function marketId() view returns (bytes32)",
  "function orderBook() view returns (address)",
  "function state() view returns (uint8)",
  "function resolutionDate() view returns (uint256)",
]);
export const bookAbi = parseAbi([
  "function bestBid() view returns (uint64)",
  "function bestAsk() view returns (uint64)",
  "function resolved() view returns (bool)",
  "function finalPrice() view returns (uint64)",
  "function minOrderQty() view returns (uint256)",
  "function minOrderCollateralRaw() view returns (uint256)",
  "function nextOrderId() view returns (uint256)",
  "function batchNonce() view returns (uint256)",
  "function activeOrderCount() view returns (uint256)",
  "function isCrossed() view returns (bool)",
  "function clearableAt() view returns (uint40)",
  "function orders(uint256) view returns (address trader, int128 quantity, uint64 price, uint64 submittedAt)",
  "function fills(uint256 orderId, uint256 batchNonce) view returns (address trader, uint96 filledQty)",
  "function claim(uint256 orderId, uint256 batchNonce) returns (uint256 payout)",
  "error UnknownOrder()",
  "error NothingToClaim()",
  "error NotOrderOwner()",
]);

export type MarketRow = ChainMarket & {
  marketAddr: Address;
  bookAddr: Address;
  batchNonce?: number;
  activeOrderCount?: number;
  isCrossed?: boolean;
  clearableAt?: number;
  title: string;
  listing: ListingDecision;
};

export const idBytes = (id: string) => pad(stringToHex(id), { size: 32, dir: "right" });

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };
async function multi(calls: Call[], chunk = 40): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const res = await pub.multicall({ contracts: calls.slice(i, i + chunk) as never, allowFailure: true });
    for (const r of res as Array<{ status: string; result?: unknown }>) out.push(r.status === "success" ? r.result : undefined);
  }
  return out;
}

export async function assertTestnet() {
  const id = await pub.getChainId();
  if (id !== CHAIN_ID) throw new Error(`RPC reports chain id ${id}; this server only reads Base Sepolia (84532).`);
}

let cache: { at: number; rows: MarketRow[] } | null = null;
const CACHE_MS = 10_000;

/** Every registry market with its chain state and listing decision (same policy as GET /agent/markets). */
export async function allMarkets(): Promise<MarketRow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  await assertTestnet();
  const count = Number(await pub.readContract({ address: CONTRACTS.marketRegistry, abi: registryAbi, functionName: "marketsCount" }));
  const addrs = (await multi([...Array(count).keys()].map((i) => ({
    address: CONTRACTS.marketRegistry, abi: registryAbi, functionName: "markets", args: [BigInt(i)],
  })))) as Address[];
  const mFns = ["marketId", "orderBook", "state", "resolutionDate"] as const;
  const mRes = await multi(addrs.flatMap((a) => mFns.map((fn) => ({ address: a, abi: marketAbi, functionName: fn }))));
  const bFns = ["bestBid", "bestAsk", "resolved", "finalPrice", "minOrderQty", "minOrderCollateralRaw", "nextOrderId", "batchNonce", "activeOrderCount", "isCrossed", "clearableAt"] as const;
  const books = addrs.map((_, i) => mRes[i * 4 + 1] as Address);
  const bRes = await multi(books.flatMap((b) => bFns.map((fn) => ({ address: b, abi: bookAbi, functionName: fn }))));
  const num = (v: unknown) => (v === undefined ? undefined : Number(v as bigint));
  const nowSec = Math.floor(Date.now() / 1000);
  const rows: Omit<MarketRow, "listing">[] = addrs.map((addr, i) => {
    const raw = (mRes[i * 4] as string) ?? "0x";
    const b = (k: number) => bRes[i * bFns.length + k];
    const marketId = decodeMarketId(raw);
    return {
      index: i,
      marketId,
      idWellFormed: isCanonicalMarketId(raw),
      marketAddr: addr,
      bookAddr: books[i]!,
      state: num(mRes[i * 4 + 2]) ?? 0,
      resolutionDate: num(mRes[i * 4 + 3]) ?? 0,
      bestBid: num(b(0)) ?? 0,
      bestAsk: num(b(1)) ?? 0,
      resolved: b(2) as boolean | undefined,
      finalPrice: num(b(3)),
      minOrderQty: num(b(4)),
      minOrderCollateralRaw: num(b(5)),
      nextOrderId: num(b(6)),
      batchNonce: num(b(7)),
      activeOrderCount: num(b(8)),
      isCrossed: b(9) as boolean | undefined,
      clearableAt: num(b(10)),
      title: MARKET_TITLES[marketId] ?? marketId,
    };
  });
  const decisions = listingDecisions(rows, nowSec);
  const full = rows.map((r) => ({ ...r, listing: decisions.get(r.index) ?? { listed: true as const } }));
  cache = { at: Date.now(), rows: full };
  return full;
}

export type Level = { priceBps: number; priceCents: number; qty: number; orders: number };

/** Resting orders aggregated by price level. qty > 0 = YES bid; qty < 0 = YES ask (a NO buy at 10000 - price). */
export async function bookDepth(book: Address, nextOrderId: number, maxScan = 400) {
  const from = Math.max(0, nextOrderId - maxScan);
  const ids = [...Array(nextOrderId - from).keys()].map((k) => from + k);
  const res = (await multi(ids.map((id) => ({ address: book, abi: bookAbi, functionName: "orders", args: [BigInt(id)] })))) as Array<
    readonly [Address, bigint, bigint, bigint] | undefined
  >;
  const bids = new Map<number, Level>();
  const asks = new Map<number, Level>();
  let active = 0;
  res.forEach((o) => {
    if (!o) return;
    const [, qty, price] = o;
    if (qty === 0n) return;
    active++;
    const p = Number(price);
    const side = qty > 0n ? bids : asks;
    const lvl = side.get(p) ?? { priceBps: p, priceCents: p / 100, qty: 0, orders: 0 };
    lvl.qty += Number(qty > 0n ? qty : -qty);
    lvl.orders += 1;
    side.set(p, lvl);
  });
  return {
    bids: [...bids.values()].sort((a, b) => b.priceBps - a.priceBps),
    asks: [...asks.values()].sort((a, b) => a.priceBps - b.priceBps),
    activeOrdersScanned: active,
    scannedOrderIds: { from, toExclusive: nextOrderId, truncated: from > 0 },
  };
}

/**
 * Unclaimed-fill check (ported from predix-test-agent/lib/unclaimed-fill-guard.mjs `unclaimedFills` / `guardCancel`).
 * v1 rule: a recorded fill is deleted by claim, so fills(orderId, n).filledQty > 0 means an unclaimed fill.
 * Read-only. There is no override: this server never cancels anything.
 */
export async function unclaimedFills(book: Address, orderIds: number[]) {
  const nonce = Number(await pub.readContract({ address: book, abi: bookAbi, functionName: "batchNonce" }));
  const keys: Array<[bigint, bigint]> = [];
  for (const id of orderIds) for (let n = 1; n <= nonce; n++) keys.push([BigInt(id), BigInt(n)]);
  const res = keys.length
    ? ((await multi(keys.map((args) => ({ address: book, abi: bookAbi, functionName: "fills", args })))) as Array<readonly [Address, bigint] | undefined>)
    : [];
  const fills: Array<{ orderId: number; batchNonce: number; trader: Address; filledQty: number; claimSimulation?: string }> = [];
  const unreadable: Array<{ orderId: number; batchNonce: number }> = [];
  res.forEach((r, i) => {
    const [id, n] = keys[i]!;
    if (!r) { unreadable.push({ orderId: Number(id), batchNonce: Number(n) }); return; }
    if (r[1] > 0n) fills.push({ orderId: Number(id), batchNonce: Number(n), trader: r[0], filledQty: Number(r[1]) });
  });
  // eth_call simulation of claim() (never sent). claim() is permissionless and pays the order owner's Account.
  for (const f of fills) {
    try {
      await pub.simulateContract({ address: book, abi: bookAbi, functionName: "claim", args: [BigInt(f.orderId), BigInt(f.batchNonce)], account: "0x000000000000000000000000000000000000dEaD" });
      f.claimSimulation = "ok";
    } catch (e) {
      const ee = e as { message?: string; cause?: { data?: { errorName?: string } } };
      const m = `${ee.cause?.data?.errorName ?? ""} ${String(ee.message ?? e)}`;
      const sel: Record<string, string> = { "0xb838de96": "UnknownOrder", "0x969bf728": "NothingToClaim", "0xf6412b5a": "NotOrderOwner" };
      const known = /UnknownOrder|NothingToClaim|NotOrderOwner/.exec(m)?.[0] ?? sel[/0x[0-9a-f]{8}/i.exec(m)?.[0]?.toLowerCase() ?? ""];
      f.claimSimulation = `reverts${known ? ` ${known}()` : ""}`;
    }
  }
  return { batchNonce: nonce, fills, unreadable };
}
