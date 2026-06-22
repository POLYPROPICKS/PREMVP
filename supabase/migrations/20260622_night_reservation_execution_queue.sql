-- Contur3 canonical night pipeline: event-first reservations + per-event execution queue.
-- Append-only. Does NOT modify or drop existing executor tables.
--
-- night_event_reservations : frozen event-level plan, written ~17:00 Minsk under a plan_run_id.
-- event_execution_queue     : per-event single-market selections, written at T-60/T-30 rebalance.
--                             Ireland reads ONLY this table (via /api/executor/queue).
--
-- MANUAL APPLICATION REQUIRED: repo has no CI/deploy migration runner. Apply via Supabase
-- SQL editor or supabase db push before the routes/crons are exercised in production.

-- ── night_event_reservations ────────────────────────────────────────────────
create table if not exists public.night_event_reservations (
  id uuid primary key default gen_random_uuid(),
  plan_run_id text not null,
  plan_date_minsk date not null,
  reserved_at timestamptz not null default now(),
  window_start_iso timestamptz not null,
  window_end_iso timestamptz not null,
  match_family_key text not null,
  event_slug text,
  event_title text,
  sport text,
  league text,
  strategic_scope text,
  game_start_iso timestamptz not null,
  event_tier text,
  event_score numeric,
  best_snapshot_id text,
  reservation_rank int,
  -- RESERVED | REBALANCE_PENDING | QUEUED | SKIPPED | EXPIRED | CANCELLED
  status text not null default 'RESERVED',
  selection_reason text,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint night_event_reservations_plan_event_uniq unique (plan_run_id, match_family_key)
);

create index if not exists night_event_reservations_plan_run_idx
  on public.night_event_reservations (plan_run_id);
create index if not exists night_event_reservations_match_family_idx
  on public.night_event_reservations (match_family_key);
create index if not exists night_event_reservations_game_start_idx
  on public.night_event_reservations (game_start_iso);
create index if not exists night_event_reservations_status_idx
  on public.night_event_reservations (status);
create index if not exists night_event_reservations_plan_date_idx
  on public.night_event_reservations (plan_date_minsk);

-- ── event_execution_queue ───────────────────────────────────────────────────
create table if not exists public.event_execution_queue (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references public.night_event_reservations(id),
  plan_run_id text not null,
  rebalance_run_id text not null,
  queued_at timestamptz not null default now(),
  match_family_key text not null,
  event_title text,
  event_slug text,
  sport text,
  league text,
  game_start_iso timestamptz not null,
  condition_id text not null,
  token_id text not null,
  side text not null,
  market_slug text,
  market_title text,
  market_family text,
  score numeric,
  coverage numeric,
  tier text not null,
  stake_usd numeric not null,
  preferred_entry_iso timestamptz not null,
  latest_entry_iso timestamptz not null,
  selection_rank int not null default 1,
  selection_reason text,
  -- READY | CLAIMED | SENT | FAILED | EXPIRED | CANCELLED
  status text not null default 'READY',
  order_key text,
  idempotency_key text,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_execution_queue_reservation_rank_uniq unique (reservation_id, selection_rank),
  constraint event_execution_queue_token_plan_uniq unique (condition_id, token_id, side, plan_run_id)
);

create index if not exists event_execution_queue_plan_run_idx
  on public.event_execution_queue (plan_run_id);
create index if not exists event_execution_queue_reservation_idx
  on public.event_execution_queue (reservation_id);
create index if not exists event_execution_queue_match_family_idx
  on public.event_execution_queue (match_family_key);
create index if not exists event_execution_queue_game_start_idx
  on public.event_execution_queue (game_start_iso);
create index if not exists event_execution_queue_status_idx
  on public.event_execution_queue (status);
create index if not exists event_execution_queue_preferred_entry_idx
  on public.event_execution_queue (preferred_entry_iso);
create index if not exists event_execution_queue_latest_entry_idx
  on public.event_execution_queue (latest_entry_iso);

-- One READY selection per reservation (a reservation may only have one live market queued).
create unique index if not exists event_execution_queue_one_ready_per_reservation
  on public.event_execution_queue (reservation_id)
  where status = 'READY';

-- ── updated_at touch trigger (matches project style if trigger fn exists) ─────
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists night_event_reservations_touch on public.night_event_reservations;
create trigger night_event_reservations_touch
  before update on public.night_event_reservations
  for each row execute function public.touch_updated_at();

drop trigger if exists event_execution_queue_touch on public.event_execution_queue;
create trigger event_execution_queue_touch
  before update on public.event_execution_queue
  for each row execute function public.touch_updated_at();
