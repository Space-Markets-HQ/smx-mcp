import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { allMarkets, bookDepth, idBytes, unclaimedFills, type MarketRow } from "./chain.js";
import { CHAIN_ID, CONTRACTS, LINKS, MARKET_QUESTIONS, NETWORK, SERVER_NAME, SERVER_TITLE, SERVER_VERSION, SMI_API_BASE, SMI_STATIC_BASE, SMX_ORIGIN } from "./config.js";
import { LIQUIDITY_NOTE, NO_TRADING_NOTE, PAID_NOTICE, STRANDED_FILL_RULE, TESTNET_NOTICE } from "./copy.js";
import { getJson } from "./fetch.js";
import { isResolved, midOf, minOrderOf, outcomeOf, quoteOf, stateNameV1, statusOf } from "./listing.js";
import { smiFooter, stripPrices, summarizeLatest } from "./smi.js";
import { KEY_ENV_VARS, paidGet, payerKey } from "./x402.js";
import { runWithTool } from "./telemetry.js";

export const INSTRUCTIONS = [
  "SMX by Space Markets, testnet only (Base Sepolia, chain id 84532). Two separate products:",
  "(1) Space Markets Index (SMI): information on orbital launch activity and other space-sector data, published by Space Markets, Inc. Tools start with smi_. SMI results contain no market prices.",
  "(2) SMX event markets: testnet markets priced in test USDC with no monetary value. Tools start with smx_.",
  "Free tools need no key. Paid tools (smi_get_history, smi_get_launch, smi_get_print, smx_paid_*) cost $0.01 in Circle testnet USDC via x402, testnet USDC, no real value, paid from the user's own key in X402_PRIVATE_KEY.",
  NO_TRADING_NOTE,
].join(" ");

const now = () => new Date().toISOString();
const common = () => ({ network: NETWORK, chainId: CHAIN_ID, testnet: true, notice: TESTNET_NOTICE, asOf: now() });

function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}
function fail(text: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { isError: true, content: [{ type: "text", text: extra && Object.keys(extra).length ? `${text}\n\n${JSON.stringify(extra, null, 2)}` : text }] };
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const PAID = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const SMI_SECTIONS = ["launch_access", "compute_energy", "connectivity_data", "spectrum_filings", "moon_deep_space"] as const;

function marketView(r: MarketRow, nowSec = Math.floor(Date.now() / 1000)) {
  const q = quoteOf(r.bestBid, r.bestAsk);
  const mid = midOf(r);
  return {
    id: r.marketId,
    title: r.title,
    question: MARKET_QUESTIONS[r.marketId] ?? null,
    state: stateNameV1(r.state),
    status: statusOf(r, nowSec),
    outcome: outcomeOf(r),
    // Resolved markets carry no price; the result is in `resolution`.
    yesPriceBps: isResolved(r) ? null : mid.midBps,
    yesPriceCents: isResolved(r) || mid.midBps === null ? null : mid.midBps / 100,
    priceSource: isResolved(r) ? "none (resolved)" : mid.midSource,
    resolution: isResolved(r) ? { outcome: outcomeOf(r), finalPriceBps: r.finalPrice ?? null, note: "Winning shares pay 1.00 test USDC; see smx_trading_guide step 10 to claim." } : null,
    bestBidBps: isResolved(r) ? null : q.bestBidBps,
    bestAskBps: isResolved(r) ? null : q.bestAskBps,
    minOrder: minOrderOf(r),
    resolutionDate: r.resolutionDate ? new Date(r.resolutionDate * 1000).toISOString() : null,
    orderBook: r.bookAddr,
    market: r.marketAddr,
    listed: r.listing.listed,
    ...(r.listing.listed ? {} : { excludedReason: r.listing.excludedReason, excludedDetail: r.listing.detail }),
  };
}

async function findMarket(id: string): Promise<MarketRow | undefined> {
  return (await allMarkets()).find((r) => r.marketId === id && (r.listing.listed || r.listing.excludedReason !== "internal-codename"));
}

function noKey(tool: string): CallToolResult {
  return fail(
    `${tool} is a paid read and no wallet key is configured, so no call was made and nothing was charged. ` +
      `Set ${KEY_ENV_VARS[0]} to a Base Sepolia TEST wallet private key that holds Circle testnet USDC (faucet: https://faucet.circle.com, choose Base Sepolia). ` +
      `Cost: $0.01 testnet USDC per call, no real value. Never use a wallet that holds real funds.`,
    { paid: true, priceUsd: "0.01", asset: "Circle testnet USDC on Base Sepolia", setup: `${KEY_ENV_VARS[0]}=0x<your testnet key>`, ...common() },
  );
}

async function paid(tool: string, url: string, summarize: (body: unknown) => string, isSmi: boolean): Promise<CallToolResult> {
  if (!payerKey()) return noKey(tool);
  try {
    const r = await paidGet(url);
    const body = isSmi ? stripPrices(r.body) : r.body;
    const data = {
      ...(isSmi ? { product: "Space Markets Index (SMI)", ...smiFooter(r.body) } : { product: "SMX event markets" }),
      httpStatus: r.status,
      charged: r.charged,
      payment: r.payment,
      paidNotice: PAID_NOTICE,
      data: body,
      ...common(),
    };
    if (r.status >= 400) return fail(`${tool}: HTTP ${r.status}${r.charged ? "" : " (not charged)"}.`, data);
    return ok(`${summarize(r.body)} ${r.charged ? "Charged $0.01 testnet USDC (no real value)." : "Not charged."}`, data);
  } catch (e) {
    const m = errMsg(e);
    return fail(`${tool} failed: ${m}`, { charged: "unknown; check your wallet on https://sepolia.basescan.org", ...common() });
  }
}

export type ServerOptions = { paidTools: boolean };

export function createServer(opts: ServerOptions = { paidTools: true }): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION, websiteUrl: SMX_ORIGIN },
    { instructions: INSTRUCTIONS },
  );
  // Every handler runs with its tool name in context, so outgoing SMX requests carry X-SMX-Tool.
  const register = server.registerTool.bind(server);
  (server as { registerTool: unknown }).registerTool = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
    register(name, config as never, ((...a: unknown[]) => runWithTool(name, () => cb(...a))) as never)) as never;

  // ---------------- SMI (free) ----------------
  server.registerTool(
    "smi_get_latest",
    {
      title: "SMI: latest print",
      description:
        "Space Markets Index (SMI), published by Space Markets, Inc.: the latest weekly print. Returns the headline figure (SMI Launch Cadence, with its formula) and a one-line summary of each sub-index: launch and access, compute and energy in orbit, connectivity and data, spectrum and filings, deep space and the Moon. Includes print id, data dates, rules links and the GCAT attribution. Information only; contains no market prices. Free, no key. Pass sub_index to get one sub-index in full.",
      inputSchema: { sub_index: z.enum(SMI_SECTIONS).optional().describe("Return this sub-index in full instead of the summary.") },
      annotations: { ...RO, title: "SMI latest print" },
    },
    async ({ sub_index }) => {
      try {
        const r = await getJson(`${SMI_API_BASE}/latest`);
        if (r.status !== 200 || typeof r.body !== "object") return fail(`SMI latest returned HTTP ${r.status}.`);
        const d = r.body as Record<string, unknown>;
        const footer = smiFooter(d);
        if (sub_index) {
          const s = ((d.sub_indices as Record<string, unknown>) ?? {})[sub_index];
          if (!s) return fail(`Sub-index ${sub_index} is not in print ${String(d.print_id)}.`);
          const data = { print_id: d.print_id, sub_index, detail: stripPrices(s), ...footer, source: `${SMI_API_BASE}/latest`, asOf: now() };
          return ok(`SMI print ${String(d.print_id)}, sub-index ${sub_index}. Published by Space Markets, Inc.`, data);
        }
        const sum = summarizeLatest(d);
        const h = (sum.headline ?? {}) as Record<string, unknown>;
        const data = { ...sum, ...footer, source: `${SMI_API_BASE}/latest`, page: LINKS.smiPage, asOf: now() };
        return ok(
          `SMI print ${String(sum.print_id)}: ${String(h.name ?? "headline")} ${String(h.value ?? "?")} (window ${JSON.stringify(h.window ?? {})}). Published by Space Markets, Inc. ${footer.disclaimer}`,
          data,
        );
      } catch (e) {
        return fail(`SMI latest read failed: ${errMsg(e)}`);
      }
    },
  );

  server.registerTool(
    "smi_get_methodology",
    {
      title: "SMI: methodology",
      description:
        "Space Markets Index (SMI) methodology, published by Space Markets, Inc.: version, change log, conflicts statement, the headline formula and the counting rules for each sub-index. Free, no key. Pass section to get one part.",
      inputSchema: {
        section: z.enum(["headline", ...SMI_SECTIONS, "change_log", "conflicts", "datapoints"]).optional().describe("Return only this section."),
      },
      annotations: { ...RO, title: "SMI methodology" },
    },
    async ({ section }) => {
      try {
        const r = await getJson(`${SMI_STATIC_BASE}/methodology.json`);
        if (r.status !== 200 || typeof r.body !== "object") return fail(`SMI methodology returned HTTP ${r.status}.`);
        const d = stripPrices(r.body as Record<string, unknown>);
        const footer = smiFooter();
        const body = section ? { [section]: d[section] ?? null } : d;
        return ok(
          `SMI methodology ${String(d.methodology_version ?? "")} (${String(d.status ?? "")}). Published by Space Markets, Inc.`,
          { methodology_version: d.methodology_version, schema_version: d.schema_version, ...body, ...footer, source: `${SMI_STATIC_BASE}/methodology.json`, asOf: now() },
        );
      } catch (e) {
        return fail(`SMI methodology read failed: ${errMsg(e)}`);
      }
    },
  );

  // ---------------- SMX markets (free, from chain) ----------------
  server.registerTool(
    "smx_list_markets",
    {
      title: "SMX: list markets",
      description:
        "List SMX event markets on Base Sepolia testnet, read directly from the on-chain MarketRegistry with the same listing rules as the SMX agent API. Per market: id, title, state (Open/Resolved), status, outcome, best bid and ask, YES midpoint in basis points (5000 = 50 cents) and minimum order. Free, no key. Test USDC, no monetary value.",
      inputSchema: { include_unlisted: z.boolean().optional().describe("Also return drills, superseded versions and other unlisted registry entries, with the reason.") },
      annotations: { ...RO, title: "SMX markets" },
    },
    async ({ include_unlisted }) => {
      try {
        const rows = await allMarkets();
        const nowSec = Math.floor(Date.now() / 1000);
        // Internal engineering markets are never shown, even with include_unlisted.
        const visible = rows.filter((r) => r.listing.listed || r.listing.excludedReason !== "internal-codename");
        const markets = visible.filter((r) => include_unlisted || r.listing.listed).map((r) => marketView(r, nowSec));
        const data = { markets, count: markets.length, registryCount: rows.length, hiddenInternal: rows.length - visible.length, source: `MarketRegistry ${CONTRACTS.marketRegistry} (Base Sepolia)`, liquidityNote: LIQUIDITY_NOTE, units: "Prices in basis points of 1 test USDC per share: 5000 = 50 cents.", ...common() };
        const line = markets.map((m) => `${m.id} (${m.status}${m.yesPriceBps !== null ? `, YES ${m.yesPriceCents}c` : ""}${m.outcome ? `, ${m.outcome}` : ""})`).join("; ");
        return ok(`${markets.length} SMX testnet markets: ${line}.`, data);
      } catch (e) {
        return fail(`Chain read failed: ${errMsg(e)}`);
      }
    },
  );

  server.registerTool(
    "smx_get_market",
    {
      title: "SMX: market detail and order book",
      description:
        "One SMX testnet market: question, state, outcome if resolved, best bid and ask, YES midpoint, minimum order, contract addresses and the resting order book aggregated by price level (read from chain). Free, no key. Test USDC, no monetary value.",
      inputSchema: { id: z.string().min(1).max(64).describe("Market id from smx_list_markets, e.g. moon-race-us-china-test-v2.") },
      annotations: { ...RO, title: "SMX market detail" },
    },
    async ({ id }) => {
      try {
        const r = await findMarket(id);
        if (!r) return fail("Unknown market id. Call smx_list_markets for valid ids.");
        const depth = isResolved(r) || !r.nextOrderId ? { bids: [], asks: [], activeOrdersScanned: 0 } : await bookDepth(r.bookAddr, r.nextOrderId);
        const data = {
          ...marketView(r),
          book: {
            ...depth,
            batchNonce: r.batchNonce ?? null,
            activeOrderCount: r.activeOrderCount ?? null,
            isCrossed: r.isCrossed ?? null,
            clearableAt: r.clearableAt ? new Date(r.clearableAt * 1000).toISOString() : null,
            priceUnits: "YES-terms basis points for both sides. Bids are YES buys; asks are YES sells, i.e. NO buys at 10000 minus the price.",
          },
          contracts: { marketRegistry: CONTRACTS.marketRegistry, factory: CONTRACTS.factory, collateralToken: CONTRACTS.testUsdcCollateral, orderBook: r.bookAddr, market: r.marketAddr },
          liquidityNote: LIQUIDITY_NOTE,
          links: { app: LINKS.app, skill: LINKS.skill, explorer: `${LINKS.explorer}/address/${r.bookAddr}` },
          ...common(),
        };
        return ok(`${r.title} (${r.marketId}): ${data.status}${data.resolution ? `, outcome ${data.resolution.outcome}` : data.yesPriceBps !== null ? `, YES ${data.yesPriceCents}c (${data.priceSource})` : ", no quote"}.`, data);
      } catch (e) {
        return fail(`Chain read failed: ${errMsg(e)}`);
      }
    },
  );

  server.registerTool(
    "smx_trading_guide",
    {
      title: "SMX: how to trade from your own wallet",
      description:
        "How to place, cancel and claim SMX testnet orders from your own wallet on Base Sepolia. This server cannot trade; it returns the exact steps, contract addresses, order rules and the claim-before-cancel safety rule. Free, no key.",
      inputSchema: { id: z.string().max(64).optional().describe("Optional market id; fills in that market's order book address.") },
      annotations: { ...RO, openWorldHint: false, title: "SMX trading guide" },
    },
    async ({ id }) => {
      let orderBook: string | null = null;
      if (id) {
        try { orderBook = (await findMarket(id))?.bookAddr ?? null; } catch { orderBook = null; }
        if (!orderBook) return fail("Unknown market id. Call smx_list_markets for valid ids.");
      }
      const data = {
        summary: NO_TRADING_NOTE,
        safetyRule: STRANDED_FILL_RULE,
        neverDo: ["Cancel an order that has an unclaimed fill (claim first).", "Use a wallet that holds real funds.", "Send transactions on any chain other than Base Sepolia (84532)."],
        steps: [
          { n: 1, action: "Request access", call: "Factory.requestAccess() from your wallet" },
          { n: 2, action: "Auto-approve", call: 'POST https://smx.space/app/__approve {"address":"0xYourWallet","chainId":84532}', check: "Factory.access(wallet) == 2" },
          { n: 3, action: "Create trading account", call: "Factory.deployAccount(); then Factory.accountOf(wallet)" },
          { n: 4, action: "Get test USDC collateral", call: "TestUSDC.mint(wallet, amount) (6 decimals; 1000000000 = 1,000 test USDC)" },
          { n: 5, action: "Fund the account", call: "TestUSDC.approve(account, amount); account.deposit(amount)" },
          { n: 6, action: "Place", call: "account.submitOrder(orderBook, side 0=YES 1=NO, priceBps in YES terms, qty)", check: "OrderSubmitted event" },
          { n: 7, action: "Clear", call: "orderBook.clearBatch() (anyone; when isCrossed() and after clearableAt())" },
          { n: 8, action: "Claim fills right after each clear", call: "orderBook.claim(orderId, batchNonce)" },
          { n: 9, action: "Cancel (only with no unclaimed fill)", call: "smx_check_cancel_safety first, then account.cancelOrder(orderBook, orderId)" },
          { n: 10, action: "After resolution", call: "orderBook.claimSettlement(account, orderIds) after claiming every fill" },
        ],
        orderRules: {
          priceUnits: "basis points in YES terms for both sides (a NO at 48 cents is sent as 5200)",
          minOrder: "shares x price >= 10000 (price in bps of the side you buy), so at least ceil(10000 / price) shares",
          fee: "0.25% x shares x (1 - price), charged at placement, refunded in full on cancel of an order with no fills",
        },
        contracts: { factory: CONTRACTS.factory, marketRegistry: CONTRACTS.marketRegistry, collateralToken: CONTRACTS.testUsdcCollateral, ...(orderBook ? { orderBook } : {}) },
        tokens: "Order collateral is SMX test USDC (0x5882...c4E1). x402 paid reads use Circle testnet USDC (0x036C...CF7e). They are different tokens; neither has monetary value.",
        links: { skill: LINKS.skill, llms: LINKS.llms, openapi: LINKS.openapi, app: LINKS.app },
        disabledApiRoutes: "POST /agent/order and /agent/cancel return 403 wallet_signed_only and are never charged.",
        ...common(),
      };
      return ok(`Trade SMX testnet markets from your own wallet. ${STRANDED_FILL_RULE}`, data);
    },
  );

  server.registerTool(
    "smx_check_cancel_safety",
    {
      title: "SMX: check an order for unclaimed fills",
      description:
        "Before cancelling SMX testnet orders from your own wallet, check each order for unclaimed fills. Returns safeToCancel=false and the claim calls to make if any fill is unclaimed (cancelling it would forfeit the fill on the current contracts). Read-only; never cancels or claims. Free, no key. Read-only check of on-chain state at the time of the call, provided as-is. Verify before acting.",
      inputSchema: {
        id: z.string().min(1).max(64).describe("Market id from smx_list_markets."),
        order_ids: z.array(z.number().int().nonnegative()).min(1).max(50).describe("Your order ids on that market's order book."),
      },
      annotations: { ...RO, title: "SMX cancel safety check" },
    },
    async ({ id, order_ids }) => {
      try {
        const r = await findMarket(id);
        if (!r) return fail("Unknown market id. Call smx_list_markets for valid ids.");
        const { batchNonce, fills, unreadable } = await unclaimedFills(r.bookAddr, order_ids);
        const safe = fills.length === 0 && unreadable.length === 0;
        const claimable = fills.filter((f) => f.claimSimulation === "ok");
        const stranded = fills.filter((f) => f.claimSimulation !== "ok");
        const data = {
          marketId: id,
          orderBook: r.bookAddr,
          orderIds: order_ids,
          batchNonce,
          safeToCancel: safe,
          unclaimedFills: fills,
          unreadableChecks: unreadable,
          claimFirst: claimable.map((f) => `orderBook.claim(${f.orderId}, ${f.batchNonce})`),
          strandedFills: stranded.length
            ? { fills: stranded, note: "claim() does not succeed in simulation for these fills (likely already stranded by an earlier cancel). Do not cancel; report the order ids to SMX via https://smx.space." }
            : null,
          rule: STRANDED_FILL_RULE,
          ...common(),
        };
        const msg = safe
          ? `No unclaimed fills on order(s) ${order_ids.join(", ")} (checked batches 1-${batchNonce}). Safe to cancel under the claim-before-cancel rule.`
          : fills.length
            ? `DO NOT CANCEL: ${fills.length} unclaimed fill(s).${claimable.length ? ` Claim first: ${data.claimFirst.join("; ")}.` : ""}${stranded.length ? ` ${stranded.length} fill(s) cannot be claimed in simulation (${stranded.map((f) => `order ${f.orderId} batch ${f.batchNonce}: ${f.claimSimulation}`).join("; ")}); report to SMX.` : ""}`
            : `DO NOT CANCEL yet: ${unreadable.length} fill check(s) could not be read; retry.`;
        return ok(msg, data);
      } catch (e) {
        return fail(`Chain read failed: ${errMsg(e)}. Treat the order as NOT safe to cancel until the check succeeds.`);
      }
    },
  );

  if (!opts.paidTools) return server;

  // ---------------- Paid reads (x402, testnet USDC) ----------------
  const paidSuffix = " Paid: $0.01 in Circle testnet USDC on Base Sepolia via x402, testnet USDC, no real value, charged to your own wallet key in X402_PRIVATE_KEY (without it the tool makes no call). Errors (400/404) are not charged.";

  server.registerTool(
    "smi_get_history",
    {
      title: "SMI: weekly history (paid)",
      description: `Space Markets Index (SMI), published by Space Markets, Inc.: weekly orbital launch counts for the year so far, with totals and GCAT attribution. Information only; contains no market prices.${paidSuffix}`,
      inputSchema: {},
      annotations: { ...PAID, title: "SMI history (paid)" },
    },
    async () => paid("smi_get_history", `${SMI_API_BASE}/history`, (b) => {
      const t = (b as { totals?: Record<string, unknown>; print_id?: string }) ?? {};
      return `SMI history (print ${t.print_id ?? "?"}): ${JSON.stringify(t.totals ?? {})}. Published by Space Markets, Inc.`;
    }, true),
  );

  server.registerTool(
    "smi_get_launch",
    {
      title: "SMI: one launch record (paid)",
      description: `Space Markets Index (SMI), published by Space Markets, Inc.: one orbital launch by GCAT launch id (e.g. 2026-221): date, rocket, mission, agency, payloads and mass status. Information only.${paidSuffix}`,
      inputSchema: { launch_id: z.string().regex(/^\d{4}-\d{3}$/).describe("GCAT launch id, e.g. 2026-221.") },
      annotations: { ...PAID, title: "SMI launch (paid)" },
    },
    async ({ launch_id }) => paid("smi_get_launch", `${SMI_API_BASE}/launch/${encodeURIComponent(launch_id)}`, () => `SMI launch record ${launch_id}. Published by Space Markets, Inc.`, true),
  );

  server.registerTool(
    "smi_get_print",
    {
      title: "SMI: one print (paid)",
      description: `Space Markets Index (SMI), published by Space Markets, Inc.: one archived weekly print by print id (e.g. 2026-W39.r7). Information only; contains no market prices.${paidSuffix}`,
      inputSchema: { print_id: z.string().regex(/^\d{4}-W\d{2}(\.r\d+)?$/).describe("Print id, e.g. 2026-W39.r7.") },
      annotations: { ...PAID, title: "SMI print (paid)" },
    },
    async ({ print_id }) => paid("smi_get_print", `${SMI_API_BASE}/prints/${encodeURIComponent(print_id)}`, () => `SMI print ${print_id}. Published by Space Markets, Inc.`, true),
  );

  server.registerTool(
    "smx_paid_list_markets",
    {
      title: "SMX: market list from the agent API (paid)",
      description: `SMX agent API market list (GET /agent/markets): the listed SMX testnet markets with status, outcome, midpoint (midBps and midPriceCents) and minimum order, as served by the SMX agent API. Same data as smx_list_markets, which is free.${paidSuffix}`,
      inputSchema: { all: z.boolean().optional().describe("Include unlisted registry markets with the reason (?all=1).") },
      annotations: { ...PAID, title: "SMX market list (paid)" },
    },
    async ({ all }) => paid("smx_paid_list_markets", `${SMX_ORIGIN}/agent/markets${all ? "?all=1" : ""}`, (b) => {
      const n = Array.isArray((b as { markets?: unknown[] })?.markets) ? (b as { markets: unknown[] }).markets.length : "?";
      return `SMX agent API: ${n} markets.`;
    }, false),
  );

  server.registerTool(
    "smx_paid_get_market",
    {
      title: "SMX: market detail from the agent API (paid)",
      description: `SMX agent API market detail (GET /agent/markets/{id}): status, outcome, midpoint, minimum order and a book summary for one SMX testnet market.${paidSuffix}`,
      inputSchema: { id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).describe("Market id from smx_list_markets.") },
      annotations: { ...PAID, title: "SMX market detail (paid)" },
    },
    async ({ id }) => paid("smx_paid_get_market", `${SMX_ORIGIN}/agent/markets/${encodeURIComponent(id)}`, () => `SMX agent API detail for ${id}.`, false),
  );

  server.registerTool(
    "smx_paid_get_mid",
    {
      title: "SMX: market midpoint from the agent API (paid)",
      description: `SMX agent API midpoint (GET /v1/markets/{id}/mid) for one SMX testnet market: midBps (5000 = 50 cents), midPriceCents, source and status. Note: the legacy field midCents is in basis points.${paidSuffix}`,
      inputSchema: { id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).describe("Market id from smx_list_markets.") },
      annotations: { ...PAID, title: "SMX midpoint (paid)" },
    },
    async ({ id }) => paid("smx_paid_get_mid", `${SMX_ORIGIN}/v1/markets/${encodeURIComponent(id)}/mid`, (b) => {
      const m = b as { midBps?: number; midSource?: string };
      return `SMX agent API midpoint for ${id}: ${m?.midBps ?? "?"} bps (${m?.midSource ?? "?"}).`;
    }, false),
  );

  return server;
}

export { idBytes };
