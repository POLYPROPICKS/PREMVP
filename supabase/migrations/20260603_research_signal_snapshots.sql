-- Create bounded forward research snapshot table.
-- Scope: RESEARCH_ELIGIBLE_UNIVERSE
--   sports, binary, European odds 1.25–4.00, before product gates.
-- One row per cron run per (condition_id, selected_token_id).
-- No foreign key to generated_signal_pairs. No resolver columns.
-- Idempotent — safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.generated_signal_research_snapshots (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  snapshot_run_id            UUID NOT NULL,
  snapshot_at                TIMESTAMPTZ NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                 TIMESTAMPTZ NOT NULL,

  scope                      TEXT NOT NULL DEFAULT 'RESEARCH_ELIGIBLE_UNIVERSE',

  formula_version            TEXT NULL,

  condition_id               TEXT NOT NULL,
  selected_token_id          TEXT NOT NULL,
  opposing_token_id          TEXT NOT NULL,

  event_slug                 TEXT NULL,
  selected_outcome           TEXT NULL,

  selected_price_num         NUMERIC NULL,
  selected_european_odds_num NUMERIC NULL,

  market_family              TEXT NULL,
  league                     TEXT NULL,
  game_start_iso             TIMESTAMPTZ NULL,

  data_coverage_num          NUMERIC NULL,
  product_rejection_reasons  JSONB NOT NULL DEFAULT '[]'::JSONB,

  diagnostics                JSONB NOT NULL DEFAULT '{}'::JSONB,

  public_feed_exposed        BOOLEAN NOT NULL DEFAULT FALSE,

  CONSTRAINT chk_gsrs_scope
    CHECK (scope = 'RESEARCH_ELIGIBLE_UNIVERSE'),

  CONSTRAINT chk_gsrs_odds_corridor
    CHECK (
      selected_european_odds_num IS NULL
      OR selected_european_odds_num BETWEEN 1.25 AND 4.00
    ),

  CONSTRAINT uq_gsrs_run_condition_token
    UNIQUE (snapshot_run_id, condition_id, selected_token_id)
);

CREATE INDEX IF NOT EXISTS idx_gsrs_snapshot_at
  ON public.generated_signal_research_snapshots (snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_gsrs_condition_token
  ON public.generated_signal_research_snapshots (condition_id, selected_token_id);

CREATE INDEX IF NOT EXISTS idx_gsrs_exposed_at
  ON public.generated_signal_research_snapshots (public_feed_exposed, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_gsrs_expires_at
  ON public.generated_signal_research_snapshots (expires_at);

-- Enable Row Level Security.
-- No public anon or authenticated policies are added.
-- service_role bypasses RLS by default and retains full write access.
-- This table is never exposed through public API routes or UI.
ALTER TABLE public.generated_signal_research_snapshots
  ENABLE ROW LEVEL SECURITY;
