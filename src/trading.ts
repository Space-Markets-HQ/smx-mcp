/**
 * Trading cut-off, mirrored from the SMX agent API (GET /agent/trading/{id}).
 * The v1 contracts have no trading end or pause, so SMX enforces close times and admin halts off-chain.
 * If the API cannot be reached, fall back to the chain: closed once resolved or at resolutionDate
 * (halt state unknown, reported as such).
 */
import { SMX_ORIGIN } from "./config.js";
import { getJson } from "./fetch.js";

export type TradingStatus = "open" | "closed" | "halted";
export type Trading = {
  status: TradingStatus;
  open: boolean;
  closeAt: string | null;
  halted: { reason: string; haltedAt: string } | null;
  source: "smx-api" | "chain (SMX API unreachable; halt state unknown)";
};

export const tradingUrl = (id?: string) => `${SMX_ORIGIN}/agent/trading${id ? `/${encodeURIComponent(id)}` : ""}`;

function fromApi(b: unknown): Trading | null {
  if (!b || typeof b !== "object") return null;
  const j = b as Record<string, unknown>;
  if (j.status !== "open" && j.status !== "closed" && j.status !== "halted") return null;
  const h = j.halted as Trading["halted"];
  return { status: j.status, open: j.status === "open", closeAt: typeof j.closeAt === "string" ? j.closeAt : null, halted: h && typeof h === "object" ? h : null, source: "smx-api" };
}

/** Chain-only fallback. */
export function chainTrading(m: { resolutionDate?: number; resolved?: boolean; state?: number } | null | undefined, nowMs = Date.now()): Trading {
  const closeAt = m?.resolutionDate ? new Date(m.resolutionDate * 1000).toISOString() : null;
  const closed = Boolean(m && (m.state === 1 || m.resolved)) || (closeAt !== null && Date.parse(closeAt) <= nowMs);
  return { status: closed ? "closed" : "open", open: !closed, closeAt, halted: null, source: "chain (SMX API unreachable; halt state unknown)" };
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

export type TradingRefusal = { error: "market_closed" | "market_halted"; marketId: string; message: string; closeAt: string | null; halted: Trading["halted"]; source: Trading["source"] };

/** null = market open for orders; else the refusal. */
export function tradingRefusal(id: string, t: Trading): TradingRefusal | null {
  if (t.status === "open") return null;
  return {
    error: t.status === "halted" ? "market_halted" : "market_closed",
    marketId: id,
    message:
      t.status === "halted"
        ? `Trading on ${id} is halted by SMX${t.halted?.reason ? ` (${t.halted.reason})` : ""}. Do not submit orders.`
        : `Trading on ${id} closed${t.closeAt ? ` at ${t.closeAt}` : ""}. Do not submit orders.`,
    closeAt: t.closeAt,
    halted: t.halted,
    source: t.source,
  };
}
