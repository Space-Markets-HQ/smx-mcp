#!/usr/bin/env node
/**
 * smx-mcp: MCP server for SMX (Space Markets) testnet markets and the Space Markets Index (SMI).
 *   npx smx-mcp                 stdio transport (default; for Claude Desktop, Cursor and other local clients)
 *   npx smx-mcp --http [port]   streamable HTTP on /mcp (default port 8787, or $PORT)
 * Logs go to stderr only (stdout carries the MCP protocol in stdio mode).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startHttp } from "./http.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log(SERVER_VERSION); process.exit(0); }
const httpIdx = args.indexOf("--http");
if (httpIdx !== -1) {
  const port = Number(args[httpIdx + 1] && !args[httpIdx + 1]!.startsWith("-") ? args[httpIdx + 1] : process.env.PORT || 8787);
  startHttp(port, process.env.HOST || "0.0.0.0");
} else {
  const server = createServer({ paidTools: true });
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME} ${SERVER_VERSION}] stdio ready`);
}
