CREATE TABLE public.reservation_market_capture_runs (
  id uuid PRIMARY KEY,
  reservation_id uuid NOT NULL REFERENCES public.night_event_reservations(id),
  plan_run_id text NOT NULL,
  physical_event_id text NOT NULL,
  provider_event_id text,
  event_start_iso timestamptz NOT NULL,
  observation_phase text NOT NULL CHECK (observation_phase = 'RESERVATION_BASELINE'),
  observed_at timestamptz NOT NULL,
  minutes_to_start numeric NOT NULL,
  source_version text NOT NULL,
  source_observed_at timestamptz,
  markets_discovered_n integer NOT NULL,
  market_tokens_expected_n integer NOT NULL,
  market_tokens_observed_n integer NOT NULL,
  orderbooks_success_n integer NOT NULL,
  orderbooks_failed_n integer NOT NULL,
  capture_complete boolean NOT NULL,
  capture_status text NOT NULL,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, observation_phase, source_version)
);
CREATE INDEX reservation_market_capture_runs_watermark_idx ON public.reservation_market_capture_runs (observed_at, id);
CREATE INDEX reservation_market_capture_runs_reservation_idx ON public.reservation_market_capture_runs (reservation_id, observed_at);
ALTER TABLE public.reservation_market_capture_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.reservation_market_observations (
  id uuid PRIMARY KEY,
  capture_run_id uuid NOT NULL REFERENCES public.reservation_market_capture_runs(id),
  reservation_id uuid NOT NULL REFERENCES public.night_event_reservations(id),
  physical_event_id text NOT NULL,
  provider_event_id text,
  event_start_iso timestamptz NOT NULL,
  observation_phase text NOT NULL CHECK (observation_phase = 'RESERVATION_BASELINE'),
  observed_at timestamptz NOT NULL,
  minutes_to_start numeric NOT NULL,
  condition_id text NOT NULL,
  token_id text NOT NULL,
  side text NOT NULL,
  outcome text,
  canonical_market_family text,
  canonical_market_type text,
  provider_market_type_raw text,
  market_slug text,
  live_policy_eligibility boolean,
  live_policy_rejection_reason text,
  best_bid numeric,
  best_ask numeric,
  mid_price numeric,
  bid_decimal_odds numeric,
  ask_decimal_odds numeric,
  spread_abs numeric,
  spread_bps numeric,
  bid_depth_relevant_usd numeric,
  ask_depth_relevant_usd numeric,
  tick_size numeric,
  minimum_order_size numeric,
  orderbook_fetch_latency_ms integer,
  orderbook_fetch_status text NOT NULL,
  orderbook_failure_reason text,
  source_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_run_id, condition_id, token_id, side)
);
CREATE INDEX reservation_market_observations_watermark_idx ON public.reservation_market_observations (observed_at, id);
CREATE INDEX reservation_market_observations_reservation_idx ON public.reservation_market_observations (reservation_id, observed_at);
ALTER TABLE public.reservation_market_observations ENABLE ROW LEVEL SECURITY;
