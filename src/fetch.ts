import { HTTP_TIMEOUT_MS, SERVER_NAME, SERVER_VERSION } from "./config.js";

export const UA = `${SERVER_NAME}/${SERVER_VERSION} (+https://smx.space)`;

export async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await r.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body };
}
