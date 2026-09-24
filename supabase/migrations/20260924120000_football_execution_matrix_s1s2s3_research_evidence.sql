-- Research-clone-only evidence table for the football S1/S2/S3 Execution
-- Matrix (taker hold / fixed maker hold / maker value-band hold).
--
-- Scope: PREMVP-DB-CLONE research schema only. Not applied to production.
-- No live-money behavior change; strategies here are shadow evidence
-- capture and MUST NOT require real-order placement to be populated.
--
-- One row per (candidate identity, strategy, recorded_at): S1/S2/S3 all
-- reference the exact same frozen candidate/event/token/decision-time
-- identity via the shared identity columns, so cross-strategy joins on
-- (condition_id, selected_token_id, formula_version, decision_time) always
-- resolve to the same signal.

create schema if not exists research;

create table if not exists research.football_execution_matrix_s1s2s3_evidence (
  id uuid primary key default gen_random_uuid(),

  -- Frozen candidate/signal identity, shared identically across S1/S2/S3.
  condition_id text not null,
  selected_token_id text not null,
  provider_event_id text not null,
  formula_version text not null,
  decision_time timestamptz not null,

  strategy text not null check (
    strategy in ('S1_TAKER_HOLD', 'S2_FIXED_MAKER_HOLD', 'S3_MAKER_VALUE_BAND_HOLD')
  ),

  -- Odds contract: distinct decimal-odds fields, never conflated.
  model_fair_decimal_odds numeric,
  available_decimal_odds numeric,
  target_decimal_odds numeric,
  ladder_decimal_odds numeric[],
  min_acceptable_decimal_odds numeric,
  actual_fill_decimal_odds numeric,
  closing_decimal_odds numeric,

  -- S1-specific
  spread numeric,
  depth numeric,
  take_decision text check (take_decision in ('TAKE', 'NO_TAKE')),

  -- S2/S3-specific
  target_reachable boolean,
  best_observed_acceptable_decimal_odds numeric,
  ladder_levels jsonb,

  -- Shared fill-status semantics. A market-price touch is FILL_OPPORTUNITY,
  -- never ACTUAL_FILL, unless authoritative execution evidence exists.
  status text check (status in ('ACTUAL_FILL', 'FILL_OPPORTUNITY', 'NO_FILL', 'UNKNOWN')),
  fill_evidence_source text check (
    fill_evidence_source in ('executor_order_events', 'bet_execution_ledger', 'manual_review')
  ),

  observation_times timestamptz[],
  recorded_at timestamptz not null default now(),

  diagnostics jsonb not null default '{}'::jsonb,

  constraint football_execution_matrix_s1s2s3_evidence_no_fill_without_source check (
    status is distinct from 'ACTUAL_FILL' or fill_evidence_source is not null
  )
);

create index if not exists football_execution_matrix_s1s2s3_evidence_candidate_idx
  on research.football_execution_matrix_s1s2s3_evidence (
    condition_id, selected_token_id, formula_version, decision_time
  );

create index if not exists football_execution_matrix_s1s2s3_evidence_strategy_idx
  on research.football_execution_matrix_s1s2s3_evidence (strategy, recorded_at);

comment on table research.football_execution_matrix_s1s2s3_evidence is
  'Football Execution Matrix S1/S2/S3 prospective evidence. Research-clone only; not a production table. No ACTUAL_FILL without fill_evidence_source (authoritative execution evidence) — a market-price touch of a target/ladder level records FILL_OPPORTUNITY.';
