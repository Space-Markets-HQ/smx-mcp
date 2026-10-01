/**
 * Anonymous, privacy-safe usage counting. Sent ONLY on requests to the SMX origin (smx.space: SMI API and agent API),
 * never to the Base Sepolia RPC or anyone else.
 *
 *   X-SMX-Client:  smx-mcp/<version>           always
 *   X-SMX-Install: <random id>                 unless SMX_MCP_TELEMETRY=0
 *   X-SMX-Tool:    <tool name>                 unless SMX_MCP_TELEMETRY=0
 *
 * The install id is a random UUID generated on first run and stored in ~/.config/smx-mcp/install-id
 * (or $SMX_MCP_CONFIG_DIR / $XDG_CONFIG_HOME/smx-mcp). It contains no personal data and is not derived from
 * the machine, user, wallet or IP. Hosted HTTP mode uses one id per server process, prefixed "hosted-",
 * so callers of a hosted server are never told apart. If the file cannot be written, a per-process id
 * prefixed "ephemeral-" is used. With SMX_MCP_TELEMETRY=0 no id is created, read or sent.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SERVER_NAME, SERVER_VERSION, SMX_ORIGIN } from "./config.js";

export const CLIENT_HEADER = `${SERVER_NAME}/${SERVER_VERSION}`;
const ID_RE = /^(hosted-|ephemeral-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const telemetryEnabled = () => process.env.SMX_MCP_TELEMETRY?.trim() !== "0";

export function configDir(): string {
  const d = process.env.SMX_MCP_CONFIG_DIR?.trim();
  if (d) return d;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "smx-mcp");
}

let mode: "local" | "hosted" = "local";
let cached: string | null = null;

/** Call once at startup in HTTP mode: a fresh per-process id labelled hosted, never per caller. */
export function useHostedInstallId() {
  mode = "hosted";
  cached = `hosted-${randomUUID()}`;
}

export function installId(): string | null {
  if (!telemetryEnabled()) return null;
  if (cached) return cached;
  if (mode === "hosted") return (cached = `hosted-${randomUUID()}`);
  const file = join(configDir(), "install-id");
  try {
    const v = readFileSync(file, "utf8").trim();
    if (ID_RE.test(v) && !v.startsWith("hosted-") && !v.startsWith("ephemeral-")) return (cached = v);
  } catch { /* first run */ }
  const id = randomUUID();
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    return (cached = id);
  } catch {
    return (cached = `ephemeral-${id}`);
  }
}

const toolCtx = new AsyncLocalStorage<{ tool: string }>();
export const runWithTool = <T>(tool: string, fn: () => T): T => toolCtx.run({ tool }, fn);
export const currentTool = () => toolCtx.getStore()?.tool ?? null;

/** Headers for a request to `url`; empty unless the URL is on the SMX origin. */
export function smxHeaders(url: string): Record<string, string> {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return {}; }
  if (origin !== new URL(SMX_ORIGIN).origin) return {};
  const h: Record<string, string> = { "X-SMX-Client": CLIENT_HEADER };
  const id = installId();
  if (id) {
    h["X-SMX-Install"] = id;
    const t = currentTool();
    if (t) h["X-SMX-Tool"] = t;
  }
  return h;
}
