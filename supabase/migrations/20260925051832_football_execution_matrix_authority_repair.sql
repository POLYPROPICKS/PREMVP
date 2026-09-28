-- Research-clone-only repair for PR #398. The pre-review 12 rows are identified
-- by this materializer's two exact source tags and absent version marker.
do $$
begin
  if (select count(*) from research.football_execution_matrix_s1s2s3_evidence
      where diagnostics->>'materializer_version' is null
        and diagnostics->>'source' in ('generated_signal_pairs','market_price_liquidity_snapshots')) <> 12 then
    raise exception 'Expected exactly 12 pre-review execution-matrix rows';
  end if;
end $$;

delete from research.football_execution_matrix_s1s2s3_evidence
where diagnostics->>'materializer_version' is null
  and diagnostics->>'source' in ('generated_signal_pairs','market_price_liquidity_snapshots');

alter table research.football_execution_matrix_s1s2s3_evidence
  drop constraint football_execution_matrix_s1s2s3_evidence_logical_identity_key;
alter table research.football_execution_matrix_s1s2s3_evidence
  add constraint football_execution_matrix_s1s2s3_evidence_logical_identity_key
  unique (condition_id, selected_token_id, provider_event_id, formula_version,
          decision_time, strategy, recorded_window_start);
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
  on conflict (condition_id, selected_token_id, provider_event_id, formula_version, decision_time, strategy, recorded_window_start)
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
