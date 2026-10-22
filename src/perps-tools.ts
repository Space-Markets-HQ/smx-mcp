/**
 * SMX testnet perps tools (Base Sepolia, MockUSDC). Thin proxy over the SMX perps API /perps/v0
 * (SMX_PERPS_API, default https://smx-perps-preview.fly.dev/perps/v0). Covers every registered market on
 * both engines (v1 equity perps; v2 engine 0x04334bfd... / vault 0x7a1e3b77... for PERP-XRAY and countdowns).
 * Returns UNSIGNED transactions only; this server never signs or holds keys. Errors carry a machine-readable `code`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getJson, UA } from "./fetch.js";
import { HTTP_TIMEOUT_MS } from "./config.js";
import { fetchSmx } from "./telemetry.js";

export const SMX_PERPS_API = (process.env.SMX_PERPS_API ?? "https://smx-perps-preview.fly.dev/perps/v0").replace(/\/$/, "");
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const MKT = z.string().regex(/^PERP-[A-Z0-9]{1,20}$/).describe("Perps market id from perps_list_markets, e.g. PERP-XRAY.");
const ADDR = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your own wallet address. Never a private key.");
type Ok = (s: string, d: Record<string, unknown>) => CallToolResult;
type Fail = (t: string, e?: Record<string, unknown>) => CallToolResult;

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetchSmx(fetch, `${SMX_PERPS_API}${path}`, { "content-type": "application/json", accept: "application/json", "user-agent": UA }, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  return { status: r.status, body: await r.json().catch(() => ({ error: "bad json", code: "unavailable" })) };
}

/** Defence in depth: only pass through unsigned Base Sepolia txs {to, data, value, chainId}. */
export function assertUnsigned(r: { status: number; body: any }) {
  const txs = r.body?.transactions;
  if (r.status !== 200 || !Array.isArray(txs)) return r;
  const bad = txs.find((t: any) => !t || typeof t.to !== "string" || typeof t.data !== "string" || Number(t.chainId ?? 84532) !== 84532 || ["signature", "rawTransaction", "signedTransaction", "r", "s", "v", "privateKey"].some((k) => k in t));
  return bad ? { status: 502, body: { error: "perps API returned a non-unsigned or non-Base-Sepolia transaction; refused", code: "unsafe_tx" } } : r;
}

export function registerPerpsTools(server: McpServer, ok: Ok, fail: Fail) {
  const call = async (p: Promise<{ status: number; body: any }>, summary: (b: any) => string) => {
    try {
      const { status, body } = await p;
      if (status !== 200 || body?.error) return fail(`${body?.code ?? "error"}: ${body?.error ?? status}`, { error: body?.error, code: body?.code ?? (status === 404 ? "not_found" : "unavailable") });
      return ok(summary(body), { ...body, source: SMX_PERPS_API });
    } catch (e) { return fail(`unavailable: ${(e as Error).message}`, { code: "unavailable" }); }
  };
  const get = (path: string) => getJson(`${SMX_PERPS_API}${path}`) as Promise<{ status: number; body: any }>;

  server.registerTool("perps_list_markets", {
    title: "SMX perps: list markets", annotations: { ...RO, title: "SMX perps markets" }, inputSchema: {},
    description: "All SMX testnet perps markets (both engines) with max leverage, engine/vault addresses, rules and status {opens_allowed, reduce_only, reason}. Testnet MockUSDC, no real money.",
  }, async () => call(get("/markets?status=1"), (b) => `${b.markets?.length} perps markets; opens allowed on ${b.markets?.filter((m: any) => m.status?.opens_allowed).length}.`));

  server.registerTool("perps_quote", {
    title: "SMX perps: quote", annotations: { ...RO, title: "SMX perps quote" },
    description: "Indicative fill price, margin and liquidation price for a perps order, plus reduce-only status. No execution.",
    inputSchema: { market: MKT, side: z.enum(["long", "short"]), size_musdc: z.number().positive(), leverage: z.number().positive().optional() },
  }, async ({ market, side, size_musdc, leverage }) => call(get(`/quote?${new URLSearchParams({ market, side, size_musdc: String(size_musdc), leverage: String(leverage ?? 1) })}`), (b) => `${market} ${side}: fill ${b.fill_px}, liq ${b.liq_px}.`));

  server.registerTool("perps_build_order", {
    title: "SMX perps: build unsigned order", annotations: { ...RO, title: "SMX perps build (unsigned)" },
    description: "Builds UNSIGNED Base Sepolia transactions: faucet (MockUSDC), open (side + margin_musdc+leverage or size_musdc; MockUSDC approve included when needed; pass address to skip a redundant approve) or close (position_id; close_size_musdc 0 = full; always reduce-only). Sign and send in order from your own wallet within 60s. Refused opens return code market_closed with the reason.",
    inputSchema: {
      action: z.enum(["faucet", "open", "close"]), market: MKT.optional(), side: z.enum(["long", "short"]).optional(),
      margin_musdc: z.number().positive().optional(), leverage: z.number().positive().optional(), size_musdc: z.number().positive().optional(),
      max_slippage_bps: z.number().int().min(0).max(500).optional(), position_id: z.number().int().min(0).optional(),
      close_size_musdc: z.number().min(0).optional(), amount_musdc: z.number().positive().max(10000).optional(), address: ADDR.optional(),
    },
  }, async (a) => call(post("/order/build", a).then(assertUnsigned), (b) => `${b.transactions?.length} unsigned tx(s) for ${a.action}${a.market ? " " + a.market : ""}; expires ${b.expires_ts ?? "n/a"}.`));

  server.registerTool("perps_positions", {
    title: "SMX perps: positions", annotations: { ...RO, title: "SMX perps positions" },
    description: "Open perps positions for a wallet on both engines, with close_value_musdc (what a full close returns now), equity, market reduce-only status and a ready close_build payload for perps_build_order.",
    inputSchema: { address: ADDR },
  }, async ({ address }) => call(get(`/positions/${address}`), (b) => `${b.positions?.length ?? 0} open perps positions.`));

  server.registerTool("perps_account", {
    title: "SMX perps: account and faucet", annotations: { ...RO, title: "SMX perps account" },
    description: "Wallet readiness: Base Sepolia ETH (gas), MockUSDC balance, allowances to both engines, contract addresses and faucet info (max 10,000 MockUSDC/day via perps_build_order action=faucet).",
    inputSchema: { address: ADDR },
  }, async ({ address }) => call(get(`/account/${address}`), (b) => `MockUSDC ${b.musdc_balance}, gas ETH ${b.eth_gas_balance}.`));
}
