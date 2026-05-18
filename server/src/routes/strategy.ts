/**
 * Strategy editor endpoints — prompts + playbooks for the recovery agent.
 *
 * Storage layout (Supermemory):
 *   merchant:{id}:strategy:behavior     → the agent persona / voice / flow
 *   merchant:{id}:strategy:brand_brief  → merchant-specific context briefing
 *   merchant:{id}:strategy:playbooks    → concern-keyed playbook tree (JSON)
 *
 * The webhook turn handler reads these on every voice turn, so edits in the
 * /sarah dashboard land on the next call — no server restart needed.
 *
 * For now everything is scoped to merchant_id "demo" so the UI works
 * single-tenant. Multi-merchant scoping is a query-param away.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getStore } from "../clients/supabase.js";

const PROMPT_NAMES = ["behavior", "brand_brief"] as const;
type PromptName = (typeof PROMPT_NAMES)[number];

const DEFAULT_MERCHANT = "demo";

const PromptBody = z.object({
  content: z.string(),
});

const PlaybooksBody = z.object({
  by_exit_point: z.record(
    z.object({
      concern: z.string(),
      probe: z.string(),
      approach: z.string(),
    }),
  ),
  overrides: z
    .record(
      z.object({
        concern: z.string(),
        probe: z.string(),
        approach: z.string(),
      }),
    )
    .optional()
    .default({}),
  fallback: z.string().optional().default("order_review"),
});

async function readSlot(merchantId: string, slot: PromptName | "playbooks"): Promise<string | null> {
  return getStore().getStrategySlot(merchantId, slot);
}

async function writeSlot(merchantId: string, slot: PromptName | "playbooks", text: string): Promise<void> {
  await getStore().setStrategySlot(merchantId, slot, text);
}

export async function registerStrategyRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/strategy/prompts/:name
  app.get<{ Params: { name: string }; Querystring: { merchant_id?: string } }>(
    "/api/strategy/prompts/:name",
    async (req, reply) => {
      const name = req.params.name as PromptName;
      if (!PROMPT_NAMES.includes(name)) {
        return reply.code(404).send({ error: "unknown_prompt" });
      }
      const merchantId = req.query.merchant_id ?? DEFAULT_MERCHANT;
      const content = (await readSlot(merchantId, name)) ?? "";
      return reply.send({ name, content, merchant_id: merchantId });
    },
  );

  // POST /api/strategy/prompts/:name  body: { content }
  app.post<{ Params: { name: string }; Querystring: { merchant_id?: string } }>(
    "/api/strategy/prompts/:name",
    async (req, reply) => {
      const name = req.params.name as PromptName;
      if (!PROMPT_NAMES.includes(name)) {
        return reply.code(404).send({ error: "unknown_prompt" });
      }
      const parsed = PromptBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const merchantId = req.query.merchant_id ?? DEFAULT_MERCHANT;
      await writeSlot(merchantId, name, parsed.data.content);
      return reply.send({ saved: true, name, merchant_id: merchantId });
    },
  );

  // GET /api/strategy/playbooks
  app.get<{ Querystring: { merchant_id?: string } }>(
    "/api/strategy/playbooks",
    async (req, reply) => {
      const merchantId = req.query.merchant_id ?? DEFAULT_MERCHANT;
      const raw = await readSlot(merchantId, "playbooks");
      if (!raw) {
        // No playbooks stored yet — return the empty shell so the UI renders.
        return reply.send({
          by_exit_point: {},
          overrides: {},
          fallback: "order_review",
          merchant_id: merchantId,
        });
      }
      try {
        const parsed = JSON.parse(raw);
        return reply.send({ ...parsed, merchant_id: merchantId });
      } catch (err) {
        return reply.code(500).send({
          error: "corrupt_playbooks",
          detail: (err as Error).message,
        });
      }
    },
  );

  // POST /api/strategy/playbooks  body: full playbook tree
  app.post<{ Querystring: { merchant_id?: string } }>(
    "/api/strategy/playbooks",
    async (req, reply) => {
      const parsed = PlaybooksBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const merchantId = req.query.merchant_id ?? DEFAULT_MERCHANT;
      await writeSlot(merchantId, "playbooks", JSON.stringify(parsed.data, null, 2));
      return reply.send({ saved: true, merchant_id: merchantId });
    },
  );

  // GET /api/strategy/call-log  — proxy to our calls listing, in the shape /sarah expects
  app.get<{ Querystring: { merchant_id?: string; limit?: string } }>(
    "/api/strategy/call-log",
    async (req, reply) => {
      const merchantId = req.query.merchant_id;
      const limit = req.query.limit ? Math.min(100, parseInt(req.query.limit, 10) || 30) : 30;
      const rows = await getStore().listCalls(merchantId, limit);
      const calls = rows.map((r) => ({
        id: r.id,
        status: r.status,
        duration_seconds: r.duration_secs ?? null,
        to_number: r.phone,
        from_number: null,
        started_at: r.created_at ?? null,
        ended_at: r.ended_at ?? null,
        agent_name: r.customer_name ?? null,
      }));
      return reply.send({ calls });
    },
  );
}
