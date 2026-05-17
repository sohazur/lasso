/**
 * Supabase client — Postgres for merchants / calls / attributions.
 *
 * Falls back to an in-memory store when keys are missing, so the pipeline
 * runs end-to-end before you provision Supabase.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { env, isMock } from "./config.js";

export type MerchantStatus = "scraping" | "indexing" | "ready" | "failed";

export type MerchantRow = {
  id: string;
  name: string;
  primary_domain?: string | null;
  status: MerchantStatus;
  failed_step?: string | null;
  failed_reason?: string | null;
  private_context?: Record<string, unknown> | null;
  agentphone_agent_id?: string | null;
  agentphone_number_id?: string | null;
  agentphone_phone_number?: string | null;
  // Set by the merchant (or hardcoded for demo) so notify_founder can dial
  // the right person mid-call. Both optional — without them the founder
  // tool is a no-op rather than a failure.
  founder_name?: string | null;
  founder_phone?: string | null;
  created_at?: string;
  updated_at?: string;
};

/** Distinguishes a customer-recovery call from a founder-approval call. */
export type CallKind = "customer" | "founder_approval";

/**
 * One of the structured actions the closer agent can queue. When set, the
 * NEXT inbound turn from the customer is expected to confirm/cancel.
 * Cleared once acted upon or once the watchdog expires (60s).
 */
export type PendingActionType = "propose_payment_link" | "notify_founder";

/** Tags the diagnosed reason for abandonment on each turn. */
export type ObjectionType =
  | "color"
  | "size"
  | "fit"
  | "shipping"
  | "price"
  | "compatibility"
  | "trust"
  | "other";

/** Founder's verbal answer on an approval call. */
export type FounderDecision = "approved" | "denied" | "callback";

export type CallStatus =
  | "preparing"
  | "ringing"
  | "connected"
  | "completed"
  | "failed"
  | "no_answer";

export type CallOutcome = "recovered" | "declined" | "unreachable" | "error" | null;

export type CallRow = {
  id: string;
  merchant_id: string;
  phone: string;
  email?: string | null;
  customer_name?: string | null;
  page_url?: string | null;
  cart_lines?: unknown[];
  cart_total_cents?: number | null;
  trigger?: string | null;
  status: CallStatus;
  outcome?: CallOutcome;
  agentphone_call_id?: string | null;
  transcript?: string | null;
  duration_secs?: number | null;
  recovered_cents?: number | null;
  created_at?: string;
  ended_at?: string | null;

  // ─── proactive-closer additions ────────────────────────────────────────
  /**
   * 'customer' (default) for the customer-recovery call. 'founder_approval'
   * for calls the notify_founder tool places to the merchant's founder.
   * The webhook turn handler branches on this to pick the right prompt.
   */
  kind?: CallKind | null;

  /**
   * Pending two-turn handshake state. When the agent emits a propose_*
   * action it gets stored here; the next inbound turn from the customer
   * is expected to confirm/cancel. Cleared after the action fires OR
   * after pending_action_set_at is older than 60s (watchdog).
   */
  pending_action_type?: PendingActionType | null;
  pending_action_params?: Record<string, unknown> | null;
  pending_action_set_at?: string | null;

  /**
   * The diagnosed reason for abandonment as inferred by the LLM each turn.
   * Stored monotonically — the latest non-null value sticks. Dashboard
   * groups by this for the "why are we losing deals" breakdown.
   */
  objection_type?: ObjectionType | null;

  /**
   * Set on a customer call when notify_founder placed an outbound founder
   * call. Points at the founder_approval row's id. The founder's verbal
   * response is captured on that row and read back here when the customer
   * follow-up fires (separate branch — out of scope for v1).
   */
  founder_call_id?: string | null;
  founder_decision?: FounderDecision | null;
  founder_decision_note?: string | null;
};

export interface DataStore {
  upsertMerchant(row: Omit<MerchantRow, "created_at" | "updated_at">): Promise<MerchantRow>;
  getMerchant(id: string): Promise<MerchantRow | null>;
  updateMerchant(id: string, patch: Partial<MerchantRow>): Promise<MerchantRow | null>;

  insertCall(row: Omit<CallRow, "created_at">): Promise<CallRow>;
  getCall(id: string): Promise<CallRow | null>;
  updateCall(id: string, patch: Partial<CallRow>): Promise<CallRow | null>;
  listCalls(merchantId?: string, limit?: number): Promise<CallRow[]>;
}

class SupabaseStore implements DataStore {
  constructor(private client: SupabaseClient) {}

  async upsertMerchant(row: Omit<MerchantRow, "created_at" | "updated_at">): Promise<MerchantRow> {
    const { data, error } = await this.client.from("merchants").upsert(row).select().single();
    if (error) throw error;
    return data as MerchantRow;
  }

  async getMerchant(id: string): Promise<MerchantRow | null> {
    const { data } = await this.client.from("merchants").select("*").eq("id", id).maybeSingle();
    return (data as MerchantRow) ?? null;
  }

  async updateMerchant(id: string, patch: Partial<MerchantRow>): Promise<MerchantRow | null> {
    const { data, error } = await this.client
      .from("merchants")
      .update(patch)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return (data as MerchantRow) ?? null;
  }

  async insertCall(row: Omit<CallRow, "created_at">): Promise<CallRow> {
    const { data, error } = await this.client.from("calls").insert(row).select().single();
    if (error) throw error;
    return data as CallRow;
  }

  async getCall(id: string): Promise<CallRow | null> {
    const { data } = await this.client.from("calls").select("*").eq("id", id).maybeSingle();
    return (data as CallRow) ?? null;
  }

  async updateCall(id: string, patch: Partial<CallRow>): Promise<CallRow | null> {
    const { data, error } = await this.client
      .from("calls")
      .update(patch)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return (data as CallRow) ?? null;
  }

  async listCalls(merchantId?: string, limit = 50): Promise<CallRow[]> {
    let q = this.client.from("calls").select("*").order("created_at", { ascending: false }).limit(limit);
    if (merchantId) q = q.eq("merchant_id", merchantId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as CallRow[];
  }
}

class MockStore implements DataStore {
  private merchants = new Map<string, MerchantRow>();
  private calls = new Map<string, CallRow>();

  async upsertMerchant(row: Omit<MerchantRow, "created_at" | "updated_at">): Promise<MerchantRow> {
    const full: MerchantRow = { ...row, created_at: new Date().toISOString() };
    this.merchants.set(row.id, full);
    return full;
  }
  async getMerchant(id: string): Promise<MerchantRow | null> {
    return this.merchants.get(id) ?? null;
  }
  async updateMerchant(id: string, patch: Partial<MerchantRow>): Promise<MerchantRow | null> {
    const cur = this.merchants.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.merchants.set(id, next);
    return next;
  }
  async insertCall(row: Omit<CallRow, "created_at">): Promise<CallRow> {
    const full: CallRow = { ...row, created_at: new Date().toISOString() };
    this.calls.set(row.id, full);
    return full;
  }
  async getCall(id: string): Promise<CallRow | null> {
    return this.calls.get(id) ?? null;
  }
  async updateCall(id: string, patch: Partial<CallRow>): Promise<CallRow | null> {
    const cur = this.calls.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.calls.set(id, next);
    return next;
  }
  async listCalls(merchantId?: string, limit = 50): Promise<CallRow[]> {
    const all = Array.from(this.calls.values()).sort((a, b) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? "")
    );
    const filtered = merchantId ? all.filter((c) => c.merchant_id === merchantId) : all;
    return filtered.slice(0, limit);
  }
}

let _store: DataStore | null = null;

export function getStore(): DataStore {
  if (_store) return _store;
  if (isMock(env.supabaseUrl, env.supabaseServiceKey)) {
    console.warn("[lasso] supabase: MOCK mode — set SUPABASE_URL and SUPABASE_SERVICE_KEY for real persistence");
    _store = new MockStore();
  } else {
    // Node 20 doesn't ship a global WebSocket; supabase-js needs one for the
    // realtime client. Provide `ws` so cold queries don't blow up. The cast
    // is necessary because `ws` and the browser WebSocket type don't match
    // structurally (different ErrorEvent shapes) but they're API-compatible
    // at runtime.
    const client = createClient(env.supabaseUrl!, env.supabaseServiceKey!, {
      auth: { persistSession: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      realtime: { transport: WebSocket as any },
    });
    _store = new SupabaseStore(client);
  }
  return _store;
}
