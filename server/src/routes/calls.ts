/**
 * Dashboard read-only routes — calls list + detail + stats.
 *
 * No auth in v1 — the dashboard talks directly to the server over a CORS-open
 * connection. Production would gate these behind a merchant session.
 */

import type { FastifyInstance } from "fastify";
import { getStore } from "../clients/supabase.js";

export async function registerCallsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { merchant_id?: string; limit?: string } }>(
    "/api/calls",
    async (req, reply) => {
      const merchantId = req.query.merchant_id;
      const limit = req.query.limit ? Math.min(200, parseInt(req.query.limit, 10) || 50) : 50;
      const rows = await getStore().listCalls(merchantId, limit);
      return reply.send({ data: rows });
    }
  );

  app.get<{ Params: { id: string } }>("/api/calls/:id", async (req, reply) => {
    const row = await getStore().getCall(req.params.id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.send(row);
  });

  app.get<{ Querystring: { merchant_id?: string; since?: string } }>(
    "/api/stats",
    async (req, reply) => {
      const merchantId = req.query.merchant_id;
      const rows = await getStore().listCalls(merchantId, 500);

      const totalCalls = rows.length;
      const connected = rows.filter((r) => r.status === "connected" || r.status === "completed").length;
      const recovered = rows.filter((r) => r.outcome === "recovered").length;
      const recoveredCents = rows.reduce((sum, r) => sum + (r.recovered_cents ?? 0), 0);

      // Today's slice
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const todayRows = rows.filter((r) => r.created_at && new Date(r.created_at) >= dayStart);
      const todayRecoveredCents = todayRows.reduce((sum, r) => sum + (r.recovered_cents ?? 0), 0);

      return reply.send({
        total_calls: totalCalls,
        calls_today: todayRows.length,
        connected_calls: connected,
        connect_rate: totalCalls > 0 ? connected / totalCalls : 0,
        recovered_calls: recovered,
        recovered_cents: recoveredCents,
        recovered_cents_today: todayRecoveredCents,
      });
    }
  );
}
