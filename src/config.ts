/**
 * SMX MCP server configuration. Base Sepolia (eip155:84532) testnet only.
 * Every value here is public (contract addresses, public URLs, the public x402 receiver).
 * No private keys are ever bundled: paid tools read the caller's own key from the environment.
 */
export const SERVER_NAME = "smx-mcp";
export const SERVER_TITLE = "SMX by Space Markets (testnet)";
export const SERVER_VERSION = "0.1.2";

export const CHAIN_ID = 84532 as const;
export const NETWORK = "base-sepolia" as const;
export const X402_NETWORK = "eip155:84532" as const;

const env = (k: string) => process.env[k]?.trim() || undefined;

/** Public SMX origin (agent API reads and SMI API are served here). */
export const SMX_ORIGIN = (env("SMX_ORIGIN") ?? "https://smx.space").replace(/\/$/, "");
export const SMI_API_BASE = `${SMX_ORIGIN}/smi-api`;
export const SMI_STATIC_BASE = `${SMX_ORIGIN}/smi`;
export const RPC_URL = env("SMX_RPC") ?? "https://sepolia.base.org";

export const CONTRACTS = {
  marketRegistry: "0x8F3B0Ae76690ef0972aD3Cf9010797d266FcDa4a",
  factory: "0x409cFe0157aE3Ec2C321F97422a4bFc539c4b28a",
  testUsdcCollateral: "0x5882C96199e09771b01cFDC51eDea1D5814fc4E1",
} as const;

/** x402 payment expectations. A 402 challenge that differs from these is refused before signing. */
export const X402_EXPECT = {
  network: X402_NETWORK,
  /** Circle USDC on Base Sepolia (testnet). */
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: (env("SMX_X402_PAY_TO") ?? "0x5799fe0715C04f479f7f80Fbe6C4CFb384A8E0e9").toLowerCase(),
  /** Max atomic units per call (6 decimals): 10000 = $0.01 test USDC. */
  maxAmountAtomic: BigInt(env("SMX_X402_MAX_ATOMIC") ?? "10000"),
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
