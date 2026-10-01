// Local smoke test: spawn the server over stdio (like Claude Desktop / Cursor would) and call every FREE tool
// against live endpoints. Paid tools are called only with --paid (each call = $0.01 Circle testnet USDC on Base
// Sepolia, from the key in X402_PRIVATE_KEY). Writes results to test/results/.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";

const PAID = process.argv.includes("--paid");
const env = { ...process.env };
if (!PAID) { delete env.X402_PRIVATE_KEY; delete env.SMX_X402_PRIVATE_KEY; }
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "pipe" });
const client = new Client({ name: "smx-mcp-smoke", version: "0.0.1" });
await client.connect(transport);

const out = { at: new Date().toISOString(), server: client.getServerVersion(), instructions: client.getInstructions(), tools: [], calls: [] };
const { tools } = await client.listTools();
out.tools = tools.map((t) => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations, input: t.inputSchema }));
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

async function call(name, args = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  const row = { name, args, ms: Date.now() - t0, isError: !!r.isError, summary: text.split("\n")[0].slice(0, 400), structured: r.structuredContent ?? null };
  out.calls.push(row);
  console.log(`${r.isError ? "ERR" : "ok "} ${name} ${JSON.stringify(args)} ${row.ms}ms :: ${row.summary}`);
  return r;
}

const list = await call("smx_list_markets");
await call("smx_list_markets", { include_unlisted: true });
const firstId = list.structuredContent?.markets?.[0]?.id ?? "moon-race-us-china-test-v2";
await call("smx_get_market", { id: "moon-race-us-china-test-v2" });
await call("smx_get_market", { id: "starship-f14-splashdown-test" });
await call("smx_get_market", { id: "does-not-exist" });
await call("smx_trading_guide", { id: firstId });
await call("smx_check_cancel_safety", { id: "moon-race-us-china-test-v2", order_ids: [12, 13] });
await call("smx_check_cancel_safety", { id: "starship-f14-splashdown-test", order_ids: [4] }); // known stranded fill (4,2)
await call("smi_get_latest");
await call("smi_get_latest", { sub_index: "moon_deep_space" });
await call("smi_get_methodology", { section: "headline" });
if (!PAID) {
  await call("smi_get_history"); // must refuse without a key, no network payment
} else {
  await call("smi_get_history");
  await call("smx_paid_get_mid", { id: "moon-race-us-china-test-v2" });
  await call("smx_paid_get_market", { id: "does-not-exist" }); // 404, must not be charged
}
await client.close();
mkdirSync("test/results", { recursive: true });
const f = `test/results/smoke-${PAID ? "paid-" : ""}${Date.now()}.json`;
writeFileSync(f, JSON.stringify(out, null, 2));
console.log(`wrote ${f}`);
