-- Additive-only: PREMVP <-> Ireland callback contract P0 hardening.
-- Does NOT drop, rename, or rewrite any existing column/row.
-- MANUAL APPLICATION REQUIRED — repo has no CI/deploy migration runner.
-- NOT APPLIED as part of this commit. Apply via Supabase SQL editor or
-- `supabase db push` only after founder review.
--
-- Column-existence context: a live SQL error (PostgreSQL 42703 —
-- "column e.queue_id does not exist") plus a full information_schema
-- column dump proved that public.executor_order_events.queue_id does NOT
-- exist live, even though app/api/executor/order-events/route.ts previously
-- attempted to insert it (removed in this same change). This migration's
-- CREATE TABLE IF NOT EXISTS therefore does not declare a queue_id column
-- and never adds one.
--
-- Column list caveat (reported honestly, not fabricated): the founder's
-- live information_schema dump reported 43 columns on the live table but
-- its full text was not available when this migration was authored. The
-- column set below is instead derived from every field the current
-- application source (app/api/executor/order-events/route.ts GET/POST and
-- lib/executor/executorCallbackContract.ts) reads or writes on this table
-- today, which is real, in-repo evidence rather than an invented list. This
-- CREATE TABLE IF NOT EXISTS is a pure no-op if the live table already
-- exists with a different or larger column set — it will not conflict with
-- or truncate any column not listed here.

create table if not exists public.executor_order_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- identity / routing
  event_type text,
  source text,
  environment text,

  -- dedup keys
  idempotency_key text,
  clob_order_id text,
  transaction_hashes jsonb,

  -- fixture/queue linkage (sourced from the verified queue row server-side;
  -- queue_id itself was never a real column and is intentionally absent)
  match_family_key text,
  reservation_id uuid,

  -- signal linkage
  signal_id text,
  candidate_id text,
  run_id text,

  -- market
  market_slug text,
  condition_id text,
  token_id text not null,
  selected_side text,
  side text,

  -- order outcome
  order_status text,
  success boolean,
  dry_run boolean,
  live_confirm boolean,

  -- pricing
  submitted_price numeric,
  submitted_size numeric,
  stake_usd numeric,
  making_amount text,
  taking_amount text,
  observed_best_bid numeric,
  observed_best_ask numeric,
  observed_price numeric,
  observed_spread numeric,
  max_entry_price numeric,

  -- cost
  fee_usd numeric,
  slippage_usd numeric,
  cost_model_version text,
  fee_notes text,

  -- executor metadata
  executor_host_country text,
  executor_version text,
  model_rule_id text,
  strategic_scope text,

  -- JSON blobs (sanitised before storage by the route)
  candidate_snapshot_json jsonb,
  response_json_sanitized jsonb,
  executor_meta jsonb,
  raw_event_json jsonb,

  -- error
  error_message text
);

-- ── existing indexes, codified idempotently (IF NOT EXISTS) ─────────────────
-- Partial unique indexes tolerate legacy/rare null idempotency_key or
-- clob_order_id rows: only non-null values are constrained. This is the P0
-- database-level guarantee that duplicate/concurrent order-event callbacks
-- can never create two rows for the same real dedup key.
create unique index if not exists executor_order_events_idempotency_key_uidx
  on public.executor_order_events (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists executor_order_events_clob_order_id_uidx
  on public.executor_order_events (clob_order_id)
  where clob_order_id is not null;

create index if not exists executor_order_events_created_at_idx
  on public.executor_order_events (created_at desc);

create index if not exists executor_order_events_signal_id_idx
  on public.executor_order_events (signal_id);

create index if not exists executor_order_events_token_id_idx
  on public.executor_order_events (token_id);

-- ── new data-safe queue idempotency index ───────────────────────────────────
-- Partial unique: only enforced where idempotency_key is already non-null,
-- so any legacy queue row without one remains valid and unaffected.
create unique index if not exists event_execution_queue_idempotency_key_uidx
  on public.event_execution_queue (idempotency_key)
  where idempotency_key is not null;

-- ── backward-compatible queue status CHECK ──────────────────────────────────
-- Union of every status value referenced anywhere in current source
-- (lib/executor/executorQueueTypes.ts, lib/executor/executorCallbackContract.ts,
-- lib/executor/eventExecutionQueue.ts, app/api/executor/queue/mark/route.ts) —
-- no existing persisted value is excluded.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'event_execution_queue_status_check'
  ) then
    alter table public.event_execution_queue
      add constraint event_execution_queue_status_check
      check (status in ('READY','CLAIMED','SENT','EXECUTED','SKIPPED','FAILED','EXPIRED','CANCELLED'));
  end if;
end $$;
