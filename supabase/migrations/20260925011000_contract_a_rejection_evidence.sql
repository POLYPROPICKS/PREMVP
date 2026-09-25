-- PREMVP_APPLICATION_MIGRATION_V1
-- DATA_CAPTURE_V2_REJECTION_EVIDENCE_V1 — telemetry only, REJECTED rows only.
-- MANUAL APPLICATION REQUIRED — repo has no CI/deploy migration runner.
-- NOT APPLIED by this commit. Apply via Supabase SQL editor or
-- `supabase db push` only after founder review.
--
-- ONE compact normalized production relation for durable Contract A rejection
-- evidence. One durable row = one Contract A rejection decision (a complete
-- ContractARejectionTrace). Idempotent across retries of the same planning run
-- via rejection_key. Scalar columns only: no raw provider payloads, no JSON
-- blobs, no orderbook data, no large arrays.
--
-- Explicitly NOT part of this relation:
--   SELECTED  — authoritative carrier is night_event_reservations.diagnostics.
--   NOT_EVALUATED — derived; never persisted as rows.
--   job_runs.diagnostics — keeps its documented identity-free aggregate contract.
--
-- Does NOT touch any live-money table, Reservation, Queue or Ireland behavior.

create table if not exists public.contract_a_rejection_evidence (
  rejection_key text primary key,
  rejection_evidence_version text not null,
  plan_run_id text not null,
  decision_at timestamptz not null,
  decision_version text,
  contract_a_version text,
  stage text,
  reason_code text,
  reason_detail text,
  identity_level text not null check (identity_level in ('EXACT_CANDIDATE', 'SOURCE_CANDIDATE', 'PHYSICAL_EVENT', 'UNKNOWN')),
  physical_event_id text,
  observation_id text,
  generated_signal_pair_id text,
  provider_event_id text,
  provider_event_start_iso text,
  producer_source text,
  source_created_at text,
  condition_id text,
  selected_token_id text,
  side text,
  constraint contract_a_rejection_evidence_identity_level_guard
    check (
      identity_level in ('PHYSICAL_EVENT', 'UNKNOWN')
      or (condition_id is not null and selected_token_id is not null)
    )
);

create index if not exists contract_a_rejection_evidence_decision_at_idx
  on public.contract_a_rejection_evidence (decision_at desc);

create index if not exists contract_a_rejection_evidence_identity_idx
  on public.contract_a_rejection_evidence (condition_id, selected_token_id);

create index if not exists contract_a_rejection_evidence_plan_run_idx
  on public.contract_a_rejection_evidence (plan_run_id);

alter table public.contract_a_rejection_evidence enable row level security;
revoke all on public.contract_a_rejection_evidence from anon, authenticated;
grant select, insert on public.contract_a_rejection_evidence to service_role;

comment on table public.contract_a_rejection_evidence IS
  'Telemetry-only Contract A rejection evidence (DATA_CAPTURE_V2): one compact scalar row per completed ContractARejectionTrace per planning run, idempotent on rejection_key. SELECTED evidence lives in night_event_reservations.diagnostics; NOT_EVALUATED is a derivation, never persisted. Never read by Planning/Reservation/Rebalance/Queue; never a money authority.';
