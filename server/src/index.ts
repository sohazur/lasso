// MUST be the first import — loads .env before any other module reads process.env.
// ESM hoists imports, so a top-level loadEnv() call would run too late.
import "./load-env.js";

import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerOnboardRoutes } from "./routes/onboard.js";
import { registerCheckoutEventRoute } from "./routes/checkout-event.js";
import { registerAgentPhoneWebhook } from "./routes/webhooks/agentphone.js";
import { ensureSharedAgent } from "./agents/shared-agent.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(cors, { origin: true });

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

await registerOnboardRoutes(app);
await registerCheckoutEventRoute(app);
await registerAgentPhoneWebhook(app);

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`lasso server listening on :${port}`);

// Provision the shared Lasso AgentPhone agent + register the webhook.
// Done after listen() so health checks don't 500 during this potentially-slow step.
ensureSharedAgent().catch((err) => {
  app.log.error({ err }, "shared-agent bootstrap failed");
});
