/**
 * Client for the strategy-service FastAPI (Shanzila's recovery-agent brain).
 * Override the URL via NEXT_PUBLIC_STRATEGY_SERVICE.
 *
 * Endpoints surfaced here:
 *   GET  /api/prompts/{name}           → { name, content }
 *   POST /api/prompts/{name}           → { saved }
 *   GET  /api/playbooks                → playbook tree (by_exit_point, overrides, fallback)
 *   POST /api/playbooks                → { saved }
 *   GET  /api/call-log?limit=N         → { calls: [...] }
 *   GET  /api/calls/{id}               → stored context (briefing, system_prompt, opening)
 *   GET  /api/calls/{id}/live          → live status + transcript
 *   POST /api/test-call                → fires a test abandonment
 */

const STRATEGY =
  process.env.NEXT_PUBLIC_STRATEGY_SERVICE ?? "http://localhost:8000";

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
  const res = await fetch(`${STRATEGY}/api/prompts/${name}`);
  return jsonOrError(res);
}

export async function savePrompt(name: PromptName, content: string): Promise<void> {
  const res = await fetch(`${STRATEGY}/api/prompts/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  await jsonOrError(res);
}

export async function getPlaybooks(): Promise<Playbooks> {
  const res = await fetch(`${STRATEGY}/api/playbooks`);
  return jsonOrError(res);
}

export async function savePlaybooks(pb: Playbooks): Promise<void> {
  const res = await fetch(`${STRATEGY}/api/playbooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pb),
  });
  await jsonOrError(res);
}

export async function getCallLog(limit = 30): Promise<{ calls: CallRow[] }> {
  const res = await fetch(`${STRATEGY}/api/call-log?limit=${limit}`);
  return jsonOrError(res);
}

export async function getCallContext(callId: string): Promise<{ briefing?: string }> {
  const res = await fetch(`${STRATEGY}/api/calls/${callId}`);
  return jsonOrError(res);
}

export async function getCallLive(callId: string): Promise<{
  status?: string;
  duration_seconds?: number | null;
  turns?: Array<{ user: string; agent: string; created_at?: string }>;
}> {
  const res = await fetch(`${STRATEGY}/api/calls/${callId}/live`);
  return jsonOrError(res);
}

export async function triggerTestCall(): Promise<{ call_id?: string }> {
  const res = await fetch(`${STRATEGY}/api/test-call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return jsonOrError(res);
}

export const STRATEGY_URL = STRATEGY;
