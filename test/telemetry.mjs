// Offline telemetry check: a local echo server stands in for smx.space (SMX_ORIGIN) and for the RPC (SMX_RPC).
// Asserts: X-SMX-Client always; X-SMX-Install + X-SMX-Tool unless SMX_MCP_TELEMETRY=0; install id persisted and reused;
// no X-SMX-* headers to the RPC; telemetry is off by default; hosted HTTP mode uses a per-process "hosted-" id.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const seen = [];
const echo = createServer((req, res) => {
  const h = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-smx-")));
  seen.push({ port: req.socket.localPort, url: req.url, h });
  if (req.url.startsWith("/smi/methodology.json")) { // redirect to another origin (the RPC stand-in): headers must not follow
    res.writeHead(302, { location: `http://127.0.0.1:${rpcPort}/redirected` }).end();
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
const optIn = { ...baseEnv, SMX_MCP_TELEMETRY: "1" };

async function runStdio(env, calls) {
  const c = new Client({ name: "tel", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "ignore" }));
  for (const [n, a] of calls) await c.callTool({ name: n, arguments: a });
  await c.close();
}
const last = () => seen.filter((s) => s.port === port).at(-1);

// 0. default (no env): telemetry OFF, only the version header, no id file
await runStdio(baseEnv, [["smi_get_latest", {}]]);
assert.deepEqual(last().h, { "x-smx-client": "smx-mcp/0.2.0" }, "telemetry off by default");
assert.ok(!existsSync(join(cfg, "install-id")), "default creates no id file");
seen.length = 0;
// 1. opt-in run creates the id; headers present
await runStdio(optIn, [["smi_get_latest", {}], ["smx_list_markets", {}], ["smi_get_methodology", {}]]);
const idFile = join(cfg, "install-id");
assert.ok(existsSync(idFile), "install-id file created");
const id = readFileSync(idFile, "utf8").trim();
assert.match(id, /^[0-9a-f-]{36}$/);
const latest = seen.find((s) => s.url === "/smi-api/latest");
assert.deepEqual(latest.h, { "x-smx-client": "smx-mcp/0.2.0", "x-smx-install": id, "x-smx-tool": "smi_get_latest" });
assert.ok(seen.filter((s) => s.port === "rpc").length > 0, "RPC was contacted");
assert.ok(seen.filter((s) => s.port === "rpc").every((s) => Object.keys(s.h).length === 0), "no X-SMX headers to the RPC");
assert.ok(seen.some((s) => s.port === "rpc" && s.url === "/redirected" && Object.keys(s.h).length === 0), "cross-origin redirect followed without X-SMX headers");
assert.ok(seen.some((s) => s.url === "/smi/methodology.json" && s.h["x-smx-tool"] === "smi_get_methodology"), "the smx origin hop itself carries them");
// 1b. host rule in-process: only smx.space (or loopback for this test) ever gets the headers
for (const [origin, url, want] of [[undefined, "https://smx.space/smi-api/latest", true], [undefined, "https://sepolia.base.org/", false], [undefined, "https://smx.space.evil.example/x", false],
  ["https://evil.example", "https://evil.example/smi-api/latest", false], ["http://smx.space", "http://smx.space/x", false]]) {
  const out = await new Promise((r) => {
    const env = { ...process.env, SMX_MCP_CONFIG_DIR: cfg, SMX_MCP_TELEMETRY: "1" }; delete env.SMX_ORIGIN; if (origin) env.SMX_ORIGIN = origin;
    const p = spawn(process.execPath, ["--input-type=module", "-e", `const { smxHeaders } = await import("./dist/telemetry.js"); console.log(JSON.stringify(smxHeaders(${JSON.stringify(url)})))`], { env });
    let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", () => r(JSON.parse(o)));
  });
  assert.equal(Object.keys(out).length > 0, want, `headers for ${url} with SMX_ORIGIN=${origin ?? "(default)"}`);
}
// 2. second run reuses the id
await runStdio(optIn, [["smi_get_latest", {}]]);
assert.equal(last().h["x-smx-install"], id, "install id reused");
// 3. explicit 0 keeps only the client header, and never creates an id
const cfg2 = mkdtempSync(join(tmpdir(), "smx-mcp-tel-"));
await runStdio({ ...baseEnv, SMX_MCP_TELEMETRY: "0", SMX_MCP_CONFIG_DIR: cfg2 }, [["smi_get_latest", {}]]);
assert.deepEqual(last().h, { "x-smx-client": "smx-mcp/0.2.0" });
assert.ok(!existsSync(join(cfg2, "install-id")), "opt-out creates no id file");
// 4. hosted HTTP mode: per-process hosted id, same for two different callers
const hp = 19000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["dist/index.js", "--http", String(hp)], { env: optIn, stdio: ["ignore", "ignore", "pipe"] });
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
