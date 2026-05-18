/**
 * Resolves runtime config from env. Missing keys are OK — clients will
 * report MOCK mode and return canned data so the wiring works end-to-end
 * before any real API spend.
 */

export const env = {
  // AgentPhone
  agentphoneKey: process.env.AGENTPHONE_API_KEY,
  lassoPhoneNumber: process.env.LASSO_PHONE_NUMBER,
  // Pre-known shared agent IDs — if set, skip the listAgents() bootstrap call.
  // Useful when AgentPhone's API is slow or down.
  sharedAgentId: process.env.LASSO_SHARED_AGENT_ID,
  sharedNumberId: process.env.LASSO_SHARED_NUMBER_ID,
  // Separate number ID for SMS dispatch. The voice/SMS line +18154964627
  // requires US carrier 10DLC registration (~$25 + 7-10 days) before
  // /messages will accept POSTs. For the demo we route SMS through the
  // shared iMessage line +17578314612 instead — it doesn't need 10DLC
  // and works for whitelisted contacts (your demo phone is on the
  // whitelist already).
  imessageNumberId: process.env.LASSO_IMESSAGE_NUMBER_ID,
  // Pre-existing webhook secret from AgentPhone dashboard. When set, we
  // SKIP calling registerAgentWebhook() — re-registering generates a new
  // secret on AgentPhone's side, racing against any incoming webhook
  // delivery and leaving us with a mismatched secret on one side.
  sharedWebhookSecret: process.env.LASSO_SHARED_WEBHOOK_SECRET,

  // Supermemory
  supermemoryKey: process.env.SUPERMEMORY_API_KEY,
  supermemoryWorkspace: process.env.SUPERMEMORY_WORKSPACE_ID,

  // Moss
  mossProjectId: process.env.MOSS_PROJECT_ID,
  mossProjectKey: process.env.MOSS_PROJECT_KEY,

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,

  // Firecrawl
  firecrawlKey: process.env.FIRECRAWL_API_KEY,

  // OpenRouter (OpenAI-compatible)
  openrouterKey: process.env.OPENROUTER_API_KEY,
  openrouterModel: process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash-lite",

  // Misc
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:3001",
  fakeCallMode: process.env.LASSO_FAKE_CALL_MODE === "true",
} as const;

export function isMock(...keys: Array<string | undefined>): boolean {
  return keys.some((k) => !k || k.length === 0);
}
