-- LIQUIDITY_POOL_MVP — read-only Polymarket liquidity/microstructure contour.
--
-- Scope: a SEPARATE monitoring contour that proves whether selected
-- PolyProPicks markets have executable pre-match price/liquidity alpha.
-- No trading, no order placement, no execution coupling. Source rows come from
-- public.generated_signal_research_snapshots (fallback generated_signal_pairs).
--
-- Idempotent — safe to run multiple times. Only NEW liquidity tables/indexes.
-- No destructive ALTER/DROP. No changes to existing tables.
-- Service-role only access (matches generated_signal_research_snapshots, which
-- has no public RLS policy); these tables are written exclusively by the
-- liquidity scripts using the service role key.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. market_tracking_watchlist
--    Gated tokens that passed sport + market-family + market-level volume gate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_tracking_watchlist (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

  source_table                    TEXT NOT NULL DEFAULT 'generated_signal_research_snapshots',
  source_row_id                   TEXT NULL,
  source_snapshot_id              TEXT NULL,
  source_formula_version          TEXT NULL,
  source_metric_formula_version   TEXT NULL,
  source_scope                    TEXT NULL,

  condition_id                    TEXT NOT NULL,
  token_id                        TEXT NOT NULL,
  opposing_token_id               TEXT NULL,

  event_slug                      TEXT NULL,
  event_title                     TEXT NULL,
  market_slug                     TEXT NULL,
  market_title                    TEXT NULL,
  selected_outcome                TEXT NULL,

  source_sport                    TEXT NULL,
  normalized_sport                TEXT NOT NULL,
  sport_source                    TEXT NULL,
  sport_confidence                NUMERIC NULL,

  source_market_family            TEXT NULL,
  normalized_market_family        TEXT NOT NULL,
  market_family_source            TEXT NULL,
  market_family_confidence        NUMERIC NULL,

  market_family_gate_status       TEXT NOT NULL DEFAULT 'unknown',
  market_family_gate_reason       TEXT NULL,
  is_supported_p0_market_family   BOOLEAN NOT NULL DEFAULT FALSE,
  is_outright_or_future           BOOLEAN NOT NULL DEFAULT FALSE,
  is_prop_market                  BOOLEAN NOT NULL DEFAULT FALSE,

  league                          TEXT NULL,
  match_family_key                TEXT NULL,
  game_start_iso                  TIMESTAMPTZ NULL,

  market_volume_usd               NUMERIC NULL,
  market_volume_source            TEXT NULL,
  market_volume_checked_at        TIMESTAMPTZ NULL,
  market_volume_freshness_seconds INTEGER NULL,

  volume_gate_status              TEXT NOT NULL DEFAULT 'unknown',
  volume_gate_threshold_usd       NUMERIC NOT NULL DEFAULT 10000,
  minutes_to_start_at_volume_check NUMERIC NULL,
  volume_gate_reason              TEXT NULL,

  first_seen_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  minutes_to_start_at_insert      NUMERIC NULL,

  tracking_priority               INTEGER NOT NULL DEFAULT 100,
  tracking_status                 TEXT NOT NULL DEFAULT 'active',
  reason                          TEXT NULL,
  diagnostics                     JSONB NOT NULL DEFAULT '{}'::JSONB
);

-- Dedupe / upsert key. A Polymarket token_id is unique to one outcome of one
-- condition (and thus one game_start), so (condition_id, token_id) is the
-- natural upsert target and is referenceable by PostgREST onConflict.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mtw_condition_token
  ON public.market_tracking_watchlist (condition_id, token_id);

CREATE INDEX IF NOT EXISTS idx_mtw_token_seen
  ON public.market_tracking_watchlist (token_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_mtw_condition_seen
  ON public.market_tracking_watchlist (condition_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_mtw_sport
  ON public.market_tracking_watchlist (normalized_sport);
CREATE INDEX IF NOT EXISTS idx_mtw_market_family
  ON public.market_tracking_watchlist (normalized_market_family);
CREATE INDEX IF NOT EXISTS idx_mtw_volume_gate
  ON public.market_tracking_watchlist (volume_gate_status);
CREATE INDEX IF NOT EXISTS idx_mtw_market_family_gate
  ON public.market_tracking_watchlist (market_family_gate_status);
CREATE INDEX IF NOT EXISTS idx_mtw_tracking_status
  ON public.market_tracking_watchlist (tracking_status, tracking_priority DESC);
CREATE INDEX IF NOT EXISTS idx_mtw_status_start
  ON public.market_tracking_watchlist (tracking_status, game_start_iso);

-- ---------------------------------------------------------------------------
-- 2. market_price_liquidity_snapshots
--    Append-only orderbook/microstructure snapshots for gated tokens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_price_liquidity_snapshots (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  inserted_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  watchlist_id                UUID NULL REFERENCES public.market_tracking_watchlist (id) ON DELETE SET NULL,
  source                      TEXT NOT NULL DEFAULT 'polymarket',
  snapshot_reason             TEXT NOT NULL DEFAULT 'scheduled',
  snapshot_status             TEXT NOT NULL DEFAULT 'ok',

  condition_id                TEXT NOT NULL,
  token_id                    TEXT NOT NULL,
  opposing_token_id           TEXT NULL,

  event_slug                  TEXT NULL,
  event_title                 TEXT NULL,
  market_slug                 TEXT NULL,
  market_title                TEXT NULL,
  selected_outcome            TEXT NULL,

  normalized_sport            TEXT NOT NULL,
  league                      TEXT NULL,
  normalized_market_family    TEXT NOT NULL,
  match_family_key            TEXT NULL,
  game_start_iso              TIMESTAMPTZ NULL,
  minutes_to_start            NUMERIC NULL,
  phase_bucket                TEXT NULL,

  market_volume_usd           NUMERIC NULL,
  volume_gate_status          TEXT NOT NULL DEFAULT 'unknown',
  volume_gate_threshold_usd   NUMERIC NOT NULL DEFAULT 10000,
  market_family_gate_status   TEXT NOT NULL DEFAULT 'unknown',

  best_bid                    NUMERIC NULL,
  best_ask                    NUMERIC NULL,
  mid_price                   NUMERIC NULL,
  last_trade_price            NUMERIC NULL,
  implied_decimal_odds_mid    NUMERIC NULL,
  implied_decimal_odds_bid    NUMERIC NULL,
  implied_decimal_odds_ask    NUMERIC NULL,

  spread_abs                  NUMERIC NULL,
  spread_bps                  NUMERIC NULL,

  bid_depth_total             NUMERIC NULL,
  ask_depth_total             NUMERIC NULL,
  bid_depth_1pct              NUMERIC NULL,
  bid_depth_2pct              NUMERIC NULL,
  bid_depth_5pct              NUMERIC NULL,
  ask_depth_1pct              NUMERIC NULL,
  ask_depth_2pct              NUMERIC NULL,
  ask_depth_5pct              NUMERIC NULL,

  exit_sellable_usd_1pct      NUMERIC NULL,
  exit_sellable_usd_2pct      NUMERIC NULL,
  exit_sellable_usd_5pct      NUMERIC NULL,
  entry_buyable_usd_1pct      NUMERIC NULL,
  entry_buyable_usd_2pct      NUMERIC NULL,
  entry_buyable_usd_5pct      NUMERIC NULL,

  book_levels_json            JSONB NOT NULL DEFAULT '{}'::JSONB,
  raw_book_json               JSONB NULL,
  api_latency_ms              INTEGER NULL,
  failure_reason              TEXT NULL,
  diagnostics                 JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_mpls_token_captured
  ON public.market_price_liquidity_snapshots (token_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_mpls_condition_captured
  ON public.market_price_liquidity_snapshots (condition_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_mpls_sport
  ON public.market_price_liquidity_snapshots (normalized_sport);
CREATE INDEX IF NOT EXISTS idx_mpls_market_family
  ON public.market_price_liquidity_snapshots (normalized_market_family);
CREATE INDEX IF NOT EXISTS idx_mpls_status
  ON public.market_price_liquidity_snapshots (snapshot_status);
CREATE INDEX IF NOT EXISTS idx_mpls_phase_bucket
  ON public.market_price_liquidity_snapshots (phase_bucket);
CREATE INDEX IF NOT EXISTS idx_mpls_watchlist
  ON public.market_price_liquidity_snapshots (watchlist_id);
CREATE INDEX IF NOT EXISTS idx_mpls_game_start
  ON public.market_price_liquidity_snapshots (game_start_iso);
CREATE INDEX IF NOT EXISTS idx_mpls_volume_gate
  ON public.market_price_liquidity_snapshots (volume_gate_status);
CREATE INDEX IF NOT EXISTS idx_mpls_market_family_gate
  ON public.market_price_liquidity_snapshots (market_family_gate_status);

-- ---------------------------------------------------------------------------
-- 3. market_entry_exit_simulations
--    Executable entry/exit round-trip simulations across snapshot phases.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_entry_exit_simulations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  simulation_run_id           TEXT NOT NULL,
  condition_id                TEXT NOT NULL,
  token_id                    TEXT NOT NULL,
  opposing_token_id           TEXT NULL,
  event_slug                  TEXT NULL,
  market_slug                 TEXT NULL,

  normalized_sport            TEXT NOT NULL,
  league                      TEXT NULL,
  normalized_market_family    TEXT NOT NULL,
  match_family_key            TEXT NULL,
  selected_outcome            TEXT NULL,
  game_start_iso              TIMESTAMPTZ NULL,

  entry_snapshot_id           UUID NULL REFERENCES public.market_price_liquidity_snapshots (id) ON DELETE CASCADE,
  exit_snapshot_id            UUID NULL REFERENCES public.market_price_liquidity_snapshots (id) ON DELETE CASCADE,
  entry_captured_at           TIMESTAMPTZ NOT NULL,
  exit_captured_at            TIMESTAMPTZ NOT NULL,
  entry_phase_bucket          TEXT NULL,
  exit_phase_bucket           TEXT NULL,

  entry_best_ask              NUMERIC NULL,
  entry_best_bid              NUMERIC NULL,
  entry_mid_price             NUMERIC NULL,
  exit_best_bid               NUMERIC NULL,
  exit_best_ask               NUMERIC NULL,
  exit_mid_price              NUMERIC NULL,

  stake_usd                   NUMERIC NOT NULL DEFAULT 10,
  gross_return_pct            NUMERIC NULL,
  estimated_slippage_pct      NUMERIC NULL,
  estimated_fee_pct           NUMERIC NOT NULL DEFAULT 0,
  net_return_pct              NUMERIC NULL,
  exit_liquidity_usd          NUMERIC NULL,
  exit_possible_boolean       BOOLEAN NOT NULL DEFAULT FALSE,
  executable_5pct_boolean     BOOLEAN NOT NULL DEFAULT FALSE,
  executable_10pct_boolean    BOOLEAN NOT NULL DEFAULT FALSE,
  executable_15pct_boolean    BOOLEAN NOT NULL DEFAULT FALSE,

  entry_market_volume_usd     NUMERIC NULL,
  exit_market_volume_usd      NUMERIC NULL,
  volume_gate_threshold_usd   NUMERIC NOT NULL DEFAULT 10000,
  market_family_gate_status   TEXT NULL,

  exit_reason                 TEXT NULL,
  model_version               TEXT NOT NULL DEFAULT 'liquidity_pool_mvp_v1',
  source_formula_version      TEXT NULL,
  source_score                NUMERIC NULL,
  source_tier                 TEXT NULL,
  diagnostics                 JSONB NOT NULL DEFAULT '{}'::JSONB
);

-- Dedupe: one row per (run, entry snapshot, exit snapshot) when both ids exist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mees_run_entry_exit
  ON public.market_entry_exit_simulations (simulation_run_id, entry_snapshot_id, exit_snapshot_id)
  WHERE entry_snapshot_id IS NOT NULL AND exit_snapshot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mees_token_run
  ON public.market_entry_exit_simulations (token_id, simulation_run_id);
CREATE INDEX IF NOT EXISTS idx_mees_token_created
  ON public.market_entry_exit_simulations (token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mees_net_return
  ON public.market_entry_exit_simulations (net_return_pct DESC);
CREATE INDEX IF NOT EXISTS idx_mees_phases
  ON public.market_entry_exit_simulations (entry_phase_bucket, exit_phase_bucket);
CREATE INDEX IF NOT EXISTS idx_mees_sport
  ON public.market_entry_exit_simulations (normalized_sport);
CREATE INDEX IF NOT EXISTS idx_mees_market_family
  ON public.market_entry_exit_simulations (normalized_market_family);
CREATE INDEX IF NOT EXISTS idx_mees_exec5
  ON public.market_entry_exit_simulations (executable_5pct_boolean);
CREATE INDEX IF NOT EXISTS idx_mees_exec10
  ON public.market_entry_exit_simulations (executable_10pct_boolean);
CREATE INDEX IF NOT EXISTS idx_mees_exec15
  ON public.market_entry_exit_simulations (executable_15pct_boolean);
CREATE INDEX IF NOT EXISTS idx_mees_run
  ON public.market_entry_exit_simulations (simulation_run_id);
