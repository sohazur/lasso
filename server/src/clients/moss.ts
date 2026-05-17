/**
 * Moss client — real-time semantic search of merchant KB during calls.
 *
 * Per SPEC: one index per merchant, named `merchant_{id}`. Built once at
 * onboarding, queried via the lookup_store tool during live calls.
 *
 * MOCK mode: substring search over in-memory docs.
 */

import { env, isMock } from "./config.js";

export type MossDoc = {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

export type MossSearchResult = {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export interface MossSearchClient {
  createIndex(name: string, docs: MossDoc[]): Promise<void>;
  query(indexName: string, q: string, topK?: number): Promise<MossSearchResult[]>;
  hasIndex(name: string): Promise<boolean>;
  deleteIndex(name: string): Promise<void>;
}

class MockMossClient implements MossSearchClient {
  private indexes = new Map<string, MossDoc[]>();

  async createIndex(name: string, docs: MossDoc[]): Promise<void> {
    this.indexes.set(name, docs);
  }

  async query(indexName: string, q: string, topK = 5): Promise<MossSearchResult[]> {
    const docs = this.indexes.get(indexName) ?? [];
    const query = q.toLowerCase();
    return docs
      .map((d) => ({
        ...d,
        score: d.text.toLowerCase().includes(query) ? 1 : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async hasIndex(name: string): Promise<boolean> {
    return this.indexes.has(name);
  }

  async deleteIndex(name: string): Promise<void> {
    this.indexes.delete(name);
  }
}

// Real Moss SDK wrapper. We avoid importing @moss-dev/moss here so the server
// can boot without the package installed; deferred require below.
class RealMossClient implements MossSearchClient {
  private mossInstance: unknown = null;

  private async sdk(): Promise<{ createIndex: Function; loadIndex: Function; query: Function; deleteIndex?: Function }> {
    if (this.mossInstance) return this.mossInstance as never;
    // Dynamic import so tsx doesn't choke if the package is missing
    try {
      const mod = await import("@moss-dev/moss" as never);
      const { MossClient } = mod as { MossClient: new (id: string, key: string) => unknown };
      this.mossInstance = new MossClient(env.mossProjectId!, env.mossProjectKey!);
      return this.mossInstance as never;
    } catch (err) {
      throw new Error(`Moss SDK not installed — npm install @moss-dev/moss (${(err as Error).message})`);
    }
  }

  async createIndex(name: string, docs: MossDoc[]): Promise<void> {
    const client = await this.sdk();
    await client.createIndex(name, docs, { modelId: "moss-minilm" });
    await client.loadIndex(name);
  }

  async query(indexName: string, q: string, topK = 5): Promise<MossSearchResult[]> {
    const client = await this.sdk();
    const res = (await client.query(indexName, q, { topK })) as {
      docs?: Array<{ id: string; text: string; score: number; metadata?: Record<string, unknown> }>;
    };
    return (res.docs ?? []).map((d) => ({
      id: d.id,
      text: d.text,
      score: d.score,
      metadata: d.metadata,
    }));
  }

  async hasIndex(_name: string): Promise<boolean> {
    // Moss SDK API for "does this index exist" — we cache create/load and
    // catch errors from query as the existence test. Simpler placeholder:
    return false;
  }

  async deleteIndex(_name: string): Promise<void> {
    console.warn("[lasso] moss deleteIndex: not implemented");
  }
}

let _client: MossSearchClient | null = null;

export function getMoss(): MossSearchClient {
  if (_client) return _client;
  if (isMock(env.mossProjectId, env.mossProjectKey)) {
    console.warn("[lasso] moss: MOCK mode — set MOSS_PROJECT_ID and MOSS_PROJECT_KEY for real KB search");
    _client = new MockMossClient();
  } else {
    _client = new RealMossClient();
  }
  return _client;
}
