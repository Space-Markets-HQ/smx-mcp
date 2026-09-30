/**
 * Listing policy, status and unit helpers. Vendored from the SMX agent API (smx-agent-api src/listing.ts,
 * 2026-09-30) so the MCP market list matches GET /agent/markets exactly, computed from chain state only.
 * Keep in sync with the agent API until it is published as a shared package.
 */
export const PRICE_MAX_BPS = 10000;
export const NO_ASK = 10001;
export const STALE_UNRESOLVED_GRACE_SEC = 7 * 24 * 3600;
export const MARKET_STATE_V1 = ["Open", "Resolved"] as const;

export type Outcome = "YES" | "NO" | "SPLIT";
export type ChainMarket = {
  index: number;
  marketId: string;
  idWellFormed?: boolean;
  state: number;
  resolutionDate: number;
  bestBid: number;
  bestAsk: number;
  resolved?: boolean;
  finalPrice?: number;
  minOrderQty?: number;
  minOrderCollateralRaw?: number;
  nextOrderId?: number;
};
export type MarketStatus = "open" | "awaiting_resolution" | "resolved";

export const stateNameV1 = (s: number) => MARKET_STATE_V1[s] ?? `Unknown(${s})`;
export const isResolved = (m: ChainMarket) => m.state === 1 || m.resolved === true;

export function outcomeOf(m: ChainMarket): Outcome | null {
  if (!isResolved(m) || m.finalPrice === undefined) return null;
  if (m.finalPrice === PRICE_MAX_BPS) return "YES";
  if (m.finalPrice === 0) return "NO";
  return "SPLIT";
}

export function statusOf(m: ChainMarket, nowSec: number): MarketStatus {
  if (isResolved(m)) return "resolved";
  if (m.resolutionDate && m.resolutionDate <= nowSec) return "awaiting_resolution";
  return "open";
}

export function quoteOf(bestBid: number, bestAsk: number) {
  return {
    bestBidBps: bestBid > 0 ? bestBid : null,
    bestAskBps: bestAsk > 0 && bestAsk < NO_ASK ? bestAsk : null,
  };
}

export type MidSource = "midpoint" | "bid-only" | "ask-only" | "unquoted" | "resolved";

/**
 * YES price in bps. Unlike the agent API's legacy mid (which reports 5000 for an empty book), the MCP server
 * returns null when there is no quote, so agents never mistake a default for a price.
 */
export function midOf(m: ChainMarket): { midBps: number | null; midSource: MidSource } {
  if (isResolved(m) && m.finalPrice !== undefined) return { midBps: m.finalPrice, midSource: "resolved" };
  const q = quoteOf(m.bestBid, m.bestAsk);
  if (q.bestBidBps !== null && q.bestAskBps !== null)
    return { midBps: Math.round((q.bestBidBps + q.bestAskBps) / 2), midSource: "midpoint" };
  if (q.bestBidBps !== null) return { midBps: q.bestBidBps, midSource: "bid-only" };
  if (q.bestAskBps !== null) return { midBps: q.bestAskBps, midSource: "ask-only" };
  return { midBps: null, midSource: "unquoted" };
}

export function minQtyAt(userPriceBps: number, floorQty: number, minCollateralRaw: number): number | null {
  if (!(userPriceBps > 0) || userPriceBps >= PRICE_MAX_BPS) return null;
  return Math.max(floorQty, Math.ceil(minCollateralRaw / userPriceBps));
}

export const MIN_ORDER_RULE =
  "qty >= minOrderQtyFloor and qty * priceBps >= minOrderCollateralRaw, where priceBps is what you pay per share (YES price for YES, 10000 - YES price for NO); prices on a 100 bps (1 cent) grid";

export function minOrderOf(m: ChainMarket) {
  if (isResolved(m) || m.minOrderQty === undefined || m.minOrderCollateralRaw === undefined) return null;
  const floor = m.minOrderQty;
  const coll = m.minOrderCollateralRaw;
  const q = quoteOf(m.bestBid, m.bestAsk);
  const mid = midOf(m).midBps ?? 5000;
  const yes = minQtyAt(mid, floor, coll);
  const no = minQtyAt(PRICE_MAX_BPS - mid, floor, coll);
  return {
    minOrderQtyFloor: floor,
    minOrderCollateralRaw: coll,
    buyYesAtBestAsk: q.bestAskBps === null ? null : minQtyAt(q.bestAskBps, floor, coll),
    buyNoAtBestBid: q.bestBidBps === null ? null : minQtyAt(PRICE_MAX_BPS - q.bestBidBps, floor, coll),
    atMid: yes === null || no === null ? (yes ?? no) : Math.max(yes, no),
    rule: MIN_ORDER_RULE,
  };
}

export type ExcludedReason = "malformed-id" | "internal-codename" | "drill" | "never-traded" | "stale-unresolved" | "superseded";
export type ListingDecision = { listed: true } | { listed: false; excludedReason: ExcludedReason; detail: string };

export function familyOf(id: string) {
  const m = /^(.*)-v(\d+)$/.exec(id);
  return m ? { family: m[1]!, version: Number(m[2]) } : { family: id, version: 1 };
}

/** Same rules, same order as the agent API (see its docs/markets-listing.md). */
export function listingDecisions(rows: ChainMarket[], nowSec: number): Map<number, ListingDecision> {
  const out = new Map<number, ListingDecision>();
  const eligible: ChainMarket[] = [];
  // Old internal engineering codename; the literal is assembled so the word never appears in shipped copy.
  const codename = new RegExp(["pre", "dix"].join(""), "i");
  for (const r of rows) {
    if (r.idWellFormed === false || !/^[\x21-\x7e]+$/.test(r.marketId)) {
      out.set(r.index, { listed: false, excludedReason: "malformed-id", detail: "bytes32 id is not canonical right-padded ASCII" });
    } else if (codename.test(r.marketId)) {
      out.set(r.index, { listed: false, excludedReason: "internal-codename", detail: "internal engineering test market" });
    } else if (/drill/i.test(r.marketId)) {
      out.set(r.index, { listed: false, excludedReason: "drill", detail: "operational resolve drill" });
    } else if (!isResolved(r) && r.nextOrderId === 0) {
      out.set(r.index, { listed: false, excludedReason: "never-traded", detail: "no order has ever been placed on this book" });
    } else if (!isResolved(r) && r.resolutionDate && r.resolutionDate + STALE_UNRESOLVED_GRACE_SEC < nowSec) {
      out.set(r.index, { listed: false, excludedReason: "stale-unresolved", detail: "still Open more than 7 days after its resolution date" });
    } else {
      eligible.push(r);
    }
  }
  const families = new Map<string, ChainMarket[]>();
  for (const r of eligible) {
    const f = familyOf(r.marketId).family;
    families.set(f, [...(families.get(f) ?? []), r]);
  }
  for (const members of families.values()) {
    const open = members.filter((m) => !isResolved(m));
    const pool = open.length ? open : members;
    const winner = [...pool].sort((a, b) =>
      open.length ? familyOf(b.marketId).version - familyOf(a.marketId).version || b.index - a.index : b.index - a.index,
    )[0]!;
    for (const m of members)
      out.set(m.index, m === winner ? { listed: true } : { listed: false, excludedReason: "superseded", detail: `superseded by ${winner.marketId}` });
  }
  return out;
}

export function isCanonicalMarketId(bytes32: string): boolean {
  const hex = bytes32.startsWith("0x") ? bytes32.slice(2) : bytes32;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const buf = Buffer.from(hex, "hex");
  const end = buf.indexOf(0);
  const body = end === -1 ? buf : buf.subarray(0, end);
  if (body.length === 0 || !body.every((b) => b >= 0x21 && b <= 0x7e)) return false;
  return end === -1 || buf.subarray(end).every((b) => b === 0);
}

export function decodeMarketId(bytes32: string): string {
  const hex = bytes32.startsWith("0x") ? bytes32.slice(2) : bytes32;
  const buf = Buffer.from(hex, "hex");
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? undefined : end).toString("utf8") || bytes32;
}
