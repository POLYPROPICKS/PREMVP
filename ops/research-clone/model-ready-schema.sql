-- RESEARCH CLONE ONLY. Never apply through the production migration lifecycle.
-- Target project ref: nppznoujvnyjargjkmnv.
create table if not exists public.research_model_ready_rows (
  model_date date not null,
  population_id text not null,
  condition_id text not null,
  selected_token_id text not null,
  decision_at timestamptz not null,
  provider_event_id text,
  entry_price_num double precision,
  event_start timestamptz,
  sport_family text,
  settlement_label text not null check (settlement_label in ('WIN','LOSS','VOID','OPEN','NO_MATCH','AMBIGUOUS')),
  source_kind text not null default 'RESEARCH_CLONE' check (source_kind = 'RESEARCH_CLONE'),
  materializer_version text not null,
  canonical_row jsonb not null,
  canonical_row_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key (model_date, population_id, condition_id, selected_token_id, decision_at)
);

create index if not exists research_model_ready_rows_date_idx
  on public.research_model_ready_rows (model_date, population_id, decision_at);

create table if not exists public.research_model_economics (
  as_of_date date not null,
  period_kind text not null check (period_kind in ('DAILY','7D','14D','30D')),
  period_start date not null,
  period_end date not null,
  population_id text not null,
  model_id text not null check (model_id in ('C0','C1','C4','C5')),
  event_n integer not null,
  wins integer not null,
  losses integer not null,
  pnl_u double precision not null,
  roi_pct double precision not null,
  max_drawdown_u double precision not null,
  model_version text not null,
  source_kind text not null default 'RESEARCH_CLONE' check (source_kind = 'RESEARCH_CLONE'),
  computed_at timestamptz not null,
  primary key (as_of_date, period_kind, population_id, model_id)
);

create table if not exists public.research_model_ready_days (
  model_date date primary key,
  status text not null check (status in ('MODEL_READY','DEGRADED_EXCLUDED')),
  row_n integer not null default 0,
  canonical_content_sha256 text,
  source_kind text not null default 'RESEARCH_CLONE' check (source_kind = 'RESEARCH_CLONE'),
  completed_at timestamptz not null
);

alter table public.research_model_ready_rows enable row level security;
alter table public.research_model_economics enable row level security;
alter table public.research_model_ready_days enable row level security;
revoke all on public.research_model_ready_rows from anon, authenticated;
revoke all on public.research_model_economics from anon, authenticated;
revoke all on public.research_model_ready_days from anon, authenticated;
