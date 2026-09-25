-- RESEARCH CLONE ONLY. Never apply through the production migration lifecycle.
-- Target project ref: nppznoujvnyjargjkmnv.
--
-- Narrow research projection of production primary_evidence_outbox, written by
-- scripts/research-clone-daily-sync.ts from the bounded production RPC
-- public.research_evidence_page_v2 (supabase/migrations/20260919080000_research_evidence_page_v2.sql).
-- One row per evidence item; raw evidence_rows JSON is never stored here.
--
-- Idempotent: creates the table when absent and upgrades an existing table
-- additively. Identity/index semantics are unchanged.
create table if not exists public.research_evidence_page_rows (
  observation_id uuid not null,
  observed_at timestamptz not null,
  item_observation_id uuid not null,
  condition_id text,
  selected_token_id text,
  metric_formula_version text,
  entry_price_num numeric,
  signal_confidence_num numeric,
  signal_result text,
  formula_version text,
  pre_event_score_num numeric,
  provider_event_id text,
  provider_sport_code text,
  provider_sport_family text,
  market_family text,
  market_type text,
  game_start_iso text,
  volume_usd numeric,
  ingested_at timestamptz not null default now(),
  source_kind text not null default 'PRODUCTION_RESEARCH_EVIDENCE_PAGE',
  primary key (observation_id, item_observation_id)
);

-- CURRENT-source attributes (additive upgrade of the existing table).
alter table public.research_evidence_page_rows add column if not exists selected_outcome text;
alter table public.research_evidence_page_rows add column if not exists data_coverage numeric;
-- Names the exact source path that supplied volume_usd
-- (parentEventVolume24hr vs legacy volumeUsd); never conflated.
alter table public.research_evidence_page_rows add column if not exists volume_semantic text;
alter table public.research_evidence_page_rows add column if not exists event_title text;
alter table public.research_evidence_page_rows add column if not exists market_question text;
-- DATA_CAPTURE_V2 pre-model market telemetry (diminutive scalars, captured at
-- production enrichment time from the gamma market payload; additively exposed
-- by research_evidence_page_v5).
alter table public.research_evidence_page_rows add column if not exists best_bid_num numeric;
alter table public.research_evidence_page_rows add column if not exists best_ask_num numeric;
alter table public.research_evidence_page_rows add column if not exists market_spread_num numeric;
alter table public.research_evidence_page_rows add column if not exists odds_decimal_num numeric;

create index if not exists research_evidence_page_rows_window_idx
  on public.research_evidence_page_rows (observed_at, observation_id, item_observation_id);

alter table public.research_evidence_page_rows enable row level security;
revoke all on public.research_evidence_page_rows from anon, authenticated;
