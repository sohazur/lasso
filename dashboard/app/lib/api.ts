/**
 * Thin client for the Lasso server. The dashboard talks directly to the
 * Fastify server (CORS is wide open in dev). Override the URL via
 * NEXT_PUBLIC_LASSO_SERVER if running on a different host.
 */

const SERVER =
  process.env.NEXT_PUBLIC_LASSO_SERVER ?? "http://localhost:3001";

export type MerchantStatus = "scraping" | "indexing" | "ready" | "failed";

export type OnboardRequest = {
  merchant_id: string;
  name: string;
  url: string;
  private_context?: Record<string, unknown>;
};

export type OnboardResponse = {
  merchant_id: string;
  status: MerchantStatus;
};

export type OnboardStatus = {
  merchant_id: string;
  status: MerchantStatus;
  failed_step: string | null;
  failed_reason: string | null;
  name: string;
};

export type ApiError = {
  error: string;
  issues?: unknown;
};

async function jsonOrError<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T | ApiError;
  if (!res.ok) {
    const msg =
      (body as ApiError).error ?? `HTTP ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

export async function startOnboard(
  req: OnboardRequest,
): Promise<OnboardResponse> {
  const res = await fetch(`${SERVER}/api/onboard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return jsonOrError<OnboardResponse>(res);
}

export async function getOnboardStatus(
  merchantId: string,
): Promise<OnboardStatus> {
  const res = await fetch(
    `${SERVER}/api/onboard/${encodeURIComponent(merchantId)}/status`,
    { cache: "no-store" },
  );
  return jsonOrError<OnboardStatus>(res);
}

export function snippetSrc(): string {
  return `${SERVER.replace(/\/$/, "")}/snippet.js`;
}

export type CallRow = {
  id: string;
  merchant_id: string;
  phone: string;
  email: string | null;
  customer_name: string | null;
  page_url: string | null;
  cart_lines: Array<{ title?: string; qty?: number; price_cents?: number }> | null;
  cart_total_cents: number | null;
  trigger: string | null;
  status: "preparing" | "ringing" | "connected" | "completed" | "failed" | "no_answer";
  outcome: "recovered" | "declined" | "unreachable" | "error" | null;
  agentphone_call_id: string | null;
  transcript: string | null;
  duration_secs: number | null;
  recovered_cents: number | null;
  created_at: string;
  ended_at: string | null;
};

export type Stats = {
  total_calls: number;
  calls_today: number;
  connected_calls: number;
  connect_rate: number;
  recovered_calls: number;
  recovered_cents: number;
  recovered_cents_today: number;
};

export async function listCalls(merchantId?: string, limit = 50): Promise<CallRow[]> {
  const qs = new URLSearchParams();
  if (merchantId) qs.set("merchant_id", merchantId);
  qs.set("limit", String(limit));
  const res = await fetch(`${SERVER}/api/calls?${qs.toString()}`, { cache: "no-store" });
  const body = (await jsonOrError<{ data: CallRow[] }>(res)) as { data: CallRow[] };
  return body.data;
}

export async function getCall(id: string): Promise<CallRow> {
  const res = await fetch(`${SERVER}/api/calls/${encodeURIComponent(id)}`, { cache: "no-store" });
  return jsonOrError<CallRow>(res);
}

export async function getStats(merchantId?: string): Promise<Stats> {
  const qs = new URLSearchParams();
  if (merchantId) qs.set("merchant_id", merchantId);
  const res = await fetch(`${SERVER}/api/stats?${qs.toString()}`, { cache: "no-store" });
  return jsonOrError<Stats>(res);
}
