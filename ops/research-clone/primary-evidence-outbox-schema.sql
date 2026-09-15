-- RESEARCH CLONE ONLY. Never apply through the production migration lifecycle.
-- Target project ref: nppznoujvnyjargjkmnv.
--
-- Mirrors public.primary_evidence_outbox from production migration
-- supabase/migrations/20260908120000_make_current_money_state_gsp_independent.sql
-- (row-count ceiling widened by 20260912061000_primary_evidence_1524_row_ceiling.sql).
-- This is the current authoritative production evidence source: money
-- publication now writes here independently of generated_signal_pairs
-- (lib/feed/persistPrimarySignalPopulation.ts gspWriteStatus
-- DEFERRED_TO_PRIMARY_EVIDENCE_OUTBOX). The clone table is a durable raw sync
-- target only -- no publish_primary_signal_observation RPC, no serving
-- projection, no FK to any clone-side current_signal_pair_serving table.
create table if not exists public.primary_evidence_outbox (
  observation_id uuid primary key,
  observed_at timestamptz not null,
  evidence_rows jsonb not null,
  evidence_row_count integer not null,
  persisted_at timestamptz not null default now(),
  check (jsonb_typeof(evidence_rows) = 'array'),
  check (evidence_row_count between 1 and 1524),
  check (jsonb_array_length(evidence_rows) = evidence_row_count)
);

create index if not exists idx_primary_evidence_outbox_observed
  on public.primary_evidence_outbox (observed_at, observation_id);

alter table public.primary_evidence_outbox enable row level security;
revoke all on public.primary_evidence_outbox from anon, authenticated;
