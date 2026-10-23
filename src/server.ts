import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { allMarkets, bookDepth, idBytes, unclaimedFills, type MarketRow } from "./chain.js";
import { CHAIN_ID, CONTRACTS, LINKS, MARKET_QUESTIONS, NETWORK, SERVER_NAME, SERVER_TITLE, SERVER_VERSION, SMI_API_BASE, SMI_STATIC_BASE, SMX_INDEXER, SMX_ORIGIN } from "./config.js";
import { LIQUIDITY_NOTE, NO_TRADING_NOTE, STRANDED_FILL_RULE, TESTNET_NOTICE } from "./copy.js";
import { getJson } from "./fetch.js";
import { isResolved, midOf, minOrderOf, outcomeOf, quoteOf, stateNameV1, statusOf } from "./listing.js";
import { smiFooter, stripPrices, summarizeLatest } from "./smi.js";
import { runWithTool } from "./telemetry.js";
import { registerWriteTools } from "./write-tools.js";
import { registerPerpsTools } from "./perps-tools.js";
import { apiTrading, apiTradingAll, chainTrading, tradingRefusal, type Trading } from "./trading.js";

export const INSTRUCTIONS = [
  "SMX by Space Markets, testnet only (Base Sepolia, chain id 84532). Two separate products:",
  "(1) Space Markets Index (SMI): information on orbital launch activity and other space-sector data, published by Space Markets, Inc. Tools start with smi_. SMI results contain no market prices.",
  "(2) SMX event markets: testnet markets priced in test USDC with no monetary value. Tools start with smx_.",
  "All tools are free and need no key or account.",
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

const SMI_SECTIONS = ["launch_access", "compute_energy", "connectivity_data", "spectrum_filings", "moon_deep_space"] as const;

function marketView(r: MarketRow, nowSec = Math.floor(Date.now() / 1000), trading?: Trading | null) {
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
    // open | closed | halted. Orders are refused unless open (SMX enforces close time and halts off-chain).
    trading: trading ?? chainTrading(r, nowSec * 1000),
    orderBook: r.bookAddr,
    market: r.marketAddr,
    listed: r.listing.listed,
    ...(r.listing.listed ? {} : { excludedReason: r.listing.excludedReason, excludedDetail: r.listing.detail }),
  };
}

async function findMarket(id: string): Promise<MarketRow | undefined> {
  return (await allMarkets()).find((r) => r.marketId === id && (r.listing.listed || r.listing.excludedReason !== "internal-codename"));
}

export function createServer(): McpServer {
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
        "List SMX event markets on Base Sepolia testnet, read directly from the on-chain MarketRegistries (old and launch-book) with the same listing rules as the SMX agent API. Per market: id, title, state (Open/Resolved), status, outcome, best bid and ask, YES midpoint in basis points (5000 = 50 cents) and minimum order. Free, no key. Test USDC, no monetary value.",
      inputSchema: { include_unlisted: z.boolean().optional().describe("Also return drills, superseded versions and other unlisted registry entries, with the reason.") },
      annotations: { ...RO, title: "SMX markets" },
    },
    async ({ include_unlisted }) => {
      try {
        const rows = await allMarkets();
        const nowSec = Math.floor(Date.now() / 1000);
        // Internal engineering markets are never shown, even with include_unlisted.
        const visible = rows.filter((r) => r.listing.listed || r.listing.excludedReason !== "internal-codename");
        const trading = await apiTradingAll();
        const markets = visible.filter((r) => include_unlisted || r.listing.listed).map((r) => marketView(r, nowSec, trading.get(r.marketId)));
        const data = { markets, count: markets.length, registryCount: rows.length, hiddenInternal: rows.length - visible.length, source: `MarketRegistry ${CONTRACTS.marketRegistries.join(", ")} (Base Sepolia)`, liquidityNote: LIQUIDITY_NOTE, units: "Prices in basis points of 1 test USDC per share: 5000 = 50 cents.", ...common() };
        const line = markets.map((m) => `${m.id} (${m.status}${m.trading.status !== "open" ? `, trading ${m.trading.status}` : ""}${m.yesPriceBps !== null ? `, YES ${m.yesPriceCents}c` : ""}${m.outcome ? `, ${m.outcome}` : ""})`).join("; ");
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
          ...marketView(r, undefined, await apiTrading(r.marketId)),
          book: {
            ...depth,
            batchNonce: r.batchNonce ?? null,
            activeOrderCount: r.activeOrderCount ?? null,
            isCrossed: r.isCrossed ?? null,
            clearableAt: r.clearableAt ? new Date(r.clearableAt * 1000).toISOString() : null,
            priceUnits: "YES-terms basis points for both sides. Bids are YES buys; asks are YES sells, i.e. NO buys at 10000 minus the price.",
          },
          contracts: { marketRegistry: r.registry, factory: CONTRACTS.factory, collateralToken: CONTRACTS.testUsdcCollateral, orderBook: r.bookAddr, market: r.marketAddr },
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
        "How to place, cancel and claim SMX testnet orders from your own wallet on Base Sepolia. This server never signs or sends: smx_build_order, smx_build_cancel and smx_build_claim return the unsigned transactions for you to sign; this guide returns the exact steps, contract addresses, order rules and the claim-before-cancel safety rule. Free, no key.",
      inputSchema: { id: z.string().max(64).optional().describe("Optional market id; fills in that market's order book address.") },
      annotations: { ...RO, openWorldHint: false, title: "SMX trading guide" },
    },
    async ({ id }) => {
      let orderBook: string | null = null;
      if (id) {
        // Trading cut-off first: a closed or halted market gets no order steps.
        const api = await apiTrading(id);
        if (api) {
          const refused = tradingRefusal(id, api);
          if (refused) return fail(`${refused.error}: ${refused.message}`, { ...refused });
        }
        let row: MarketRow | undefined;
        try { row = await findMarket(id); } catch { row = undefined; }
        orderBook = row?.bookAddr ?? null;
        if (!orderBook) return fail("Unknown market id. Call smx_list_markets for valid ids.");
        if (!api) {
          const refused = tradingRefusal(id, chainTrading(row));
          if (refused) return fail(`${refused.error}: ${refused.message}`, { ...refused });
        }
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
        tokens: "Order collateral is SMX test USDC (0x5882...c4E1). It has no monetary value.",
        links: { skill: LINKS.skill, llms: LINKS.llms, openapi: LINKS.openapi, app: LINKS.app },
        disabledApiRoutes: "POST /agent/order and /agent/cancel return 403 wallet_signed_only and are never charged.",
        tradingCutoff: "Do not submit orders on a market whose trading.status is closed or halted (smx_get_market). Pass id here to check: closed or halted markets return market_closed / market_halted. Status: GET https://smx.space/agent/trading/{id}.",
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
      annotations: { ...RO, title: "SMX unclaimed-fill check" },
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
          ? `No unclaimed fills found on order(s) ${order_ids.join(", ")} (checked batches 1-${batchNonce}). OK to cancel under the claim-before-cancel rule, based on this read of on-chain state at the time of the call. Provided as-is; verify before acting.`
          : fills.length
            ? `DO NOT CANCEL: ${fills.length} unclaimed fill(s).${claimable.length ? ` Claim first: ${data.claimFirst.join("; ")}.` : ""}${stranded.length ? ` ${stranded.length} fill(s) cannot be claimed in simulation (${stranded.map((f) => `order ${f.orderId} batch ${f.batchNonce}: ${f.claimSimulation}`).join("; ")}); report to SMX.` : ""}`
            : `DO NOT CANCEL yet: ${unreadable.length} fill check(s) could not be read; retry.`;
        return ok(msg, data);
      } catch (e) {
        return fail(`Chain read failed: ${errMsg(e)}. Treat the order as NOT safe to cancel until the check succeeds.`);
      }
    },
  );

  // ---------------- Unsigned write tools (event markets; shapes in write-tools.ts). Free; registered in every mode. ----------------
  registerWriteTools(server, ok, fail);
  registerPerpsTools(server, ok, fail);

  // ---------------- SMX indexer (free, read-only) ----------------
  const MID = z.string().regex(/^[A-Za-z0-9._#-]{1,64}$/).describe("Market id from smx_list_markets, e.g. moon-race-us-china-test-v2.");
  const idx = async (path: string, summary: (b: any) => string) => {
    try {
      const { status, body } = await getJson(`${SMX_INDEXER}${path}`);
      if (status !== 200) return fail(`SMX indexer returned ${status} for ${path}.`, { body });
      return ok(summary(body), { ...(body as Record<string, unknown>), source: `${SMX_INDEXER}${path}`, ...common() });
    } catch (e) { return fail(`SMX indexer read failed: ${errMsg(e)}`); }
  };
  const c = (p: number | null | undefined) => (p == null ? "n/a" : `${Math.round(p * 1000) / 10}c`);
  server.registerTool("smx_get_book", {
    title: "SMX: order book depth",
    description: "Resting order book for one SMX testnet market, aggregated by price level (price 0-1 per share, qty in shares), read live from chain via the SMX indexer. bids = Buy Yes, asks = Sell Yes; noView gives the same book in No terms. Free, no key. Test USDC, no monetary value.",
    inputSchema: { id: MID }, annotations: { ...RO, title: "SMX order book" },
  }, async ({ id }) => idx(`/v1/markets/${encodeURIComponent(id)}/book`, (b) => `${id} book: best bid ${c(b.bestBid)}, best ask ${c(b.bestAsk)}, ${b.bids?.length ?? 0} bid / ${b.asks?.length ?? 0} ask levels, ${b.activeOrders} active orders.`));
  server.registerTool("smx_get_clears", {
    title: "SMX: trade history (batch clears)",
    description: "Recent batch clears (trades) for one SMX testnet market, newest first: clear price (0-1), quantity in shares, notional in test USDC, time and tx hash. SMX is a frequent batch auction: everyone in a clear gets the same price. Free, no key.",
    inputSchema: { id: MID, limit: z.number().int().min(1).max(1000).optional().describe("Max trades, default 100.") }, annotations: { ...RO, title: "SMX clears" },
  }, async ({ id, limit }) => idx(`/v1/markets/${encodeURIComponent(id)}/trades?limit=${limit ?? 100}`, (b) => `${id}: ${b.trades?.length ?? 0} clears${b.trades?.[0] ? `, last ${c(b.trades[0].price)} x ${b.trades[0].qty} at ${b.trades[0].time}` : ""}.`));
  server.registerTool("smx_get_candles", {
    title: "SMX: price history candles",
    description: "OHLC candles of clear prices (0-1) for one SMX testnet market. range 1D (1h candles), 1W (4h), 1M (1d) or all (1d). openPrice is the last clear before the window. Empty candles mean no clears in that window. Free, no key.",
    inputSchema: { id: MID, range: z.enum(["1D", "1W", "1M", "all"]).optional().describe("Default 1D.") }, annotations: { ...RO, title: "SMX candles" },
  }, async ({ id, range }) => idx(`/v1/markets/${encodeURIComponent(id)}/candles?range=${range ?? "1D"}`, (b) => `${id} ${b.range}: ${b.candles?.length ?? 0} candles.`));
  server.registerTool("smx_get_stats", {
    title: "SMX: 24h stats and open interest",
    description: "24h stats for one SMX testnet market from indexed events: last clear price and time, 24h change, 24h volume (shares and test USDC), clears, open interest (shares), totals. Free, no key.",
    inputSchema: { id: MID }, annotations: { ...RO, title: "SMX stats" },
  }, async ({ id }) => idx(`/v1/markets/${encodeURIComponent(id)}/stats`, (b) => `${id}: last ${c(b.lastPrice)}, 24h vol ${b.volume24hShares} shares, OI ${b.openInterestShares} shares.`));
  server.registerTool("smx_get_account_orders", {
    title: "SMX: account open orders and history",
    description: "Orders for an SMX trader across all testnet markets, matched by wallet (owner) or SMX Account contract address. history=false returns open and partially filled orders; history=true returns every order with fills, claims and cancels. Free, no key.",
    inputSchema: { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), history: z.boolean().optional() }, annotations: { ...RO, title: "SMX account orders" },
  }, async ({ address, history }) => idx(`/v1/accounts/${address}/${history ? "history" : "orders"}`, (b) => `${b.orders?.length ?? 0} ${history ? "orders in history" : "open orders"} for ${address}.`));

  return server;
}

export { idBytes };
