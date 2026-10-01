/** Space Markets Index (SMI) helpers. SMI output never carries market prices. */
import { SMI_ATTRIBUTION_FALLBACK, SMI_PUBLISHER, SMI_SEPARATION_NOTE } from "./copy.js";

/** Drop every key naming a price, recursively (same rule as the SMI API). */
export function stripPrices<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripPrices) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/price/i.test(k)) continue;
      out[k] = stripPrices(val);
    }
    return out as T;
  }
  return v;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Attribution and disclaimer block attached to every SMI tool result (text taken from latest.json when present). */
export function smiFooter(latest?: unknown) {
  const a = isObj(latest) && isObj(latest.attribution) ? (latest.attribution as Obj) : SMI_ATTRIBUTION_FALLBACK;
  return {
    publisher: SMI_PUBLISHER,
    attribution: stripPrices(a),
    disclaimer: String(a.notice ?? SMI_ATTRIBUTION_FALLBACK.notice),
    separation: SMI_SEPARATION_NOTE,
  };
}

export function summarizeLatest(d: Obj) {
  const order = Array.isArray(d.sub_index_order) ? (d.sub_index_order as string[]) : Object.keys((d.sub_indices as Obj) ?? {});
  const subs = (d.sub_indices as Obj) ?? {};
  const sub_indices = order.map((key) => {
    const s = (subs[key] as Obj) ?? {};
    if (s.published === false) return { key, published: false, note: "Not published." };
    return {
      key,
      id: s.id,
      name: s.name,
      published: s.published ?? true,
      maturity: s.maturity,
      status: s.status,
      summary: s.row,
      data_to: s.data_to,
      read_time_utc: isObj(s.read_time) ? s.read_time.utc : undefined,
      may_revise: s.may_revise,
      information_only: s.information_only,
      rules_url: s.rules_url,
    };
  });
  return stripPrices({
    index: "Space Markets Index (SMI)",
    smi_version: d.smi_version,
    schema_version: d.schema_version,
    print_id: d.print_id,
    read_time: d.read_time,
    headline: d.headline,
    weekly: d.weekly,
    ytd: d.ytd,
    sub_index_order: order,
    sub_indices,
    links: d.links,
  });
}
