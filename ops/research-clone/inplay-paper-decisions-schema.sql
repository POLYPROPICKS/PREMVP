-- RESEARCH CLONE ONLY. Apply only to Supabase project ref nppznoujvnyjargjkmnv (DBClone).
-- NEVER apply to production (nbnldzfsxffztsfrrxqy). Deliberately NOT under supabase/migrations.
-- INPLAY_PAPER_DECISIONS_V1: research-only frozen paper decisions derived from
-- research_inplay_core_path_observations. No money-path, Ireland or serving reader/writer.
-- Idempotent: safe to re-apply.

-- One immutable decision per physical event x strategy x version x scope.
-- WAITING is the only mutable state; it carries identity only. The single permitted
-- transition is WAITING -> BET | SKIP, after which every column is frozen by trigger.
create table if not exists public.research_inplay_paper_decisions (
  decision_id uuid primary key,
  physical_event_id text not null,
  strategy_id text not null,
  strategy_version text not null,
  strategy_definition_hash text not null,
  strategy_kind text not null check (strategy_kind in ('CONTROL', 'ALPHA_RESEARCH')),
  scope_key text not null,
  status text not null check (status in ('WAITING', 'BET', 'SKIP')),
  -- identity / lineage
  provider_game_id text,
  provider_event_id text,
  provider_sport_family text,
  event_start_iso timestamptz not null,
  admission_observed_at timestamptz not null,
  entry_window_end timestamptz not null,
  source_observation_id uuid,
  condition_id text,
  token_id text,
  side text,
  market_family text,
  market_scope text,
  market_line numeric,
  market_slug text,
  quote_batch_key text,
  -- executable entry facts (frozen with the decision)
  entry_vwap numeric,
  entry_quantity numeric,
  entry_notional_usd numeric,
  entry_cost_authority text,
  entry_fee_usd numeric,
  entry_fee_state text check (entry_fee_state is null or entry_fee_state in ('KNOWN', 'UNKNOWN')),
  entry_best_bid numeric,
  entry_best_ask numeric,
  entry_ask_depth_usd numeric,
  entry_bid_depth_usd numeric,
  entry_exit_vwap numeric,
  entry_exit_fully_filled boolean,
  -- state / alpha factual hooks (facts only; no model output)
  state_authority text,
  state_phase text,
  state_score_available boolean,
  state_blocker text,
  relation_state text not null default 'UNKNOWN' check (relation_state in ('PROVEN', 'UNKNOWN', 'CONTRADICTED')),
  -- candidate accounting
  admitted_candidate_n integer,
  exclusion_summary jsonb,
  reject_reason text,
  -- timing and provenance
  observed_at timestamptz,
  collector_receipt_at timestamptz,
  first_evaluated_at timestamptz not null,
  clone_available_at timestamptz,
  frozen_at timestamptz,
  processing_lag_ms bigint,
  provenance_class text check (provenance_class is null or provenance_class in ('LIVE_PROSPECTIVE', 'DELAYED_PAPER', 'TIMING_UNPROVEN')),
  result_visible_at_freeze boolean,
  created_at timestamptz not null default now(),
  -- structural invariants
  constraint inplay_paper_unique_scope unique (physical_event_id, strategy_id, strategy_version, scope_key),
  constraint inplay_paper_alpha_never_bets check (status <> 'BET' or strategy_kind = 'CONTROL'),
  constraint inplay_paper_bet_complete check (status <> 'BET' or (
    source_observation_id is not null and condition_id is not null and token_id is not null and side is not null
    and entry_vwap is not null and entry_vwap > 0 and entry_vwap < 1 and entry_quantity is not null and entry_quantity > 0
    and entry_cost_authority is not null and observed_at is not null and frozen_at is not null
    and provenance_class is not null and processing_lag_ms is not null)),
  constraint inplay_paper_skip_reason check (status <> 'SKIP' or (reject_reason is not null and frozen_at is not null and provenance_class is not null)),
  constraint inplay_paper_live_prospective_pre_result check (provenance_class is distinct from 'LIVE_PROSPECTIVE' or result_visible_at_freeze = false),
  constraint inplay_paper_waiting_unfrozen check (status <> 'WAITING' or (frozen_at is null and entry_vwap is null and token_id is null)),
  constraint inplay_paper_size check (octet_length(physical_event_id) <= 100 and octet_length(strategy_id) <= 100
    and (token_id is null or octet_length(token_id) <= 100) and (condition_id is null or octet_length(condition_id) <= 100))
);

create index if not exists research_inplay_paper_decisions_status_idx
  on public.research_inplay_paper_decisions (status, entry_window_end)
  where status = 'WAITING';
create index if not exists research_inplay_paper_decisions_frozen_idx
  on public.research_inplay_paper_decisions (strategy_id, frozen_at);

-- Immutability: frozen rows never change; WAITING may only move to BET/SKIP and may not
-- rewrite its identity columns.
create or replace function public.research_inplay_paper_decisions_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'INPLAY_PAPER_DECISION_DELETE_FORBIDDEN';
  end if;
  if old.status <> 'WAITING' then
    raise exception 'INPLAY_PAPER_DECISION_FROZEN';
  end if;
  if new.status = 'WAITING' then
    raise exception 'INPLAY_PAPER_DECISION_NOOP_UPDATE';
  end if;
  if new.decision_id <> old.decision_id or new.physical_event_id <> old.physical_event_id
     or new.strategy_id <> old.strategy_id or new.strategy_version <> old.strategy_version
     or new.strategy_definition_hash <> old.strategy_definition_hash or new.strategy_kind <> old.strategy_kind
     or new.scope_key <> old.scope_key or new.admission_observed_at <> old.admission_observed_at
     or new.entry_window_end <> old.entry_window_end or new.first_evaluated_at <> old.first_evaluated_at then
    raise exception 'INPLAY_PAPER_DECISION_IDENTITY_IMMUTABLE';
  end if;
  return new;
end $$;

drop trigger if exists research_inplay_paper_decisions_guard_trg on public.research_inplay_paper_decisions;
create trigger research_inplay_paper_decisions_guard_trg
  before update or delete on public.research_inplay_paper_decisions
  for each row execute function public.research_inplay_paper_decisions_guard();

-- Durable cursor. Advanced only after the corresponding decision writes succeeded.
create table if not exists public.research_inplay_paper_checkpoints (
  processor_id text primary key,
  cursor_observed_at timestamptz not null,
  cursor_id uuid not null,
  bootstrapped_at timestamptz not null,
  bootstrap_cursor_observed_at timestamptz not null,
  last_batch_rows integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.research_inplay_paper_decisions enable row level security;
alter table public.research_inplay_paper_checkpoints enable row level security;
revoke all on public.research_inplay_paper_decisions from anon, authenticated;
revoke all on public.research_inplay_paper_checkpoints from anon, authenticated;
-- Least privilege: no DELETE anywhere; decisions are insert + guarded update only.
grant select, insert, update on public.research_inplay_paper_decisions to service_role;
grant select, insert, update on public.research_inplay_paper_checkpoints to service_role;
