-- PROD_SHADOW schema baseline layer (repo-owned, SCHEMA ONLY, no rows).
--
-- supabase/migrations starts after these tables already existed in DEV, so an empty database cannot be
-- built from migrations alone. This file creates, minimally and idempotently, exactly the pre-history
-- objects the shadow-reachable path needs, with the columns the current code reads/writes:
--   generated_signal_pairs        producer/resolver write target (GSP)
--   job_runs                      producer/rebalance job evidence
--   contract_a_rejection_evidence Contract A rejection evidence (fail-open writer)
-- Columns were derived from code (buildGeneratedSignalPairRows, resolve-signals, jobRunWriter,
-- ContractARejectionEvidenceRow) and from every later migration that references them.
-- Also creates the Supabase-standard roles/extension that migrations assume, when absent.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.generated_signal_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source text,
  formula_version text,
  metric_formula_version text,
  event_slug text,
  market_slug text,
  condition_id text,
  selected_outcome text,
  selected_token_id text,
  premium_signal jsonb,
  market_source jsonb,
  market_sources jsonb,
  diagnostics jsonb,
  score numeric,
  expires_at timestamptz,
  entry_price_num numeric,
  signal_confidence_num numeric,
  expected_return_pct_num numeric,
  trust_metrics jsonb,
  smart_money_score_num numeric,
  whale_public_score_num numeric,
  pre_event_score_num numeric,
  signal_result text,
  resolved_at timestamptz,
  winning_outcome text,
  realized_return_pct numeric
);

CREATE TABLE IF NOT EXISTS public.job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source text,
  formula_version text,
  started_at timestamptz,
  finished_at timestamptz,
  status text,
  generated_count integer,
  rejected_count integer,
  duration_ms integer,
  error_message text,
  diagnostics jsonb
);

CREATE TABLE IF NOT EXISTS public.contract_a_rejection_evidence (
  rejection_key text PRIMARY KEY,
  rejection_evidence_version text NOT NULL,
  plan_run_id text NOT NULL,
  decision_at timestamptz NOT NULL,
  decision_version text NOT NULL,
  contract_a_version text NOT NULL,
  stage text NOT NULL,
  reason_code text NOT NULL,
  reason_detail text,
  identity_level text NOT NULL,
  physical_event_id text,
  observation_id text,
  generated_signal_pair_id text,
  provider_event_id text,
  provider_event_start_iso text,
  producer_source text,
  source_created_at timestamptz,
  condition_id text,
  selected_token_id text,
  side text
);
