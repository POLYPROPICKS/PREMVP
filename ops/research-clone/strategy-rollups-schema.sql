-- RESEARCH CLONE ONLY. Never apply through the production migration lifecycle.
-- Target project ref: nppznoujvnyjargjkmnv.
-- AUTOMATED_D1_MODELING_CONVEYOR_V1: compact analytical storage for the nightly
-- D-1 football strategy conveyor. Additive; no production table is touched.

-- One row per strategy/version + model_date + physical event. Selection is
-- immutable; only settlement_label / pnl_u may be refreshed after selection.
create table if not exists public.research_strategy_selected_bets (
  model_date date not null,
  strategy_id text not null,
  strategy_version text not null,
  physical_event_id text not null,
  candidate_identity text not null,
  condition_id text not null,
  selected_token_id text not null,
  decision_at timestamptz not null,
  entry_price_num double precision not null,
  market_family text not null,
  settlement_label text not null check (settlement_label in ('WIN','LOSS','VOID','OPEN','NO_MATCH','AMBIGUOUS')),
  pnl_u double precision,
  computed_at timestamptz not null,
  primary key (strategy_id, strategy_version, model_date, physical_event_id),
  check ((settlement_label in ('WIN','LOSS')) = (pnl_u is not null))
);

-- Cross-day claim lookup: which strategies already own a physical event.
create index if not exists research_strategy_selected_bets_event_idx
  on public.research_strategy_selected_bets (physical_event_id);

create table if not exists public.research_strategy_daily (
  model_date date not null,
  strategy_id text not null,
  strategy_version text not null,
  selected_n integer not null,
  settled_n integer not null,
  open_n integer not null,
  wins integer not null,
  losses integer not null,
  pnl_u double precision not null,
  roi_pct double precision not null,
  daily_max_dd_u double precision not null,
  selection_digest text not null,
  computed_at timestamptz not null,
  primary key (model_date, strategy_id, strategy_version)
);

create table if not exists public.research_strategy_rollups (
  as_of_date date not null,
  window_kind text not null check (window_kind in ('1D','7D','14D','30D','LIFETIME')),
  strategy_id text not null,
  strategy_version text not null,
  period_start date not null,
  period_end date not null,
  selected_n integer not null,
  settled_n integer not null,
  open_n integer not null,
  wins integer not null,
  losses integer not null,
  pnl_u double precision not null,
  roi_pct double precision not null,
  max_dd_u double precision not null,
  computed_at timestamptz not null,
  primary key (as_of_date, window_kind, strategy_id, strategy_version)
);

alter table public.research_strategy_selected_bets enable row level security;
alter table public.research_strategy_daily enable row level security;
alter table public.research_strategy_rollups enable row level security;
revoke all on public.research_strategy_selected_bets from anon, authenticated;
revoke all on public.research_strategy_daily from anon, authenticated;
revoke all on public.research_strategy_rollups from anon, authenticated;
grant all on public.research_strategy_selected_bets to service_role;
grant all on public.research_strategy_daily to service_role;
grant all on public.research_strategy_rollups to service_role;
