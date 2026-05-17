/**
 * AgentPhone client — outbound voice calls.
 *
 * The real SDK contract isn't standardized in this codebase yet, so this
 * wrapper exposes the minimum shape we need: place a call with a system
 * prompt + a tools array, get a call ID back, then receive webhooks for
 * lifecycle events.
 *
 * MOCK mode: returns a fake call ID and logs the would-be payload.
 * FAKE_CALL_MODE: same as mock, even when keys are present — for stage
 * rehearsal without burning sponsor credits.
 */

import { env, isMock } from "./config.js";

export type AgentPhoneTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // The server-side handler invoked when the agent calls this tool.
  // AgentPhone's real API may use webhooks for this; this is a placeholder shape.
  handler?: (args: Record<string, unknown>) => Promise<string>;
};

export type PlaceCallRequest = {
  to: string;
  from: string;
  systemPrompt: string;
  firstMessage?: string;
  voiceId?: string;
  tools?: AgentPhoneTool[];
  webhookUrl: string;
  metadata?: Record<string, unknown>;
};

export type PlaceCallResponse = {
  callId: string;
  status: "queued" | "ringing" | "failed";
};

export interface AgentPhoneClient {
  placeCall(req: PlaceCallRequest): Promise<PlaceCallResponse>;
}

class MockAgentPhoneClient implements AgentPhoneClient {
  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResponse> {
    const callId = `mock_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(
      `[lasso] agentphone MOCK placeCall → to=${req.to} from=${req.from} promptLen=${req.systemPrompt.length} tools=${req.tools?.length ?? 0}`
    );
    console.log(`[lasso] agentphone MOCK system prompt:\n${req.systemPrompt.slice(0, 500)}…`);
    return { callId, status: "queued" };
  }
}

class RealAgentPhoneClient implements AgentPhoneClient {
  // TODO: replace with real AgentPhone SDK / REST contract once we have docs.
  constructor(private apiKey: string) {}

  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResponse> {
    // Placeholder using a hypothetical REST shape — we'll patch this with the
    // real endpoint once the AgentPhone sponsor docs are in hand.
    const res = await fetch("https://api.agentphone.com/v1/calls", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        to: req.to,
        from: req.from,
        system_prompt: req.systemPrompt,
        first_message: req.firstMessage,
        voice_id: req.voiceId,
        tools: req.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
        webhook_url: req.webhookUrl,
        metadata: req.metadata,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[lasso] agentphone placeCall failed ${res.status}: ${text}`);
      return { callId: "", status: "failed" };
    }
    const json = (await res.json()) as { call_id: string; status: "queued" | "ringing" };
    return { callId: json.call_id, status: json.status };
  }
}

let _client: AgentPhoneClient | null = null;

export function getAgentPhone(): AgentPhoneClient {
  if (_client) return _client;
  if (env.fakeCallMode || isMock(env.agentphoneKey)) {
    const reason = env.fakeCallMode ? "LASSO_FAKE_CALL_MODE=true" : "AGENTPHONE_API_KEY missing";
    console.warn(`[lasso] agentphone: MOCK mode (${reason})`);
    _client = new MockAgentPhoneClient();
  } else {
    _client = new RealAgentPhoneClient(env.agentphoneKey!);
  }
  return _client;
}
