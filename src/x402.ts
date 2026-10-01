/**
 * Paid reads via x402 (Base Sepolia, Circle testnet USDC, $0.01 per call). The payer is the USER's own key from the
 * environment; no key is bundled. Every challenge is checked against X402_EXPECT (network, asset, payTo, max amount)
 * before anything is signed, and only eip155:84532 is registered with the x402 client.
 */
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { HTTP_TIMEOUT_MS, X402_EXPECT } from "./config.js";
import { UA } from "./fetch.js";
import { smxHeaders } from "./telemetry.js";

export const KEY_ENV_VARS = ["X402_PRIVATE_KEY", "SMX_X402_PRIVATE_KEY"] as const;

export function payerKey(): `0x${string}` | null {
  for (const k of KEY_ENV_VARS) {
    const v = process.env[k]?.trim();
    if (v) return (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`;
  }
  return null;
}

type Req = { scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string; maxAmountRequired?: string };

export function requirementOk(r: Req): string | null {
  if (r.network !== X402_EXPECT.network) return `network ${r.network} is not ${X402_EXPECT.network} (Base Sepolia)`;
  if ((r.asset ?? "").toLowerCase() !== X402_EXPECT.asset.toLowerCase()) return `asset ${r.asset} is not Circle testnet USDC`;
  if ((r.payTo ?? "").toLowerCase() !== X402_EXPECT.payTo) return `payTo ${r.payTo} is not the SMX receiver`;
  const amt = BigInt(r.amount ?? r.maxAmountRequired ?? "0");
  if (amt <= 0n || amt > X402_EXPECT.maxAmountAtomic) return `amount ${amt} exceeds the ${X402_EXPECT.maxAmountAtomic} atomic cap`;
  return null;
}

export type PaidResult = {
  status: number;
  body: unknown;
  charged: boolean;
  payment: { network: string; asset: string; amountAtomic: string; payer?: string; transaction?: string } | null;
};

let client: { fetch: typeof fetch; http: x402HTTPClient; payer: string } | null = null;
function getClient() {
  const key = payerKey();
  if (!key) return null;
  if (client) return client;
  const account = privateKeyToAccount(key);
  const c = new x402Client();
  registerExactEvmScheme(c, {
    signer: account,
    networks: [X402_EXPECT.network],
    policies: [(_v: number, reqs: Req[]) => reqs.filter((r) => requirementOk(r) === null)] as never,
  });
  client = { fetch: wrapFetchWithPayment(fetch, c), http: new x402HTTPClient(c), payer: account.address };
  return client;
}

export function payerAddress(): string | null {
  return getClient()?.payer ?? null;
}

/** Decode the unpaid 402 challenge (no payment). Used to validate before paying and to explain costs. */
export async function challenge(url: string): Promise<{ status: number; accepts: Req[]; body: unknown }> {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA, ...smxHeaders(url) }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await r.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  let accepts: Req[] = [];
  const h = r.headers.get("payment-required");
  if (h) {
    try { accepts = (JSON.parse(Buffer.from(h, "base64").toString("utf8")).accepts ?? []) as Req[]; } catch { /* ignore */ }
  }
  return { status: r.status, accepts, body };
}

export async function paidGet(url: string): Promise<PaidResult> {
  const c = getClient();
  if (!c) throw new Error("NO_KEY");
  const pre = await challenge(url);
  if (pre.status !== 402) return { status: pre.status, body: pre.body, charged: false, payment: null };
  const ok = pre.accepts.find((r) => requirementOk(r) === null);
  if (!ok) {
    const why = pre.accepts.map((r) => requirementOk(r)).join("; ") || "no x402 v2 accepts in the challenge";
    throw new Error(`REFUSED: payment challenge does not match the expected testnet terms (${why}). Nothing was signed.`);
  }
  const r = await c.fetch(url, { headers: { accept: "application/json", "user-agent": UA, ...smxHeaders(url) }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS * 3) });
  const text = await r.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  let settle: { transaction?: string; payer?: string; success?: boolean } | null = null as { transaction?: string; payer?: string; success?: boolean } | null;
  try { settle = c.http.getPaymentSettleResponse((n: string) => r.headers.get(n)) as unknown as typeof settle; } catch { /* no settle header */ }
  const charged = Boolean(settle?.transaction);
  return {
    status: r.status,
    body,
    charged,
    payment: charged
      ? { network: X402_EXPECT.network, asset: "Circle testnet USDC (Base Sepolia)", amountAtomic: String(ok.amount ?? ok.maxAmountRequired), payer: settle?.payer ?? c.payer, transaction: settle?.transaction }
      : null,
  };
}
