-- Weather Model 1 / WM1-2 fixture inventory foundation.
-- Reviewed artifact only: POSTGRES_CONCURRENCY_NOT_PROVEN.
-- Reviewed artifact only: MIGRATION_APPLY_NOT_PROVEN.
-- This migration creates new Weather objects only and must not be applied by this fixture milestone.

BEGIN;

CREATE TABLE public.weather_collector_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_key text NOT NULL,
  run_key text NOT NULL UNIQUE,
  run_kind text NOT NULL CHECK (run_kind IN ('GAMMA_INVENTORY')),
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'STALE', 'SKIPPED_LOCKED')),
  source_contract_id text NOT NULL,
  source_contract_hash text NOT NULL CHECK (char_length(source_contract_hash) = 64),
  source_contract_git_sha text NOT NULL CHECK (source_contract_git_sha ~ '^[0-9a-f]{7,64}$'),
  lease_expires_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);

CREATE UNIQUE INDEX weather_collector_runs_active_lock_key_unique
  ON public.weather_collector_runs (lock_key) WHERE status = 'RUNNING';

CREATE TABLE public.weather_capture_cohorts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weather_collector_run_id uuid NOT NULL REFERENCES public.weather_collector_runs(id) ON DELETE RESTRICT,
  cohort_key text NOT NULL,
  catalog_version text NOT NULL,
  catalog_hash text NOT NULL CHECK (char_length(catalog_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (weather_collector_run_id, cohort_key)
);

CREATE TABLE public.weather_raw_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weather_collector_run_id uuid NOT NULL REFERENCES public.weather_collector_runs(id) ON DELETE RESTRICT,
  source_contract_id text NOT NULL,
  source_contract_hash text NOT NULL CHECK (char_length(source_contract_hash) = 64),
  page_identity text NOT NULL,
  payload_hash text NOT NULL CHECK (char_length(payload_hash) = 64),
  object_path text NOT NULL,
  record_count integer NOT NULL CHECK (record_count >= 0),
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_contract_id, page_identity, payload_hash),
  UNIQUE (object_path)
);

CREATE TABLE public.weather_venue_markets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weather_raw_object_id uuid NOT NULL REFERENCES public.weather_raw_objects(id) ON DELETE RESTRICT,
  source_contract_id text NOT NULL,
  condition_id text NOT NULL,
  venue_event_id text,
  venue_market_id text,
  title text,
  slug text,
  active boolean NOT NULL,
  closed boolean NOT NULL,
  attribution_status text NOT NULL CHECK (attribution_status IN ('ATTRIBUTED_EXACT', 'UNATTRIBUTED', 'AMBIGUOUS', 'REJECTED')),
  attribution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_contract_id, condition_id),
  CHECK (NOT (active AND closed))
);

CREATE INDEX weather_venue_markets_raw_object_idx ON public.weather_venue_markets(weather_raw_object_id);
CREATE INDEX weather_venue_markets_attribution_idx ON public.weather_venue_markets(attribution_status);

CREATE TABLE public.weather_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weather_venue_market_id uuid NOT NULL REFERENCES public.weather_venue_markets(id) ON DELETE RESTRICT,
  weather_raw_object_id uuid NOT NULL REFERENCES public.weather_raw_objects(id) ON DELETE RESTRICT,
  token_id text NOT NULL,
  outcome text NOT NULL,
  outcome_index integer NOT NULL CHECK (outcome_index >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (weather_venue_market_id, token_id),
  UNIQUE (weather_venue_market_id, outcome_index)
);

CREATE INDEX weather_contracts_raw_object_idx ON public.weather_contracts(weather_raw_object_id);

COMMIT;
