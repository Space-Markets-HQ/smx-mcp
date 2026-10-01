// Offline telemetry check: a local echo server stands in for smx.space (SMX_ORIGIN) and for the RPC (SMX_RPC).
// Asserts: X-SMX-Client always; X-SMX-Install + X-SMX-Tool unless SMX_MCP_TELEMETRY=0; install id persisted and reused;
// no X-SMX-* headers to the RPC; paid preflight and the signed x402 retry carry them (no funds, local echo); hosted HTTP mode uses a per-process "hosted-" id.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey } from "viem/accounts";

const seen = [];
const echo = createServer((req, res) => {
  const h = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-smx-")));
  seen.push({ port: req.socket.localPort, url: req.url, h, paid: Boolean(req.headers["payment-signature"]) });
  if (req.url.startsWith("/smi-api/history")) {
    // A real-shaped x402 v2 challenge, so the client signs (locally, random key, no funds) and retries: the retry must
    // still carry the X-SMX headers and the payment signature. Nothing reaches a facilitator or the chain.
    if (req.headers["payment-signature"]) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ print_id: "test", rows: [] }));
      return;
    }
    const pr = { x402Version: 2, error: "Payment required", resource: { url: `http://127.0.0.1:${req.socket.localPort}${req.url}`, mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:84532", amount: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x5799fe0715C04f479f7f80Fbe6C4CFb384A8E0e9", maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }] };
    res.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") }).end("{}");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ print_id: "test", headline: { name: "x", value: 1 }, sub_indices: {}, attribution: { notice: "Data only, not advice." } }));
});
const listen = () => new Promise((r) => { const s = echo.listen(0, "127.0.0.1", () => r(s.address().port)); });
const port = await listen();
const rpc = createServer((req, res) => { seen.push({ port: "rpc", url: req.url, h: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-smx-"))) }); res.writeHead(500).end(); });
const rpcPort = await new Promise((r) => { const s = rpc.listen(0, "127.0.0.1", () => r(s.address().port)); });
const cfg = mkdtempSync(join(tmpdir(), "smx-mcp-tel-"));
const baseEnv = { ...process.env, SMX_ORIGIN: `http://127.0.0.1:${port}`, SMX_RPC: `http://127.0.0.1:${rpcPort}`, SMX_MCP_CONFIG_DIR: cfg };
delete baseEnv.SMX_MCP_TELEMETRY;

async function runStdio(env, calls) {
  const c = new Client({ name: "tel", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "ignore" }));
  for (const [n, a] of calls) await c.callTool({ name: n, arguments: a });
  await c.close();
}
const last = () => seen.filter((s) => s.port === port).at(-1);

// 1. first run creates the id; headers present
await runStdio({ ...baseEnv, X402_PRIVATE_KEY: generatePrivateKey() }, [["smi_get_latest", {}], ["smx_list_markets", {}], ["smi_get_history", {}]]);
const idFile = join(cfg, "install-id");
assert.ok(existsSync(idFile), "install-id file created");
const id = readFileSync(idFile, "utf8").trim();
assert.match(id, /^[0-9a-f-]{36}$/);
const latest = seen.find((s) => s.url === "/smi-api/latest");
assert.deepEqual(latest.h, { "x-smx-client": "smx-mcp/0.1.0", "x-smx-install": id, "x-smx-tool": "smi_get_latest" });
const hist = seen.find((s) => s.url === "/smi-api/history");
assert.equal(hist.h["x-smx-tool"], "smi_get_history", "paid preflight carries the tool header");
const histPaid = seen.filter((s) => s.url === "/smi-api/history" && s.paid);
assert.equal(histPaid.length, 1, "x402 client signed and retried once with PAYMENT-SIGNATURE");
assert.deepEqual(histPaid[0].h, { "x-smx-client": "smx-mcp/0.1.0", "x-smx-install": id, "x-smx-tool": "smi_get_history" }, "paid retry keeps the X-SMX headers");
assert.ok(seen.filter((s) => s.port === "rpc").length > 0, "RPC was contacted");
assert.ok(seen.filter((s) => s.port === "rpc").every((s) => Object.keys(s.h).length === 0), "no X-SMX headers to the RPC");
// 2. second run reuses the id
await runStdio(baseEnv, [["smi_get_latest", {}]]);
assert.equal(last().h["x-smx-install"], id, "install id reused");
// 3. opt-out keeps only the client header, and never creates an id
const cfg2 = mkdtempSync(join(tmpdir(), "smx-mcp-tel-"));
await runStdio({ ...baseEnv, SMX_MCP_TELEMETRY: "0", SMX_MCP_CONFIG_DIR: cfg2 }, [["smi_get_latest", {}]]);
assert.deepEqual(last().h, { "x-smx-client": "smx-mcp/0.1.0" });
assert.ok(!existsSync(join(cfg2, "install-id")), "opt-out creates no id file");
// 4. hosted HTTP mode: per-process hosted id, same for two different callers
const hp = 19000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["dist/index.js", "--http", String(hp)], { env: baseEnv, stdio: ["ignore", "ignore", "pipe"] });
await new Promise((r) => child.stderr.on("data", (d) => /streamable HTTP/.test(String(d)) && r()));
const ids = [];
for (let i = 0; i < 2; i++) {
  const c = new Client({ name: `caller-${i}`, version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hp}/mcp`)));
  await c.callTool({ name: "smi_get_latest", arguments: {} });
  ids.push(last().h["x-smx-install"]);
  await c.close();
}
child.kill();
assert.match(ids[0], /^hosted-[0-9a-f-]{36}$/);
assert.equal(ids[0], ids[1], "hosted id is per process, not per caller");
assert.notEqual(ids[0], `hosted-${id}`);
echo.close(); rpc.close();
console.log("telemetry OK");
