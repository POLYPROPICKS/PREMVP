-- Durable live-contour audit trail for PREMVP -> Ireland -> CLOB -> resolver.
-- Append-only. Does not modify existing executor tables.

create table if not exists public.executor_audit_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  run_id text,
  trace_id text,
  stage text not null,
  event_slug text,
  market_slug text,
  side text,
  condition_id text,
  token_id text,
  score numeric,
  coverage numeric,
  tier text,
  stake_usd numeric,
  live_eligible boolean,
  status text,
  reason text,
  source text,
  payload_json jsonb
);

create index if not exists executor_audit_events_created_at_idx
  on public.executor_audit_events (created_at desc);

create index if not exists executor_audit_events_trace_id_idx
  on public.executor_audit_events (trace_id);

create index if not exists executor_audit_events_run_id_idx
  on public.executor_audit_events (run_id);

create index if not exists executor_audit_events_stage_idx
  on public.executor_audit_events (stage);

create index if not exists executor_audit_events_condition_token_idx
  on public.executor_audit_events (condition_id, token_id);
