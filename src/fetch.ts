import { HTTP_TIMEOUT_MS, SERVER_NAME, SERVER_VERSION } from "./config.js";
import { fetchSmx } from "./telemetry.js";

export const UA = `${SERVER_NAME}/${SERVER_VERSION} (+https://smx.space)`;

export async function getJson(url: string, timeoutMs: number = HTTP_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
  const r = await fetchSmx(fetch, url, { accept: "application/json", "user-agent": UA }, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body };
}
