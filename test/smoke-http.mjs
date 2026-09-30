// Start the streamable HTTP transport locally and exercise it with the SDK client. Paid tools must be absent by default.
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const port = 18787 + Math.floor(Math.random() * 1000);
const env = { ...process.env }; delete env.X402_PRIVATE_KEY; delete env.SMX_X402_PRIVATE_KEY; delete env.SMX_MCP_HTTP_PAID;
const child = spawn(process.execPath, ["dist/index.js", "--http", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
await new Promise((res) => child.stderr.on("data", (d) => /streamable HTTP/.test(String(d)) && res()));
try {
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  console.log("health", JSON.stringify(h));
  const client = new Client({ name: "smoke-http", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const { tools } = await client.listTools();
  console.log(`tools over HTTP (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
  if (tools.some((t) => /paid|history|launch|print/.test(t.name) && t.name !== "smi_get_latest")) throw new Error("paid tools exposed over HTTP by default");
  const r = await client.callTool({ name: "smx_list_markets", arguments: {} });
  console.log("smx_list_markets:", r.content[0].text.split("\n")[0]);
  const s = await client.callTool({ name: "smi_get_latest", arguments: {} });
  console.log("smi_get_latest:", s.content[0].text.split("\n")[0]);
  await client.close();
  console.log("http smoke OK");
} finally { child.kill(); }
