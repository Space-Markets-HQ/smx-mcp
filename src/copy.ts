/** Fixed copy. Say SMX / Space Markets. SMI copy stays separate from SMX market copy. */

export const TESTNET_NOTICE =
  "Testnet only (Base Sepolia, chain id 84532). Test tokens have no monetary value and are not redeemable. Not affiliated with or endorsed by SpaceX.";

export const PAID_NOTICE =
  "Paid read: $0.01 in Circle testnet USDC on Base Sepolia via x402, testnet USDC, no real value. Paid from your own wallet key (X402_PRIVATE_KEY); this server never holds or bundles a key.";

export const LIQUIDITY_NOTE = "Prices are thin. Most resting orders currently come from SMX's own test account.";

export const NO_TRADING_NOTE =
  "This MCP server cannot place, cancel or claim orders and never resolves markets. Orders are signed by your own wallet on Base Sepolia; see smx_trading_guide.";

/** Stranded-fill rule (v1 contracts). Same rule as skill.md step 7 and the SMX unclaimed-fill guard. */
export const STRANDED_FILL_RULE =
  "Never cancel an order that has an unclaimed fill. On the current SMX testnet contracts, cancelling an order with an unclaimed fill forfeits that fill. Check orderBook.fills(orderId, n) for every batch n up to orderBook.batchNonce(); if any filledQty > 0, call orderBook.claim(orderId, n) first. Use smx_check_cancel_safety before any cancel.";

export const SMI_PUBLISHER = "Space Markets, Inc.";

/** Fallback SMI attribution if the upstream object is missing (kept identical to the published text). */
export const SMI_ATTRIBUTION_FALLBACK = {
  citation: "data from GCAT (J. McDowell, planet4589.org/space/gcat)",
  license: "CC BY 4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  modified_by: "modified by Space Markets",
  publisher: SMI_PUBLISHER,
  notice: "Not affiliated with or endorsed by SpaceX. Data only, not advice.",
};

export const SMI_SEPARATION_NOTE =
  "SMI is information only and contains no SMX market data. SMI and SMX markets are separate products.";

/** Words SMI tool descriptions must not use (Nick / Legal copy rules). */
export const SMI_FORBIDDEN = [
  "settle",
  "settlement",
  "benchmark",
  "live",
  "real-time",
  "realtime",
  "reference rate",
  "official",
  "tradeable",
  "tradable",
  "signal",
];

/** Words no tool description may use. */
/** The old internal codename is assembled so the word itself never ships in copy. */
export const GLOBAL_FORBIDDEN = [["pre", "dix"].join(""), "mock", "odds", "mainnet", "trade the index"];
