-- Bounded correction on top of the PR #398 schema
-- (20260924120000_football_execution_matrix_s1s2s3_research_evidence.sql).
--
-- Why this migration exists:
-- The research-clone project (nppznoujvnyjargjkmnv) only exposes the
-- `public` and `graphql_public` schemas via PostgREST (confirmed via
-- `GET /rest/v1/` and an `Accept-Profile: research` probe returning
-- PGRST106 "Invalid schema: research"). The materializer that runs in a
-- Claude Code Cloud session only holds a REST/service-role credential for
-- this clone (no direct Postgres/psql connection, no Supabase-management
-- DDL access) — the same constraint that required Architect to apply the
-- PR #398 DDL by hand. That means a session-run materializer cannot INSERT
-- into `research.football_execution_matrix_s1s2s3_evidence` directly: the
-- table exists, but is unreachable through the only write path this
-- session has.
--
-- Fix: a SECURITY DEFINER function in `public` (auto-exposed by PostgREST
-- as every other function in this repo's migrations already is, e.g.
-- 20260704_track_record_window_refresh_rpc.sql) that performs the
-- INSERT ... ON CONFLICT DO NOTHING into the research-schema table on the
-- caller's behalf. No new table, no schema exposure change, no relaxation
-- of RLS/grants beyond EXECUTE on this one function.
--
-- Idempotency: the underlying table had no uniqueness constraint on the
-- logical observation identity (candidate identity + strategy + the
-- specific S1/S2/S3 observation window). This migration adds the smallest
-- constraint that makes rerunning the materializer for the same source
-- rows a no-op: one row per (condition_id, selected_token_id,
-- formula_version, decision_time, strategy, recorded_window_start).
-- `recorded_window_start` is the earliest observation_time fed into that
-- evaluation (NULL-safe via a fixed sentinel for S1, which has no
-- observation window) so re-materializing the exact same source slice
-- collapses to the same row instead of duplicating it.

alter table research.football_execution_matrix_s1s2s3_evidence
  add column if not exists recorded_window_start timestamptz not null default 'epoch'::timestamptz;

alter table research.football_execution_matrix_s1s2s3_evidence
  add constraint football_execution_matrix_s1s2s3_evidence_logical_identity_key
  unique (condition_id, selected_token_id, formula_version, decision_time, strategy, recorded_window_start);

create or replace function public.record_football_execution_matrix_s1s2s3_evidence(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = research, public
as $$
declare
  v_id uuid;
begin
  insert into research.football_execution_matrix_s1s2s3_evidence (
    condition_id, selected_token_id, provider_event_id, formula_version, decision_time,
    strategy,
    model_fair_decimal_odds, available_decimal_odds, target_decimal_odds, ladder_decimal_odds,
    min_acceptable_decimal_odds, actual_fill_decimal_odds, closing_decimal_odds,
    spread, depth, take_decision,
    target_reachable, best_observed_acceptable_decimal_odds, ladder_levels,
    status, fill_evidence_source,
    observation_times, recorded_window_start,
    diagnostics
  )
  values (
    payload->>'condition_id',
    payload->>'selected_token_id',
    payload->>'provider_event_id',
    payload->>'formula_version',
    (payload->>'decision_time')::timestamptz,
    payload->>'strategy',
    nullif(payload->>'model_fair_decimal_odds', '')::numeric,
    nullif(payload->>'available_decimal_odds', '')::numeric,
    nullif(payload->>'target_decimal_odds', '')::numeric,
    (select array_agg(x::numeric) from jsonb_array_elements_text(coalesce(payload->'ladder_decimal_odds', '[]'::jsonb)) x),
    nullif(payload->>'min_acceptable_decimal_odds', '')::numeric,
    nullif(payload->>'actual_fill_decimal_odds', '')::numeric,
    nullif(payload->>'closing_decimal_odds', '')::numeric,
    nullif(payload->>'spread', '')::numeric,
    nullif(payload->>'depth', '')::numeric,
    payload->>'take_decision',
    (payload->>'target_reachable')::boolean,
    nullif(payload->>'best_observed_acceptable_decimal_odds', '')::numeric,
    payload->'ladder_levels',
    payload->>'status',
    payload->>'fill_evidence_source',
    (select array_agg(x::timestamptz) from jsonb_array_elements_text(coalesce(payload->'observation_times', '[]'::jsonb)) x),
    coalesce((payload->>'recorded_window_start')::timestamptz, 'epoch'::timestamptz),
    coalesce(payload->'diagnostics', '{}'::jsonb)
  )
  on conflict (condition_id, selected_token_id, formula_version, decision_time, strategy, recorded_window_start)
  do update set
    -- Rerunning the materializer against a growing observation window may
    -- legitimately widen the evidence for the SAME logical identity (e.g.
    -- a later run observes one more price tick within the same window
    -- start). Re-evaluated fields are refreshed; recorded_at advances so
    -- the row's freshness is visible.
    model_fair_decimal_odds = excluded.model_fair_decimal_odds,
    available_decimal_odds = excluded.available_decimal_odds,
    target_decimal_odds = excluded.target_decimal_odds,
    ladder_decimal_odds = excluded.ladder_decimal_odds,
    min_acceptable_decimal_odds = excluded.min_acceptable_decimal_odds,
    actual_fill_decimal_odds = excluded.actual_fill_decimal_odds,
    closing_decimal_odds = excluded.closing_decimal_odds,
    spread = excluded.spread,
    depth = excluded.depth,
    take_decision = excluded.take_decision,
    target_reachable = excluded.target_reachable,
    best_observed_acceptable_decimal_odds = excluded.best_observed_acceptable_decimal_odds,
    ladder_levels = excluded.ladder_levels,
    status = excluded.status,
    fill_evidence_source = excluded.fill_evidence_source,
    observation_times = excluded.observation_times,
    diagnostics = excluded.diagnostics,
    recorded_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_football_execution_matrix_s1s2s3_evidence is
  'Bridge: lets a REST/service-role-only caller (e.g. the football S1/S2/S3 materializer) write into research.football_execution_matrix_s1s2s3_evidence, which PostgREST does not expose directly on this project. Upserts on the logical observation identity for idempotent reruns.';

grant execute on function public.record_football_execution_matrix_s1s2s3_evidence(jsonb) to service_role;
