/**
 * Trading close config (off-chain; v1 contracts have no trading end). Mirrors the agent API's
 * SMX_MARKET_CLOSES_JSON so the order builder can enforce closes even while GET /agent/trading is
 * not deployed. Precedence: SMX API status > SMX_MARKET_CLOSES_JSON env > this table > chain resolutionDate.
 */
export const DEFAULT_CLOSES: Record<string, string> = {
  "fcc-25mhz-fnprm-oct29-test": "2026-10-28T14:30:00.000Z", // Legal: 28 Oct 2026 10:30 AM ET
  "f9-crs35-liftoff-test": "2026-10-13T10:18:44.000Z",
  "f9-crs35-land-test": "2026-10-13T10:18:44.000Z",
  "f9-ussf481-liftoff-test": "2026-10-15T23:29:00.000Z",
  "f9-ussf481-land-test": "2026-10-15T23:29:00.000Z",
};

export function configuredClose(id: string): string | null {
  try {
    const env = process.env.SMX_MARKET_CLOSES_JSON;
    if (env) { const j = JSON.parse(env) as Record<string, string>; if (typeof j[id] === "string") return new Date(j[id]).toISOString(); }
  } catch { /* ignore malformed env */ }
  return DEFAULT_CLOSES[id] ?? null;
}
