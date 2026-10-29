/**
 * SMX MCP server configuration. Base Sepolia (eip155:84532) testnet only.
 * Every value here is public (contract addresses, public URLs). No keys are read or bundled; all tools are free.
 */
import { getAddress } from "viem";

export const SERVER_NAME = "smx-mcp";
export const SERVER_TITLE = "SMX by Space Markets (testnet)";
export const SERVER_VERSION = "0.2.2";

export const CHAIN_ID = 84532 as const;
export const NETWORK = "base-sepolia" as const;

const env = (k: string) => process.env[k]?.trim() || undefined;

/** Public SMX origin (agent API reads and SMI API are served here). */
export const SMX_ORIGIN = (env("SMX_ORIGIN") ?? "https://smx.space").replace(/\/$/, "");
export const SMI_API_BASE = `${SMX_ORIGIN}/smi-api`;
export const SMI_STATIC_BASE = `${SMX_ORIGIN}/smi`;
/** Read-only SMX indexer (clears, trades, candles, 24h stats, depth, account orders). Free. */
export const SMX_INDEXER = (env("SMX_INDEXER") ?? "https://smx-indexer-preview.fly.dev").replace(/\/$/, "");
/** SMX agent API base for trading status (GET /agent/trading). Defaults to the public SMX origin. */
export const SMX_API = (env("SMX_API") ?? SMX_ORIGIN).replace(/\/$/, "");
export const RPC_URL = env("SMX_RPC") ?? "https://sepolia.base.org";

/** Base Sepolia MarketRegistries, old book first. The second holds the TEST-V7/V8 markets live on testnet. */
export const DEFAULT_MARKET_REGISTRIES = [
  "0x8F3B0Ae76690ef0972aD3Cf9010797d266FcDa4a",
  "0xcD293b4B311845C023772CDd8738849E1a274AcD",
] as const;

/**
 * Comma-separated registry addresses (SMX_REGISTRIES). Invalid entries are dropped.
 * Duplicate addresses collapse. An empty or all-invalid value keeps the defaults.
 * Later entries win when the same market id is listed in more than one registry.
 */
export function parseRegistryList(raw: string | undefined, fallback: readonly string[] = DEFAULT_MARKET_REGISTRIES): string[] {
  if (raw === undefined) return [...fallback];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) continue;
    let addr: string;
    try { addr = getAddress(s); } catch { continue; }
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out.length ? out : [...fallback];
}

const marketRegistries = parseRegistryList(env("SMX_REGISTRIES"));

export const CONTRACTS = {
  /** First configured registry. Kept for callers that display a single address. */
  marketRegistry: marketRegistries[0] ?? DEFAULT_MARKET_REGISTRIES[0],
  /** Every registry to list, quote and trade. Override: SMX_REGISTRIES (comma list). */
  marketRegistries,
  /** Market ids hidden from listings (same default as the agent API). Override: SMX_HIDDEN_MARKETS (comma list; "" = hide none). */
  hiddenMarketIds: (env("SMX_HIDDEN_MARKETS") !== undefined ? env("SMX_HIDDEN_MARKETS")!.split(",").map((s) => s.trim()).filter(Boolean) : [
    "starship-reflight-mar27-test", "starship-reflight-jun27-test", "starship-reflight-dec27-test",
    "starship-shipcatch-nov26-test", "starship-shipcatch-dec26-test", "starship-shipcatch-mar27-test",
  ]) as readonly string[],
  factory: "0x409cFe0157aE3Ec2C321F97422a4bFc539c4b28a",
  testUsdcCollateral: "0x5882C96199e09771b01cFDC51eDea1D5814fc4E1",
} as const;

/** Display titles (titles are not stored on chain). Same table as the agent API. */
export const MARKET_TITLES: Record<string, string> = {
  "moon-race-us-china-test-v2": "The Moon Race",
  "moon-race-us-china-test-v3": "The Moon Race",
  "moon-race-us-china-test": "The Moon Race",
  "us-china-moon-test": "The Moon Race",
  moonrace: "The Moon Race",
  "starship-payload-orbit-test": "Starship payload to orbit",
  "starcloud-orbital-compute-test": "Starcloud (orbital compute)",
  "star-catcher-power-beam-test": "Star Catcher (power beaming)",
  "star-catcher-power-beam-test-v2": "Star Catcher (power beaming)",
  "starship-f14-splashdown-test": "Starship Flight 14: controlled splashdown",
};

/** Plain-language questions for the published app markets (from the published rules). */
export const MARKET_QUESTIONS: Record<string, string> = {
  "moon-race-us-china-test-v2":
    "Will the United States achieve a qualifying crewed lunar landing before China? YES = United States, NO = China.",
  "starship-payload-orbit-test": "Will Starship deploy a payload to orbit before 11:59 PM ET on 31 Dec 2026?",
  "starcloud-orbital-compute-test":
    "Will any commercial company run a continuous 24-hour AI or high-performance computing workload entirely in orbit before 11:59 PM ET on 30 Jun 2027?",
  "star-catcher-power-beam-test":
    "Will Star Catcher complete a successful in-orbit power-beaming demonstration before 11:59 PM ET on 31 Dec 2026?",
  "starship-f14-splashdown-test":
    "Will the Starship upper stage complete its planned Flight 14 and make a controlled splashdown?",
};

export const LINKS = {
  app: `${SMX_ORIGIN}/app/`,
  skill: `${SMX_ORIGIN}/skill.md`,
  llms: `${SMX_ORIGIN}/llms.txt`,
  openapi: `${SMX_ORIGIN}/openapi.yaml`,
  smiPage: `${SMX_ORIGIN}/smi/`,
  smiSkill: `${SMI_API_BASE}/skill.md`,
  explorer: "https://sepolia.basescan.org",
} as const;

export const HTTP_TIMEOUT_MS = Number(env("SMX_HTTP_TIMEOUT_MS") ?? "20000");
