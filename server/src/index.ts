// MUST be the first import — loads .env before any other module reads process.env.
// ESM hoists imports, so a top-level loadEnv() call would run too late.
import "./load-env.js";

import Fastify from "fastify";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerOnboardRoutes } from "./routes/onboard.js";
import { registerCheckoutEventRoute } from "./routes/checkout-event.js";
import { registerCallsRoutes } from "./routes/calls.js";
import { registerStrategyRoutes } from "./routes/strategy.js";
import { registerAgentPhoneWebhook } from "./routes/webhooks/agentphone.js";
import { registerAgentPhoneTurnWebhook } from "./routes/webhooks/agentphone-turn.js";
import { ensureSharedAgent } from "./agents/shared-agent.js";
import { seedDefaultStrategy } from "./agents/seed-defaults.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(cors, { origin: true });

// Raw-body plugin so we can HMAC-verify AgentPhone webhook deliveries.
// Routes opt in via `config: { rawBody: true }`.
await app.register(rawBody, {
  global: false,
  field: "rawBody",
  encoding: "utf8",
  runFirst: true,
});

// Snippet posts as text/plain so the browser treats it as a "simple" CORS
// request (no preflight). sendBeacon and fetch-with-keepalive both silently
// drop the body if a preflight is required during page unload.
app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
  try {
    done(null, body && (body as string).length > 0 ? JSON.parse(body as string) : {});
  } catch (err) {
    done(err as Error, undefined);
  }
});

app.get("/health", async () => {
  // Surface key wiring so a quick curl shows whether the agent's webhook
  // URL is pointing at this server (the most common drift bug — ngrok URLs
  // get baked into AgentPhone and never updated when the server moves to
  // Railway). Compare publicUrl below against the AgentPhone agent
  // dashboard's Webhook URL field.
  const { getSharedAgent } = await import("./agents/shared-agent.js");
  const shared = getSharedAgent();
  return {
    ok: true,
    service: "lasso-server",
    publicUrl: process.env.PUBLIC_URL ?? null,
    expected_webhook_url: process.env.PUBLIC_URL
      ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/webhooks/agentphone-turn`
      : null,
    shared_agent: shared
      ? {
          agentId: shared.agentId,
          numberId: shared.numberId,
          phoneNumber: shared.phoneNumber,
          webhook_secret_loaded: !!shared.webhookSecret,
          // Last 6 chars of the secret so you can sanity-check that what
          // we have matches what the AgentPhone dashboard shows, without
          // exposing the full secret.
          webhook_secret_tail: shared.webhookSecret
            ? shared.webhookSecret.slice(-6)
            : null,
          webhook_secret_source: process.env.LASSO_SHARED_WEBHOOK_SECRET
            ? "env_pinned"
            : "auto_registered",
        }
      : null,
  };
});

// Serve the compiled snippet bundle so merchants can <script src=".../snippet.js">.
// We cache the file in memory after the first read; the bundle is tiny (~15KB).
const HERE = dirname(fileURLToPath(import.meta.url));
// All paths are anchored off this file's location so they don't depend on
// the start command's cwd (Railway runs `npm run --workspace server start`
// which sets cwd to /app/server, not /app).
const SNIPPET_CANDIDATES = [
  // Standard layout: server/dist/index.js → ../../snippet/dist/index.global.js
  resolve(HERE, "../../snippet/dist/index.global.js"),
  // Same monorepo, but if the server bundle lives one level deeper
  resolve(HERE, "../../../snippet/dist/index.global.js"),
  // Defensive: snippet built into the server workspace itself
  resolve(HERE, "../snippet/dist/index.global.js"),
];
let snippetCache: string | null = null;
let snippetPath: string | null = null;
async function readSnippet(): Promise<string | null> {
  if (snippetCache) return snippetCache;
  for (const candidate of SNIPPET_CANDIDATES) {
    try {
      snippetCache = await readFile(candidate, "utf8");
      snippetPath = candidate;
      app.log.info({ path: candidate, bytes: snippetCache.length }, "snippet.js loaded");
      return snippetCache;
    } catch {
      // try the next candidate
    }
  }
  app.log.error({ tried: SNIPPET_CANDIDATES }, "snippet.js not found on disk");
  return null;
}
app.get("/snippet.js", async (_req, reply) => {
  const body = await readSnippet();
  if (!body) {
    return reply
      .code(404)
      .header("content-type", "text/plain")
      .send(`// snippet not built. tried: ${SNIPPET_CANDIDATES.join(", ")}`);
  }
  return reply
    .header("content-type", "application/javascript; charset=utf-8")
    .header("cache-control", "public, max-age=300")
    .header("x-snippet-source", snippetPath ?? "unknown")
    .send(body);
});

await registerOnboardRoutes(app);
await registerCheckoutEventRoute(app);
await registerCallsRoutes(app);
await registerStrategyRoutes(app);
await registerAgentPhoneWebhook(app);
await registerAgentPhoneTurnWebhook(app);

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`lasso server listening on :${port}`);

// Provision the shared Lasso AgentPhone agent + register the webhook.
// Done after listen() so health checks don't 500 during this potentially-slow step.
ensureSharedAgent().catch((err) => {
  app.log.error({ err }, "shared-agent bootstrap failed");
});

// Seed default behavior/brand_brief/playbooks for the demo merchant the first
// time the server boots. Non-destructive: only writes empty slots.
seedDefaultStrategy().catch((err) => {
  app.log.error({ err }, "seedDefaultStrategy failed");
});
