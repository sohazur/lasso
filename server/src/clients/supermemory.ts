/**
 * Supermemory client — long-term memory + KB store.
 *
 * Tag scheme:
 *   merchant:{id}:context             → brand briefing (one record)
 *   merchant:{id}:chunks              → scraped KB chunks (many records)
 *   merchant:{id}:private             → merchant-private context (coupons etc)
 *   merchant:{id}:phone:{phone}       → per-caller memory
 *
 * MOCK mode: in-memory map. Real mode: Supermemory REST API.
 */

import { env, isMock } from "./config.js";

export type MemoryRecord = {
  text: string;
  metadata?: Record<string, unknown>;
};

export interface MemoryClient {
  store(tag: string, record: MemoryRecord): Promise<void>;
  storeMany(tag: string, records: MemoryRecord[]): Promise<void>;
  get(tag: string): Promise<MemoryRecord[]>;
  search(tag: string, query: string, limit?: number): Promise<MemoryRecord[]>;
  delete(tag: string): Promise<void>;
}

class MockMemoryClient implements MemoryClient {
  private store_ = new Map<string, MemoryRecord[]>();

  async store(tag: string, record: MemoryRecord): Promise<void> {
    const existing = this.store_.get(tag) ?? [];
    existing.push(record);
    this.store_.set(tag, existing);
  }

  async storeMany(tag: string, records: MemoryRecord[]): Promise<void> {
    const existing = this.store_.get(tag) ?? [];
    this.store_.set(tag, existing.concat(records));
  }

  async get(tag: string): Promise<MemoryRecord[]> {
    return this.store_.get(tag) ?? [];
  }

  async search(tag: string, query: string, limit = 5): Promise<MemoryRecord[]> {
    // Mock semantic search: substring match + take first N
    const records = this.store_.get(tag) ?? [];
    const q = query.toLowerCase();
    const scored = records
      .map((r) => ({ r, score: r.text.toLowerCase().includes(q) ? 1 : 0 }))
      .filter((x) => x.score > 0);
    return (scored.length > 0 ? scored : records.map((r) => ({ r, score: 0 })))
      .slice(0, limit)
      .map((x) => x.r);
  }

  async delete(tag: string): Promise<void> {
    this.store_.delete(tag);
  }
}

class SupermemoryHttpClient implements MemoryClient {
  private base = "https://api.supermemory.ai/v3";
  constructor(private apiKey: string, private workspaceId?: string) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.workspaceId) h["X-Workspace-Id"] = this.workspaceId;
    return h;
  }

  async store(tag: string, record: MemoryRecord): Promise<void> {
    const res = await fetch(`${this.base}/memories`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        content: record.text,
        containerTags: [tag],
        metadata: record.metadata ?? {},
      }),
    });
    if (!res.ok) throw new Error(`supermemory store ${res.status}: ${await res.text()}`);
  }

  async storeMany(tag: string, records: MemoryRecord[]): Promise<void> {
    // Sequential for now; API typically supports batch but keeping simple
    for (const r of records) await this.store(tag, r);
  }

  async get(tag: string): Promise<MemoryRecord[]> {
    return this.search(tag, "", 100);
  }

  async search(tag: string, query: string, limit = 5): Promise<MemoryRecord[]> {
    const res = await fetch(`${this.base}/search`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        q: query || "",
        containerTags: [tag],
        limit,
      }),
    });
    if (!res.ok) {
      console.warn(`[lasso] supermemory search ${res.status}: ${await res.text()}`);
      return [];
    }
    const json = (await res.json()) as { results?: Array<{ content?: string; metadata?: Record<string, unknown> }> };
    return (json.results ?? []).map((r) => ({
      text: r.content ?? "",
      metadata: r.metadata,
    }));
  }

  async delete(_tag: string): Promise<void> {
    // Supermemory deletion API varies; left as no-op for now and we'll wire when needed
    console.warn("[lasso] supermemory delete: not implemented");
  }
}

let _client: MemoryClient | null = null;

export function getMemory(): MemoryClient {
  if (_client) return _client;
  if (isMock(env.supermemoryKey)) {
    console.warn("[lasso] supermemory: MOCK mode — set SUPERMEMORY_API_KEY for real memory");
    _client = new MockMemoryClient();
  } else {
    _client = new SupermemoryHttpClient(env.supermemoryKey!, env.supermemoryWorkspace);
  }
  return _client;
}
