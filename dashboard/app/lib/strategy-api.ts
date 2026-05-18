/**
 * Strategy editor client. Talks to the Lasso server's /api/strategy/*
 * endpoints — same Fastify backend the rest of the dashboard uses.
 * Adapted from the original FastAPI-based strategy-service so /sarah
 * works against a single backend.
 *
 * Endpoints surfaced here:
 *   GET  /api/strategy/prompts/:name          → { name, content }
 *   POST /api/strategy/prompts/:name          → { saved }
 *   GET  /api/strategy/playbooks              → { by_exit_point, overrides, fallback }
 *   POST /api/strategy/playbooks              → { saved }
 *   GET  /api/strategy/call-log?limit=N       → { calls: [...] }
 *
 * The call-detail + live transcript pages already live at /calls/[id]
 * via the existing api.ts, so we don't re-implement those here.
 */

const SERVER =
  process.env.NEXT_PUBLIC_LASSO_SERVER ?? "http://localhost:3001";

export type PromptName = "behavior" | "brand_brief";

export type Playbook = {
  concern: string;
  probe: string;
  approach: string;
};

export type Playbooks = {
  by_exit_point: Record<string, Playbook>;
  overrides: Record<string, Playbook>;
  fallback?: string;
};

export type CallRow = {
  id: string;
  status: string;
  duration_seconds: number | null;
  to_number: string | null;
  from_number: string | null;
  started_at: string | null;
  ended_at: string | null;
  agent_name: string | null;
};

async function jsonOrError<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getPrompt(name: PromptName): Promise<{ name: string; content: string }> {
  const res = await fetch(`${SERVER}/api/strategy/prompts/${name}`, { cache: "no-store" });
  return jsonOrError(res);
}

export async function savePrompt(name: PromptName, content: string): Promise<void> {
  const res = await fetch(`${SERVER}/api/strategy/prompts/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  await jsonOrError(res);
}

export async function getPlaybooks(): Promise<Playbooks> {
  const res = await fetch(`${SERVER}/api/strategy/playbooks`, { cache: "no-store" });
  return jsonOrError(res);
}

export async function savePlaybooks(pb: Playbooks): Promise<void> {
  const res = await fetch(`${SERVER}/api/strategy/playbooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pb),
  });
  await jsonOrError(res);
}

export async function getCallLog(limit = 30): Promise<{ calls: CallRow[] }> {
  const res = await fetch(`${SERVER}/api/strategy/call-log?limit=${limit}`, { cache: "no-store" });
  return jsonOrError(res);
}

/**
 * The original FastAPI had /api/calls/{id} returning briefing + system_prompt.
 * Our equivalent: the existing getCall() in api.ts returns the full CallRow
 * with transcript. Re-export a thin adapter here so /sarah can use the same
 * shape it expects.
 */
export async function getCallContext(callId: string): Promise<{ briefing?: string }> {
  const res = await fetch(`${SERVER}/api/calls/${callId}`, { cache: "no-store" });
  const row = await jsonOrError<{ transcript?: string | null }>(res);
  // We don't store a separate "briefing" yet — return empty so the UI degrades
  // gracefully.
  return { briefing: row.transcript ?? "" };
}

export async function getCallLive(callId: string): Promise<{
  status?: string;
  duration_seconds?: number | null;
  turns?: Array<{ user: string; agent: string; created_at?: string }>;
}> {
  const res = await fetch(`${SERVER}/api/calls/${callId}`, { cache: "no-store" });
  const row = await jsonOrError<{
    status?: string;
    duration_secs?: number | null;
    transcript?: string | null;
    created_at?: string | null;
  }>(res);
  // The original API returned alternating user/agent turn pairs. We don't
  // structure the transcript that way; return one synthetic "turn" with the
  // full transcript so the UI shows something. Could parse the bubble format
  // later if /sarah's transcript view needs alternation.
  const turns = row.transcript
    ? [{ user: "", agent: row.transcript, created_at: row.created_at ?? undefined }]
    : [];
  return {
    status: row.status,
    duration_seconds: row.duration_secs ?? null,
    turns,
  };
}

/**
 * Test-call trigger from the FastAPI was a one-button "make a fake call".
 * We can do the equivalent against our /checkout-event with synthetic data,
 * but it's better invoked via the existing scripts/fire-abandonment.sh.
 * Stub kept for backward shape compatibility.
 */
export async function triggerTestCall(): Promise<{ call_id?: string }> {
  throw new Error(
    "Test calls aren't wired through /sarah. Use scripts/fire-abandonment.sh or the demo store.",
  );
}

export const STRATEGY_URL = SERVER;
