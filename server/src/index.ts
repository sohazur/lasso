import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true, service: "lasso-server" }));

// TODO: register routes
//   POST /checkout-event           ← snippet posts here
//   POST /webhooks/stripe          ← stripe attribution
//   POST /webhooks/agentphone      ← call-ended webhook
//   GET  /api/calls                ← dashboard list
//   GET  /api/calls/:id            ← dashboard detail
//   GET  /api/stats                ← recovered $$ counter

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`lasso server listening on :${port}`);
