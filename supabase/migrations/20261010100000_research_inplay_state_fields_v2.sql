-- INPLAY_STATE_FIELDS_V2: two additive nullable scalars for provider sport state. No backfill, no new index,
-- no change to caps/retention. The row-typed writer RPC picks the new columns up from the table type.
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS state_clock_seconds_elapsed integer;
ALTER TABLE public.research_inplay_core_path_observations ADD COLUMN IF NOT EXISTS state_received_at timestamptz;
COMMENT ON COLUMN public.research_inplay_core_path_observations.state_clock_seconds_elapsed IS
  'Count-up match clock (soccer): provider elapsed minute * 60. NULL when absent, inconsistent with period or stale.';
COMMENT ON COLUMN public.research_inplay_core_path_observations.state_received_at IS
  'Collector receipt time of the provider sports-socket message the state fields came from (provider sends no timestamp).';
COMMENT ON COLUMN public.research_inplay_core_path_observations.side_a_score IS 'Provider score "<home>-<away>": home goals (soccer only; NULL otherwise).';
COMMENT ON COLUMN public.research_inplay_core_path_observations.side_b_score IS 'Provider score "<home>-<away>": away goals (soccer only; NULL otherwise).';
