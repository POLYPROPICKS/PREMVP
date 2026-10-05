-- LEDGER_ALIGNMENT: restored verbatim from production migration-ledger entry 20260925133349 (contract_a_rejection_evidence), already applied.
create table if not exists public.contract_a_rejection_evidence (
  rejection_key text primary key,
  rejection_evidence_version text not null,
  plan_run_id text not null,
  decision_at timestamptz not null,
  decision_version text, contract_a_version text, stage text, reason_code text, reason_detail text,
  identity_level text not null check (identity_level in ('EXACT_CANDIDATE','PARTIAL_CANDIDATE','SOURCE_CANDIDATE','PHYSICAL_EVENT','UNKNOWN')),
  physical_event_id text, observation_id text, generated_signal_pair_id text, provider_event_id text,
  provider_event_start_iso text, producer_source text, source_created_at text,
  condition_id text, selected_token_id text, side text,
  constraint contract_a_rejection_evidence_identity_level_guard check (identity_level in ('PHYSICAL_EVENT','UNKNOWN') or (condition_id is not null and selected_token_id is not null)),
  constraint contract_a_rejection_evidence_exact_identity_guard check (identity_level <> 'EXACT_CANDIDATE' or (condition_id is not null and selected_token_id is not null and side is not null)),
  constraint contract_a_rejection_evidence_partial_side_guard check (identity_level <> 'PARTIAL_CANDIDATE' or (condition_id is not null and selected_token_id is not null and side is null))
);
create index if not exists contract_a_rejection_evidence_decision_at_idx on public.contract_a_rejection_evidence (decision_at desc);
create index if not exists contract_a_rejection_evidence_identity_idx on public.contract_a_rejection_evidence (condition_id,selected_token_id);
create index if not exists contract_a_rejection_evidence_plan_run_idx on public.contract_a_rejection_evidence (plan_run_id);
alter table public.contract_a_rejection_evidence enable row level security;
