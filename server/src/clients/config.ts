/**
 * Resolves runtime config from env. Missing keys are OK — clients will
 * report MOCK mode and return canned data so the wiring works end-to-end
 * before any real API spend.
 */

export const env = {
  // AgentPhone
  agentphoneKey: process.env.AGENTPHONE_API_KEY,
  lassoPhoneNumber: process.env.LASSO_PHONE_NUMBER,

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
