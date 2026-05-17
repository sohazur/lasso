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
  failed_reason text,
  agentphone_call_id text,
  transcript text,
  duration_secs integer,
  recovered_cents integer,
  created_at timestamptz default now(),
  ended_at timestamptz
);

-- Backfill column if the table already exists from a prior schema run
alter table calls add column if not exists failed_reason text;

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
