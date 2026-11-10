/**
 * Short rules text for SMX testnet markets, from the public indexer (GET /v1/markets).
 * Cached for 60 seconds. A timeout, HTTP error or bad payload returns an empty map and never throws,
 * so smx_list_markets and smx_get_market still succeed with null rules fields.
 */
import { SMX_INDEXER } from "./config.js";
import { getJson } from "./fetch.js";

export const RULES_CACHE_MS = 60_000;
export const RULES_TIMEOUT_MS = 4_000;
export const RULES_SOURCE = `${SMX_INDEXER}/v1/markets`;

export type IndexerRule = {
  /** rules.summary when the indexer has it, otherwise why. */
  rules: string | null;
  rulesHash: string | null;
  /** rules.close when present, otherwise tradingEnd. */
  close: string | null;
  question: string | null;
  rulesVersion: string | number | null;
};

function asText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length ? s : null;
}

function asVersion(v: unknown): string | number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return asText(v);
}

/** One indexer market object. Null when it has no id. */
export function ruleFromIndexerMarket(m: unknown): { id: string; rule: IndexerRule } | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const id = asText(o.id) ?? asText(o.marketId);
  if (!id) return null;
  const rules = o.rules && typeof o.rules === "object" ? (o.rules as Record<string, unknown>) : undefined;
  return {
    id,
    rule: {
      rules: (rules ? asText(rules.summary) : null) ?? asText(o.why),
      rulesHash: asText(o.rulesHash) ?? (rules ? asText(rules.hash) : null),
      close: (rules ? asText(rules.close) : null) ?? asText(o.tradingEnd),
      question: asText(o.question),
      rulesVersion: rules ? asVersion(rules.version) : null,
    },
  };
}

/** Parsed rules, or null when the body is not a market list (so the caller does not cache it). */
export function rulesFromBody(body: unknown): Map<string, IndexerRule> | null {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { markets?: unknown }).markets)
      ? (body as { markets: unknown[] }).markets
      : null;
  if (!list) return null;
  const map = new Map<string, IndexerRule>();
  for (const item of list) {
    const row = ruleFromIndexerMarket(item);
    if (row) map.set(row.id, row.rule);
  }
  return map;
}

let cache: { at: number; map: Map<string, IndexerRule> } | null = null;
let inflight: Promise<Map<string, IndexerRule>> | null = null;

/** Drops the in-process cache. Tests use this so cases do not share a fetch. */
export function clearRulesCache(): void {
  cache = null;
  inflight = null;
}

async function loadRules(nowMs: number): Promise<Map<string, IndexerRule>> {
  try {
    const { status, body } = await getJson(RULES_SOURCE, RULES_TIMEOUT_MS);
    if (status !== 200) return new Map();
    const map = rulesFromBody(body);
    if (!map) return new Map();
    cache = { at: nowMs, map };
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Rules keyed by market id. `nowMs` is the clock for the 60s cache (tests pass it; callers omit it).
 * Never throws: indexer failures return an empty map and are not cached.
 */
export async function fetchRules(nowMs = Date.now()): Promise<Map<string, IndexerRule>> {
  try {
    if (cache && nowMs >= cache.at && nowMs - cache.at < RULES_CACHE_MS) return cache.map;
    if (inflight) return inflight;
    const pending = loadRules(nowMs).finally(() => {
      if (inflight === pending) inflight = null;
    });
    inflight = pending;
    return await pending;
  } catch {
    return new Map();
  }
}
