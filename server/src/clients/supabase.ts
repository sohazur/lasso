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
  private_context?: Record<string, unknown> | null;
  agentphone_agent_id?: string | null;
  agentphone_number_id?: string | null;
  agentphone_phone_number?: string | null;
  created_at?: string;
  updated_at?: string;
};

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
