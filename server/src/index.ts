// MUST be the first import — loads .env before any other module reads process.env.
// ESM hoists imports, so a top-level loadEnv() call would run too late.
import "./load-env.js";

import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerOnboardRoutes } from "./routes/onboard.js";
import { registerCheckoutEventRoute } from "./routes/checkout-event.js";
import { registerAgentPhoneWebhook } from "./routes/webhooks/agentphone.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true, service: "lasso-server" }));

await registerOnboardRoutes(app);
await registerCheckoutEventRoute(app);
await registerAgentPhoneWebhook(app);

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`lasso server listening on :${port}`);
