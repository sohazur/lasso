/**
 * AgentPhone client — real API (api.agentphone.ai/v1).
 *
 * Two-step model:
 *   1. (Once per merchant, at onboarding) Create an agent persona + attach
 *      a phone number. Stash both IDs on the merchant row.
 *   2. (Per call) POST /v1/calls with { agentId, toNumber, systemPrompt }
 *      using "hosted" mode so AgentPhone runs the LLM for us.
 *
 * MOCK mode: returns fake IDs and logs the would-be payload.
 * FAKE_CALL_MODE: same as mock, even with keys present — for stage rehearsal.
 */

import { env, isMock } from "./config.js";

const BASE_URL = "https://api.agentphone.ai/v1";

export type CreateAgentRequest = {
  name: string;
  description?: string;
  voiceMode?: "hosted" | "webhook";
  systemPrompt?: string;
  beginMessage?: string;
  voice?: string;
  modelTier?: "turbo" | "balanced" | "max";
  sttMode?: "fast" | "accurate";
};

export type AgentResponse = {
  id: string;
  name: string;
  voiceMode: string;
  voice?: string;
};

export type ProvisionNumberResponse = {
  id: string;
  phoneNumber: string;
  status?: string;
  agentId?: string | null;
  type?: string;
};

export type AttachNumberResponse = {
  agentId: string;
  number: ProvisionNumberResponse;
};

export type ListNumbersResponse = {
  data: ProvisionNumberResponse[];
  hasMore?: boolean;
  total?: number;
};

export type PlaceCallRequest = {
  agentId: string;
  toNumber: string;
  fromNumberId?: string;
  systemPrompt?: string;
  initialGreeting?: string;
  voice?: string;
  variables?: Record<string, string>;
};

export type PlaceCallResponse = {
  callId: string;
  status: "queued" | "ringing" | "failed";
};

export type SendMessageRequest = {
  agentId: string;
  toNumber: string;
  body: string;
  numberId?: string;
};

export type SendMessageResponse = {
  id?: string;
  status?: string;
};

export type ListAgentsResponse = {
  data: AgentResponse[];
  hasMore?: boolean;
};

export type RegisterAgentWebhookRequest = {
  url: string;
  contextLimit?: number;
  timeout?: number;
};

export type WebhookResponse = {
  id: string;
  url: string;
  secret: string;
  status: string;
  contextLimit: number;
  timeout: number;
};

export interface AgentPhoneClient {
  listAgents(): Promise<AgentResponse[]>;
  createAgent(req: CreateAgentRequest): Promise<AgentResponse>;
  listNumbers(): Promise<ProvisionNumberResponse[]>;
  provisionNumber(): Promise<ProvisionNumberResponse>;
  attachNumber(agentId: string, numberId: string): Promise<AttachNumberResponse>;
  placeCall(req: PlaceCallRequest): Promise<PlaceCallResponse>;
  sendMessage(req: SendMessageRequest): Promise<SendMessageResponse>;
  registerAgentWebhook(agentId: string, req: RegisterAgentWebhookRequest): Promise<WebhookResponse>;
}

class MockAgentPhoneClient implements AgentPhoneClient {
  async listAgents(): Promise<AgentResponse[]> {
    return [];
  }
  async createAgent(req: CreateAgentRequest): Promise<AgentResponse> {
    const id = `mock_agent_${Date.now()}`;
    console.log(`[lasso] agentphone MOCK createAgent → name="${req.name}" voiceMode=${req.voiceMode ?? "hosted"}`);
    return { id, name: req.name, voiceMode: req.voiceMode ?? "hosted" };
  }
  async listNumbers(): Promise<ProvisionNumberResponse[]> {
    return [];
  }
  async provisionNumber(): Promise<ProvisionNumberResponse> {
    const id = `mock_num_${Date.now()}`;
    console.log(`[lasso] agentphone MOCK provisionNumber → ${id}`);
    return { id, phoneNumber: env.lassoPhoneNumber ?? "+10000000000", status: "active" };
  }
  async attachNumber(agentId: string, numberId: string): Promise<AttachNumberResponse> {
    console.log(`[lasso] agentphone MOCK attachNumber → agent=${agentId} number=${numberId}`);
    return { agentId, number: { id: numberId, phoneNumber: env.lassoPhoneNumber ?? "+10000000000" } };
  }
  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResponse> {
    const callId = `mock_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(
      `[lasso] agentphone MOCK placeCall → agent=${req.agentId} to=${req.toNumber} promptLen=${req.systemPrompt?.length ?? 0}`
    );
    console.log(`[lasso] agentphone MOCK system prompt:\n${(req.systemPrompt ?? "").slice(0, 600)}…`);
    return { callId, status: "queued" };
  }
  async sendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
    console.log(`[lasso] agentphone MOCK sendMessage → to=${req.toNumber} body="${req.body.slice(0, 80)}"`);
    return { id: `mock_msg_${Date.now()}`, status: "queued" };
  }
  async registerAgentWebhook(agentId: string, req: RegisterAgentWebhookRequest): Promise<WebhookResponse> {
    console.log(`[lasso] agentphone MOCK registerAgentWebhook → agent=${agentId} url=${req.url}`);
    return {
      id: `mock_wh_${Date.now()}`,
      url: req.url,
      secret: "mock_secret_dont_use_in_real",
      status: "active",
      contextLimit: req.contextLimit ?? 10,
      timeout: req.timeout ?? 30,
    };
  }
}

class RealAgentPhoneClient implements AgentPhoneClient {
  constructor(private apiKey: string) {}

  private async request<T>(path: string, body?: unknown, method: "GET" | "POST" = "POST"): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`agentphone ${method} ${path} ${res.status}: ${text.slice(0, 600)}`);
    }
    return JSON.parse(text) as T;
  }

  async listAgents(): Promise<AgentResponse[]> {
    const res = await this.request<ListAgentsResponse>("/agents", undefined, "GET");
    return res.data ?? [];
  }

  async createAgent(req: CreateAgentRequest): Promise<AgentResponse> {
    return this.request<AgentResponse>("/agents", req);
  }

  async listNumbers(): Promise<ProvisionNumberResponse[]> {
    const res = await this.request<ListNumbersResponse>("/numbers", undefined, "GET");
    return res.data ?? [];
  }

  async provisionNumber(): Promise<ProvisionNumberResponse> {
    return this.request<ProvisionNumberResponse>("/numbers", {});
  }

  async attachNumber(agentId: string, numberId: string): Promise<AttachNumberResponse> {
    return this.request<AttachNumberResponse>(`/agents/${agentId}/numbers`, { numberId });
  }

  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResponse> {
    const res = await this.request<{ id?: string; callId?: string; status?: string }>("/calls", req);
    const callId = res.callId ?? res.id ?? "";
    const status = (res.status as "queued" | "ringing" | "failed") ?? "queued";
    return { callId, status };
  }

  async sendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
    // Note: AgentPhone API uses snake_case for SendMessageRequest
    return this.request<SendMessageResponse>("/messages", {
      agent_id: req.agentId,
      to_number: req.toNumber,
      body: req.body,
      number_id: req.numberId,
    });
  }

  async registerAgentWebhook(agentId: string, req: RegisterAgentWebhookRequest): Promise<WebhookResponse> {
    return this.request<WebhookResponse>(`/agents/${agentId}/webhook`, req);
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
