create table if not exists public.model_one_per_match_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  run_started_at timestamptz,
  run_completed_at timestamptz,
  corpus_from timestamptz,
  corpus_to timestamptz,
  raw_rows integer,
  resolved_rows integer,
  unique_event_groups integer,
  selected_rows integer,
  baseline_roi numeric,
  baseline_pnl numeric,
  one_per_match_roi numeric,
  one_per_match_pnl numeric,
  baseline_winrate numeric,
  one_per_match_winrate numeric,
  baseline_max_drawdown numeric,
  one_per_match_max_drawdown numeric,
  selection_policy text,
  corpus_hash text,
  status text,
  notes jsonb,
  created_at timestamptz default now()
);

create table if not exists public.model_one_per_match_backtest_picks (
  run_id uuid references public.model_one_per_match_backtest_runs(id),
  event_group_key text,
  selection_rank integer,
  selected boolean,
  signal_id text,
  condition_id text,
  token_id text,
  market_slug text,
  event_slug text,
  event_title text,
  match_family_key text,
  sport text,
  strategic_scope text,
  side text,
  selected_outcome text,
  strategy text,
  tier text,
  score numeric,
  coverage numeric,
  smart_money numeric,
  entry_price numeric,
  max_entry_price numeric,
  stake_usd numeric,
  created_at timestamptz,
  resolved_at timestamptz,
  outcome_status text,
  won boolean,
  pnl numeric,
  roi numeric,
  selection_reason text,
  rejected_same_event_count integer,
  raw jsonb
);

create index if not exists model_one_per_match_backtest_picks_run_id_idx
  on public.model_one_per_match_backtest_picks(run_id);

create index if not exists model_one_per_match_backtest_picks_event_group_idx
  on public.model_one_per_match_backtest_picks(event_group_key);
