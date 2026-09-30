/**
 * Streamable HTTP transport (stateless, JSON responses) for later hosting, e.g. on Fly at https://smx.space/mcp.
 * Paid tools are OFF over HTTP by default: a hosted server must never pay from its own wallet on behalf of callers.
 * Set SMX_MCP_HTTP_PAID=1 only for a private, single-user deployment that holds that user's own testnet key.
 */
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : undefined;
}

export function startHttp(port: number, host = "0.0.0.0") {
  const paidTools = process.env.SMX_MCP_HTTP_PAID === "1";
  const srv = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, mcp-session-id, mcp-protocol-version, accept");
    res.setHeader("access-control-expose-headers", "mcp-session-id");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, paidTools }));
      return;
    }
    if (url.pathname !== "/mcp") { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found", mcp: "/mcp" })); return; }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)." }, id: null }));
      return;
    }
    try {
      const body = await readBody(req);
      const server = createServer({ paidTools });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: String(e instanceof Error ? e.message : e) }, id: null }));
    }
  });
  srv.listen(port, host, () => console.error(`[${SERVER_NAME}] streamable HTTP on http://${host}:${port}/mcp (paid tools ${paidTools ? "ON" : "off"})`));
  return srv;
}
