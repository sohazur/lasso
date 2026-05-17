-- Lasso — Supabase schema
-- Run this in the Supabase SQL editor, or via `supabase db push` if using the CLI.

create table if not exists merchants (
  id text primary key,
  name text,
  primary_domain text,
  status text,
  failed_step text,
  failed_reason text,
  private_context jsonb,
  agentphone_agent_id text,
  agentphone_number_id text,
  agentphone_phone_number text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Backfill column if the table already exists from a prior schema run
alter table merchants add column if not exists failed_reason text;

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  merchant_id text not null references merchants(id),
  phone text not null,
  email text,
  customer_name text,
  page_url text,
  cart_lines jsonb,
  cart_total_cents integer,
  trigger text,
  status text,
  outcome text,
  agentphone_call_id text,
  transcript text,
  duration_secs integer,
  recovered_cents integer,
  created_at timestamptz default now(),
  ended_at timestamptz
);

create index if not exists calls_merchant_status_idx on calls(merchant_id, status, created_at desc);
create index if not exists calls_phone_merchant_idx on calls(merchant_id, phone);

create table if not exists stripe_attributions (
  payment_intent_id text primary key,
  call_id uuid references calls(id),
  amount_cents integer not null,
  matched_via text,
  created_at timestamptz default now()
);

-- Seed the demo merchant
insert into merchants (id, name, primary_domain)
values ('demo', 'Lasso Demo Store', 'localhost:5500')
on conflict (id) do nothing;

-- ─── proactive-closer additions ──────────────────────────────────────────
-- The closer agent emits a structured action each turn and may queue a
-- pending action (e.g. propose_payment_link) that requires a verbal
-- confirmation from the customer on the *next* turn. Foyer's submitForm
-- pattern, adapted for phone calls.
alter table calls add column if not exists pending_action_type text;
alter table calls add column if not exists pending_action_params jsonb;
alter table calls add column if not exists pending_action_set_at timestamptz;

-- Per-turn objection tag — gives the dashboard a "why are we losing deals"
-- breakdown without manual transcript review.
alter table calls add column if not exists objection_type text;
-- Suggested values: color | size | fit | shipping | price | compatibility |
-- trust | other. Enforced at the application layer (LLM emits one of these).

-- Distinguishes customer-recovery calls from founder-approval calls placed
-- by the notify_founder tool. Same `calls` table for both, because both
-- route through the shared AgentPhone agent + webhook turn handler.
alter table calls add column if not exists kind text default 'customer';
-- Suggested values: 'customer' | 'founder_approval'

-- Links a customer call to the founder call placed on its behalf.
alter table calls add column if not exists founder_call_id uuid references calls(id);
alter table calls add column if not exists founder_decision text;
-- Suggested values: 'approved' | 'denied' | 'callback' | null
alter table calls add column if not exists founder_decision_note text;

-- Founder contact info on the merchant row.
alter table merchants add column if not exists founder_name text;
alter table merchants add column if not exists founder_phone text;

create index if not exists calls_pending_action_idx
  on calls(merchant_id, pending_action_type) where pending_action_type is not null;
create index if not exists calls_kind_status_idx on calls(kind, status);
