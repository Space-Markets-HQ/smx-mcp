/**
 * Write-tool JSON shapes (names, descriptions, input schemas, annotations) for SMX event-market orders.
 * Isolated on purpose: swap WRITE_TOOL_DEFS for Shaun's SDK tool JSON later without touching the builder
 * (order-build.ts). Tools return UNSIGNED transactions only; nothing is signed or sent here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildCancel, buildClaim, buildOrder } from "./order-build.js";
import { TESTNET_NOTICE } from "./copy.js";

const MID = z.string().regex(/^[A-Za-z0-9._#-]{1,64}$/).describe("Market id from smx_list_markets.");
const WALLET = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your own wallet address (EOA that owns the SMX Account). Never a private key.");
const BUILD = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const WRITE_TOOL_DEFS = {
  smx_build_order: {
    title: "SMX: build an unsigned order",
    description:
      "Builds UNSIGNED Base Sepolia transactions to place a limit order on an SMX testnet event market from your own wallet: Account.submitOrder on your own SMX Account, plus any needed Factory requestAccess/deployAccount, test USDC mint/approve and Account.deposit. Refuses closed or halted markets. Fee 0.25%. Returns {to, data, value, chainId, gas} per step; sign them yourself in order. This server never signs or holds keys.",
    inputSchema: {
      id: MID,
      outcome: z.enum(["Yes", "No"]).describe("Which outcome share."),
      action: z.enum(["buy", "sell"]).describe("buy or sell that outcome."),
      qty: z.number().int().min(1).describe("Shares (whole number)."),
      limitPrice: z.number().int().min(1).max(99).describe("Limit price in cents of the chosen outcome, 1-99 (1% grid)."),
      wallet: WALLET,
      mintTestUsdc: z.boolean().optional().describe("Add a test USDC mint step if the wallet lacks collateral. Default true."),
    },
    annotations: { ...BUILD, title: "SMX build order (unsigned)" },
  },
  smx_build_cancel: {
    title: "SMX: build an unsigned cancel",
    description:
      "Builds UNSIGNED transactions to cancel one of your resting orders via Account.cancelOrder on your own SMX Account. Any unclaimed fills on that order get claim transactions first (cancelling with an unclaimed fill forfeits it on v1 contracts). Never signs.",
    inputSchema: { id: MID, wallet: WALLET, orderId: z.number().int().min(0).describe("Order id (smx_get_account_orders).") },
    annotations: { ...BUILD, title: "SMX build cancel (unsigned)" },
  },
  smx_build_claim: {
    title: "SMX: build unsigned claims",
    description:
      "Builds UNSIGNED OrderBook.claim(orderId, batchNonce) transactions for every unclaimed fill of your SMX Account in one market, so fills count as a position. Order ids default to your indexed history. Each claim is checked by eth_call first. Never signs.",
    inputSchema: { id: MID, wallet: WALLET, orderIds: z.array(z.number().int().min(0)).max(50).optional().describe("Limit to these order ids.") },
    annotations: { ...BUILD, title: "SMX build claim (unsigned)" },
  },
} as const;

type Ok = (summary: string, data: Record<string, unknown>) => CallToolResult;
type Fail = (text: string, extra?: Record<string, unknown>) => CallToolResult;

export function registerWriteTools(server: McpServer, ok: Ok, fail: Fail) {
  const wrap = async (f: () => Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; err: { error: string; message: string } }>, summary: (d: Record<string, unknown>) => string) => {
    try {
      const r = await f();
      if (!r.ok) return fail(`${r.err.error}: ${r.err.message}`, { ...r.err });
      return ok(summary(r.data), { ...r.data, notice: TESTNET_NOTICE });
    } catch (e) {
      return fail(`Build failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300)}`);
    }
  };
  const n = (d: Record<string, unknown>) => (d.transactions as unknown[]).length;
  server.registerTool("smx_build_order", WRITE_TOOL_DEFS.smx_build_order, async (a) =>
    wrap(() => buildOrder(a), (d) => `${n(d)} unsigned step(s) for ${a.action} ${a.qty} ${a.outcome} @ ${a.limitPrice}c on ${a.id}${d.complete ? "" : " (account setup first; call again after deployAccount)"}.`));
  server.registerTool("smx_build_cancel", WRITE_TOOL_DEFS.smx_build_cancel, async (a) =>
    wrap(() => buildCancel(a), (d) => `${n(d)} unsigned step(s) to cancel order ${a.orderId} on ${a.id}.`));
  server.registerTool("smx_build_claim", WRITE_TOOL_DEFS.smx_build_claim, async (a) =>
    wrap(() => buildClaim(a), (d) => `${n(d)} unsigned claim(s) on ${a.id}.`));
}
