// Load .env from the lasso/ repo root so server + dashboard share one file.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../.env") });

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
