-- RESEARCH CLONE ONLY. Apply only to Supabase project ref nppznoujvnyjargjkmnv (DBClone).
-- NEVER apply to production (nbnldzfsxffztsfrrxqy). Deliberately NOT under supabase/migrations.
-- INPLAY_PAPER_SETTLEMENT_REPORTS_V1: durable, bounded daily A/B/C paper settlement report summaries.
-- Derived read-only from research_inplay_paper_decisions + research_inplay_core_path_observations and the
-- canonical provider resolver. Never modifies a frozen decision. Idempotent: safe to re-apply.
-- Apply via: node scripts/control-plane/apply-premvp-approved-migration.mjs --clone-schema --declaration '{...}'

-- One row per (UTC research day, report version). Re-materialisation UPSERTS this row: OPEN outcomes are revisited
-- on later scheduled runs and the same row converges INCOMPLETE -> PARTIALLY_SETTLED -> FULLY_RESOLVED.
create table if not exists public.research_inplay_paper_settlement_reports (
  utc_day date not null,
  report_version text not null,
  -- INCOMPLETE: decisions still WAITING or nothing settled yet. PARTIALLY_SETTLED: some settled, some OPEN.
  -- FULLY_RESOLVED: no WAITING decision and no OPEN BET. FAILED: no successful report exists yet for the day.
  status text not null check (status in ('INCOMPLETE', 'PARTIALLY_SETTLED', 'FULLY_RESOLVED', 'FAILED')),
  generated_at timestamptz,
  first_generated_at timestamptz,
  source_provenance text not null,
  window_from timestamptz not null,
  window_to timestamptz not null,
  -- decision / independence counts (admission_observed_at inside the half-open UTC day)
  decisions_n integer not null default 0,
  bet_n integer not null default 0,
  skip_n integer not null default 0,
  waiting_n integer not null default 0,
  distinct_games_n integer not null default 0,
  independent_bet_games_n integer not null default 0,
  -- settlement (OPEN excluded from ROI; null while nothing settled — never a fabricated zero)
  settled_n integer not null default 0,
  open_n integer not null default 0,
  win_n integer not null default 0,
  loss_n integer not null default 0,
  void_n integer not null default 0,
  settled_gross_pnl_u numeric,
  settled_roi numeric,
  net_pnl_status text not null default 'UNKNOWN_NO_ACTUAL_FEE_AUTHORITY',
  -- executable LIVE-only full-position SELL diagnostics (descriptive, not realized profit)
  executable_x2_n integer not null default 0,
  executable_x3_n integer not null default 0,
  executable_x5_n integer not null default 0,
  -- bounded summaries (no per-position rows, no credentials)
  summary jsonb not null default '{}'::jsonb,
  missing_authority jsonb not null default '{}'::jsonb,
  -- run diagnostics (the last attempt, successful or not)
  attempts_n integer not null default 0,
  last_attempt_at timestamptz,
  last_attempt_status text check (last_attempt_status is null or last_attempt_status in ('SUCCESS', 'FAILED', 'REGRESSION_REFUSED')),
  last_error text,
  first_broken_edge text,
  created_at timestamptz not null default now(),
  constraint inplay_paper_settlement_reports_pk primary key (utc_day, report_version),
  constraint inplay_paper_settlement_reports_counts check (
    bet_n >= 0 and settled_n >= 0 and open_n >= 0 and settled_n + open_n = bet_n
    and win_n + loss_n + void_n = settled_n),
  constraint inplay_paper_settlement_reports_roi_needs_settled check (settled_n > 0 or (settled_roi is null and settled_gross_pnl_u is null)),
  constraint inplay_paper_settlement_reports_bounded check (
    octet_length(summary::text) <= 262144 and octet_length(missing_authority::text) <= 65536
    and (last_error is null or octet_length(last_error) <= 1000)),
  -- a non-FAILED row always carries a successful generation timestamp
  constraint inplay_paper_settlement_reports_generated check (status = 'FAILED' or generated_at is not null)
);

create index if not exists research_inplay_paper_settlement_reports_open_idx
  on public.research_inplay_paper_settlement_reports (utc_day desc)
  where status <> 'FULLY_RESOLVED';

alter table public.research_inplay_paper_settlement_reports enable row level security;
revoke all on public.research_inplay_paper_settlement_reports from anon, authenticated;
-- Least privilege: no DELETE; reports are insert + update (upsert) only.
grant select, insert, update on public.research_inplay_paper_settlement_reports to service_role;
