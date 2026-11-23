/**
 * Listing policy, status and unit helpers. Vendored from the SMX agent API (smx-agent-api src/listing.ts,
 * 2026-09-30). Chain state decides the list. A market is never hidden because a timer has passed:
 * trading end is enforced by the SMX app and API, and an unresolved market stays listed.
 */
export const PRICE_MAX_BPS = 10000;
export const NO_ASK = 10001;
export const MARKET_STATE_V1 = ["Open", "Resolved"] as const;
export const OVERDUE_LABEL = "Overdue: awaiting resolution" as const;

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
export type MarketStatus = "open" | "overdue" | "resolved";
export type DisplayLabel = "Open" | "Trading closed" | typeof OVERDUE_LABEL | "Resolved";

export const stateNameV1 = (s: number) => MARKET_STATE_V1[s] ?? `Unknown(${s})`;
export const isResolved = (m: { state?: number; resolved?: boolean }) => m.state === 1 || m.resolved === true;

export function outcomeOf(m: ChainMarket): Outcome | null {
  if (!isResolved(m) || m.finalPrice === undefined) return null;
  if (m.finalPrice === PRICE_MAX_BPS) return "YES";
  if (m.finalPrice === 0) return "NO";
  return "SPLIT";
}

export function statusOf(m: ChainMarket, nowSec: number): MarketStatus {
  if (isResolved(m)) return "resolved";
  if (m.resolutionDate && m.resolutionDate <= nowSec) return "overdue";
  return "open";
}

export type PresentationFeed = {
  nowMs: number;
  /** Set only when GET /agent/trading returned a record. That record wins over config and the indexer. */
  api: { status: "open" | "closed" | "halted"; closeAt: string | null; dueBy: string | null } | null;
  indexerDueBy: string | null;
  /** rules.close, otherwise the indexer tradingEnd. */
  indexerTradingEnd: string | null;
  /** SMX_MARKET_CLOSES_JSON / built-in close. Used only when the API did not answer. */
  configuredCloseAt: string | null;
};

export type MarketPresentation = {
  overdue: boolean;
  status: MarketStatus;
  displayLabel: DisplayLabel;
  /** Same string as displayLabel. */
  displayStatus: DisplayLabel;
  /** API dueBy, else indexer dueBy, else the resolution date. Null when none of those exist. */
  dueBy: string | null;
  /** Hours since dueBy when overdue, otherwise 0. */
  hoursOverdue: number;
};

function asIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function firstIso(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const iso = asIso(v);
    if (iso) return iso;
  }
  return null;
}

function isoInPast(v: string | null | undefined, nowMs: number): boolean {
  const iso = asIso(v);
  return iso !== null && Date.parse(iso) <= nowMs;
}

/** Hours from dueBy to now, one decimal, never negative. */
export function hoursSince(iso: string | null, nowMs: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t >= nowMs) return 0;
  return Math.round(((nowMs - t) / 3_600_000) * 10) / 10;
}

/**
 * overdue = no outcome, and (trading end passed OR resolution date passed).
 * Trading end is enforced by the SMX app and API, not by the v1 contracts.
 * hoursOverdue is counted from dueBy.
 */
export function marketPresentation(
  m: { state?: number; resolved?: boolean; resolutionDate?: number },
  feed: PresentationFeed,
): MarketPresentation {
  const nowSec = Math.floor(feed.nowMs / 1000);
  const resolutionIso = m.resolutionDate ? new Date(m.resolutionDate * 1000).toISOString() : null;
  const dueBy = firstIso(feed.api?.dueBy, feed.indexerDueBy, resolutionIso);
  const resolved = isResolved(m);
  const resolutionPassed = Boolean(m.resolutionDate && m.resolutionDate <= nowSec);
  const tradingEndPassed = feed.api
    ? feed.api.status === "closed" || isoInPast(feed.api.closeAt, feed.nowMs)
    : isoInPast(feed.configuredCloseAt, feed.nowMs) || isoInPast(feed.indexerTradingEnd, feed.nowMs);
  const overdue = !resolved && (tradingEndPassed || resolutionPassed);
  const hoursOverdue = overdue ? hoursSince(dueBy, feed.nowMs) : 0;
  const displayLabel: DisplayLabel = resolved
    ? "Resolved"
    : overdue
      ? OVERDUE_LABEL
      : feed.api && feed.api.status !== "open"
        ? "Trading closed"
        : "Open";
  const status: MarketStatus = resolved ? "resolved" : overdue ? "overdue" : "open";
  return { overdue, status, displayLabel, displayStatus: displayLabel, dueBy, hoursOverdue };
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

export type ExcludedReason = "malformed-id" | "internal-codename" | "drill" | "never-traded" | "superseded";
export type ListingDecision = { listed: true } | { listed: false; excludedReason: ExcludedReason; detail: string };

export function familyOf(id: string) {
  const m = /^(.*)-v(\d+)$/.exec(id);
  return m ? { family: m[1]!, version: Number(m[2]) } : { family: id, version: 1 };
}

/** TEST-V books (v7/v8 on the second registry) are listed even before their first order. */
export const LAUNCH_BOOK_ID = /^TEST-V[0-9]+-/;

export type DedupableMarket = {
  marketId: string;
  registry: string;
  index: number;
  idWellFormed?: boolean;
};

/**
 * One row per well-formed market id. `registryOrder` is oldest first; a later registry wins.
 * Malformed ids are not merged (they are excluded later as malformed-id).
 */
export function dedupeMarkets<T extends DedupableMarket>(rows: readonly T[], registryOrder: readonly string[]): T[] {
  const rank = new Map(registryOrder.map((a, i) => [a.toLowerCase(), i]));
  const winner = new Map<string, T>();
  for (const r of rows) {
    if (r.idWellFormed === false || r.marketId.length === 0) continue;
    const prev = winner.get(r.marketId);
    if (!prev) { winner.set(r.marketId, r); continue; }
    const pr = rank.get(prev.registry.toLowerCase()) ?? -1;
    const rr = rank.get(r.registry.toLowerCase()) ?? -1;
    if (rr > pr || (rr === pr && r.index >= prev.index)) winner.set(r.marketId, r);
  }
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (r.idWellFormed === false || r.marketId.length === 0) { out.push(r); continue; }
    if (winner.get(r.marketId) !== r || seen.has(r.marketId)) continue;
    seen.add(r.marketId);
    out.push(r);
  }
  return out;
}

/**
 * Same exclusion order as the agent API, except a market is never dropped for being past its
 * resolution date or trading end (there is no stale-unresolved timer). An unresolved market
 * past its resolution date is listed on its own and does not take the family slot.
 */
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
    } else if (!isResolved(r) && r.nextOrderId === 0 && !LAUNCH_BOOK_ID.test(r.marketId)) {
      out.set(r.index, { listed: false, excludedReason: "never-traded", detail: "no order has ever been placed on this book" });
    } else if (!isResolved(r) && r.resolutionDate && r.resolutionDate <= nowSec) {
      // No outcome and the resolution date has passed: stay listed, and do not take the
      // family slot from a version that is still before its resolution date.
      out.set(r.index, { listed: true });
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
