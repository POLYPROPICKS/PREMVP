
create schema if not exists research;
create table research.strategic_jul15_aug27_identity_snapshot (
  source_row_id uuid primary key,
  condition_id text not null,
  selected_token_id text not null,
  selected_outcome text,
  event_slug text,
  created_at timestamptz not null,
  entry_price_num numeric,
  game_start_iso timestamptz,
  provider_event_id text,
  provider_event_slug text,
  provider_event_identity text,
  provider_event_context jsonb,
  sport_family text,
  sport_code text,
  diagnostics jsonb not null,
  signal_result text,
  resolved_at timestamptz,
  winning_outcome text,
  source_formula_version text not null check (source_formula_version = 'shadow-strategic-sports-v1'),
  snapshot_window_start timestamptz not null check (snapshot_window_start = timestamptz '2026-07-15T00:00:00Z'),
  snapshot_window_end timestamptz not null check (snapshot_window_end = timestamptz '2026-08-28T00:00:00Z'),
  selection_rule_version text not null check (selection_rule_version = 'LATEST_OBSERVATION_WITHIN_WINDOW_CREATED_AT_DESC_ID_DESC_V1'),
  constraint strategic_jul15_aug27_identity_snapshot_identity_key unique (condition_id, selected_token_id)
);
comment on table research.strategic_jul15_aug27_identity_snapshot is
  'Immutable after materialization: raw shadow-strategic-sports-v1 history, Jul 15 2026 inclusive to Aug 28 2026 exclusive; membership determined only from raw generated_signal_pairs by condition_id + selected_token_id, latest created_at then id.';
;
