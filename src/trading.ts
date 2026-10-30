/**
 * Trading cut-off, mirrored from the SMX agent API (GET /agent/trading/{id}).
 * The v1 contracts have no trading end or pause, so SMX enforces close times and admin halts off-chain.
 * If the API cannot be reached, fall back to the chain: closed once resolved or at resolutionDate
 * (halt state unknown, reported as such).
 */
import { SMX_API } from "./config.js";
import { getJson } from "./fetch.js";

export type TradingStatus = "open" | "closed" | "halted";
export type MarketState = "closed" | "paused" | "resolved" | "expired";
export type Trading = {
  status: TradingStatus;
  open: boolean;
  closeAt: string | null;
  halted: { reason: string; haltedAt: string } | null;
  source: "smx-api" | "chain (SMX API unreachable; halt state unknown)";
  /** Set from chain state when that is more specific than open/closed/halted. */
  unavailable?: "resolved" | "expired";
};

export const tradingUrl = (id?: string) => `${SMX_API}/agent/trading${id ? `/${encodeURIComponent(id)}` : ""}`;

function fromApi(b: unknown): Trading | null {
  if (!b || typeof b !== "object") return null;
  const j = b as Record<string, unknown>;
  // "paused" stays status "halted" so a non-open market is unchanged for readers; the refusal names it paused.
  if (j.status === "paused") return { status: "halted", open: false, closeAt: typeof j.closeAt === "string" ? j.closeAt : null, halted: { reason: "paused", haltedAt: String((j.paused as { pausedAt?: string } | null)?.pausedAt ?? "") }, source: "smx-api" };
  if (j.status !== "open" && j.status !== "closed" && j.status !== "halted") return null;
  const h = j.halted as Trading["halted"];
  return { status: j.status, open: j.status === "open", closeAt: typeof j.closeAt === "string" ? j.closeAt : null, halted: h && typeof h === "object" ? h : null, source: "smx-api" };
}

/** Chain-only fallback. Resolved and past-resolution markets stay status "closed" and also set `unavailable`. */
export function chainTrading(m: { resolutionDate?: number; resolved?: boolean; state?: number } | null | undefined, nowMs = Date.now()): Trading {
  const closeAt = m?.resolutionDate ? new Date(m.resolutionDate * 1000).toISOString() : null;
  const resolved = Boolean(m && (m.state === 1 || m.resolved));
  const past = closeAt !== null && Date.parse(closeAt) <= nowMs;
  const unavailable = resolved ? "resolved" as const : past ? "expired" as const : undefined;
  return {
    status: resolved || past ? "closed" : "open",
    open: !(resolved || past),
    closeAt,
    halted: null,
    source: "chain (SMX API unreachable; halt state unknown)",
    ...(unavailable ? { unavailable } : {}),
  };
}

/** Human reason for a market that cannot be traded or quoted. */
export function reasonFor(state: MarketState, at?: string | null, detail?: string | null): string {
  if (state === "paused") return "market paused";
  if (at) return `market ${state} at ${at}`;
  if (detail) return `market ${state} (${detail})`;
  return `market ${state}`;
}

/** One market from the SMX API; null if unreachable or unknown there. */
export async function apiTrading(id: string): Promise<Trading | null> {
  try {
    const r = await getJson(tradingUrl(id));
    return r.status === 200 ? fromApi(r.body) : null;
  } catch {
    return null;
  }
}

/** All markets from the SMX API; empty map if unreachable. */
export async function apiTradingAll(): Promise<Map<string, Trading>> {
  const out = new Map<string, Trading>();
  try {
    const r = await getJson(tradingUrl());
    const markets = (r.body as { markets?: Record<string, unknown> } | null)?.markets;
    if (r.status === 200 && markets) for (const [k, v] of Object.entries(markets)) { const t = fromApi(v); if (t) out.set(k, t); }
  } catch { /* fall back per market */ }
  return out;
}

export type TradingRefusal = {
  error: "market_closed" | "market_paused" | "market_resolved" | "market_expired" | "market_halted";
  state: MarketState | "halted";
  reason: string;
  marketId: string;
  message: string;
  closeAt: string | null;
  halted: Trading["halted"];
  source: Trading["source"];
};

/** null = market open for orders; else the refusal, with state and reason. */
export function tradingRefusal(id: string, t: Trading): TradingRefusal | null {
  if (t.status === "open" && !t.unavailable) return null;
  const base = { marketId: id, closeAt: t.closeAt, halted: t.halted, source: t.source };
  if (t.status === "halted" && t.halted?.reason === "paused") {
    const reason = reasonFor("paused");
    return { ...base, error: "market_paused", state: "paused", reason, message: reason };
  }
  if (t.status === "halted") {
    return {
      ...base,
      error: "market_halted",
      state: "halted",
      reason: t.halted?.reason ? `market halted (${t.halted.reason})` : "market halted",
      message: `Trading on ${id} is halted by SMX${t.halted?.reason ? ` (${t.halted.reason})` : ""}. Do not submit orders.`,
    };
  }
  if (t.unavailable === "resolved" || t.unavailable === "expired") {
    const reason = reasonFor(t.unavailable, t.closeAt);
    return { ...base, error: `market_${t.unavailable}`, state: t.unavailable, reason, message: reason };
  }
  const reason = reasonFor("closed", t.closeAt);
  return {
    ...base,
    error: "market_closed",
    state: "closed",
    reason,
    message: `Trading on ${id} closed${t.closeAt ? ` at ${t.closeAt}` : ""}. Do not submit orders.`,
  };
}

/** Refuse a chain row that is resolved, past its resolution time, or otherwise not Open. null if the row is open. */
export function chainRowRefusal(id: string, row: { state?: number; resolved?: boolean; resolutionDate?: number } | null | undefined, nowMs = Date.now()): TradingRefusal | null {
  const chain = chainTrading(row, nowMs);
  if (chain.status === "open" && !(row && (row.state !== 0 || row.resolved))) return null;
  return tradingRefusal(id, chain.status === "open" ? { ...chain, status: "closed", open: false, unavailable: "resolved" } : chain);
}

const UPSTREAM_STATE: Record<string, MarketState> = {
  market_closed: "closed",
  market_paused: "paused",
  market_resolved: "resolved",
  market_expired: "expired",
};

/**
 * Turn an upstream body into a market-state error when the code or the text names one of
 * closed / paused / resolved / expired. Generic failures that do not name a state return null.
 */
export function interpretUpstreamMarketError(body: unknown): { error: string; code: string; state: MarketState; reason: string; message: string; detail?: string } | null {
  if (!body || typeof body !== "object") return null;
  const j = body as Record<string, unknown>;
  const raw = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : "";
  let code = typeof j.code === "string" ? j.code : "";
  let state = UPSTREAM_STATE[code];
  if (!state) {
    const named = raw.match(/\bmarket (closed|paused|resolved|expired)\b/i);
    if (!named) return null;
    if (code && code !== "error" && code !== "bad_request" && code !== "unavailable") return null;
    state = named[1]!.toLowerCase() as MarketState;
    code = `market_${state}`;
  }
  const at = raw.match(/\bat\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/)?.[1] ?? (typeof j.closeAt === "string" ? j.closeAt : null);
  const paren = raw.match(/\(([^)]+)\)/)?.[1] ?? (typeof j.reason === "string" ? j.reason : null);
  const reason = reasonFor(state, at, paren);
  return { error: code, code, state, reason, message: reason, ...(raw && raw !== reason ? { detail: raw } : {}) };
}
