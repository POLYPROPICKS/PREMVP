-- pg-delta: transaction=false

-- PR #478 / PRECONTRACT_TOP100_MULTISPORT_T20_RESEARCH_V1: access path for the daily
-- event-universe RPC (game_start_iso range scan). Index only; no business semantics.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gsrs_game_start_iso
  ON public.generated_signal_research_snapshots (game_start_iso)
  WHERE game_start_iso IS NOT NULL;
