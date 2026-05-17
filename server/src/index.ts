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
import { registerAgentPhoneWebhook } from "./routes/webhooks/agentphone.js";
import { registerAgentPhoneTurnWebhook } from "./routes/webhooks/agentphone-turn.js";
import { ensureSharedAgent } from "./agents/shared-agent.js";

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

app.get("/health", async () => ({ ok: true, service: "lasso-server" }));

// Serve the compiled snippet bundle so merchants can <script src=".../snippet.js">.
// We cache the file in memory after the first read; the bundle is tiny (~15KB).
const HERE = dirname(fileURLToPath(import.meta.url));
const SNIPPET_CANDIDATES = [
  // Local dev: server/dist/index.js → ../../snippet/dist/index.global.js
  resolve(HERE, "../../snippet/dist/index.global.js"),
  // Railway / Docker (cwd is /app): /app/snippet/dist/index.global.js
  resolve(process.cwd(), "snippet/dist/index.global.js"),
  // Fallback if nixpacks puts the snippet build under server/snippet
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
