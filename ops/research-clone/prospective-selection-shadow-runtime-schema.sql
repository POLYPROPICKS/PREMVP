-- RESEARCH CLONE ONLY. Apply only to Supabase project ref nppznoujvnyjargjkmnv.
-- This table stores selected-only research shadow state; never apply to production.
create table if not exists public.prospective_selection_shadow_runtime (
  row_key text primary key,
  row_kind text not null check (row_kind in ('LEDGER', 'SNAPSHOT')),
  model_id text,
  decision_date date,
  candidate_identity text,
  physical_event_key text,
  decision_timestamp timestamptz,
  event_start timestamptz,
  entry_price numeric,
  sport_family text,
  condition_id text,
  selected_token_id text,
  pre_event_score numeric,
  data_coverage numeric,
  settlement_state text check (settlement_state is null or settlement_state in ('UNQUERIED', 'WIN', 'LOSS')),
  settlement_checked_at timestamptz,
  settled_at timestamptz,
  result text check (result is null or result in ('WIN', 'LOSS')),
  snapshot_payload jsonb,
  updated_at timestamptz not null default now(),
  check (
    (row_kind = 'SNAPSHOT' and row_key = 'CURRENT' and snapshot_payload is not null)
    or
    (row_kind = 'LEDGER' and row_key <> 'CURRENT' and model_id is not null and decision_date is not null
      and candidate_identity is not null and decision_timestamp is not null
      and entry_price is not null and settlement_state is not null)
  )
);

create index if not exists prospective_selection_shadow_runtime_unqueried_idx
  on public.prospective_selection_shadow_runtime (settlement_checked_at, condition_id)
  where row_kind = 'LEDGER' and settlement_state = 'UNQUERIED';

create index if not exists prospective_selection_shadow_runtime_date_idx
  on public.prospective_selection_shadow_runtime (model_id, decision_date, decision_timestamp)
  where row_kind = 'LEDGER';

alter table public.prospective_selection_shadow_runtime enable row level security;
revoke all on public.prospective_selection_shadow_runtime from public, anon, authenticated;
grant all on public.prospective_selection_shadow_runtime to service_role;

-- The production dashboard reads only the sanitized aggregate snapshot row.
-- Selected ledger identities and provider settlement state remain service-role-only.
grant select (row_key, row_kind, snapshot_payload, updated_at)
  on public.prospective_selection_shadow_runtime to anon;
drop policy if exists prospective_selection_shadow_public_snapshot_read
  on public.prospective_selection_shadow_runtime;
create policy prospective_selection_shadow_public_snapshot_read
  on public.prospective_selection_shadow_runtime
  for select to anon
  using (row_kind = 'SNAPSHOT' and row_key = 'CURRENT');
