-- ============================================================================
-- RPC wrapper for the track-record window read-model refresh.
--
-- Wraps the existing manual REFRESH block from
-- supabase/migrations/20260702_track_record_window_results.sql (STEP 2-8)
-- into a callable function so it can be invoked safely from a scheduled
-- runner via supabase-js `.rpc()`, instead of being run by hand.
--
-- Business logic is copied verbatim from the 20260702 migration's REFRESH
-- section — no selection/dedup/readiness/PnL logic is changed here. The only
-- difference is the outer BEGIN/COMMIT (transaction control, implicit inside
-- a plpgsql function call) is removed, and a JSONB status summary is
-- returned to the caller.
--
-- NOT APPLIED as part of this change — this file only adds the function
-- definition to the migration history. Applying it to any environment is a
-- separate, explicitly founder-approved step.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.refresh_track_record_window_results()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  -- STEP 2 — persist current display rows into shown history (never deletes).
  INSERT INTO public.track_record_shown_signal_history (
    source_row_id, shown_batch_day, shown_at, event_title, market_question,
    selected_outcome, stake_usd, display_score_rank, display_source_model,
    normalized_match_key
  )
  SELECT DISTINCT ON (d.source_row_id)
    d.source_row_id::uuid,
    d.batch_day,
    now(),
    d.event_title,
    d.market_question,
    d.position,
    100,
    d.score_rank,
    d.source_model,
    public.track_record_normalize_match_key(d.event_title)
  FROM public.track_record_display_signals d
  WHERE d.source_row_id IS NOT NULL
  ORDER BY d.source_row_id, d.window_days ASC, d.score_rank ASC
  ON CONFLICT (source_row_id) DO UPDATE SET
    event_title          = EXCLUDED.event_title,
    market_question      = EXCLUDED.market_question,
    selected_outcome     = EXCLUDED.selected_outcome,
    display_score_rank   = EXCLUDED.display_score_rank,
    display_source_model = EXCLUDED.display_source_model,
    normalized_match_key = EXCLUDED.normalized_match_key,
    updated_at           = now();

  -- Read-model rebuild: results are fully derived, safe to replace per window.
  -- Run as its own statement BEFORE the insert (data-modifying CTE order is
  -- unspecified, so purge+insert must not share one statement).
  DELETE FROM public.track_record_window_results WHERE window_days IN (7, 14);

  -- STEPS 3-7 — join actual results, dedup, resolved-only, all resolved rows.
  WITH anchor AS (
    SELECT date_trunc('day', now() AT TIME ZONE 'utc')::date AS anchor_date
  ),
  windows AS (
    SELECT w.window_days, w.min_resolved
    FROM (VALUES (7, 20), (14, 40)) AS w(window_days, min_resolved)
  ),
  -- STEP 1/5 — shown rows per completed-day window (14D superset of 7D by construction).
  shown AS (
    SELECT w.window_days, w.min_resolved, h.*
    FROM windows w
    JOIN anchor a ON true
    JOIN public.track_record_shown_signal_history h
      ON h.shown_batch_day >= a.anchor_date - make_interval(days => w.window_days)
     AND h.shown_batch_day <  a.anchor_date
  ),
  -- STEP 3 — join each shown row to ITS OWN actual result (never projected_*).
  joined AS (
    SELECT
      s.*,
      lower(g.signal_result)                                   AS result_bucket,
      g.resolved_at,
      g.winning_outcome,
      g.entry_price_num,
      g.score                                                  AS generated_score,
      (g.resolved_at IS NOT NULL
         AND lower(g.signal_result) IN ('won', 'lost')
         AND g.entry_price_num > 0)                            AS is_resolved_row
    FROM shown s
    LEFT JOIN public.generated_signal_pairs g ON g.id = s.source_row_id
  ),
  -- STEP 4 — dedup: 1 normalized_match_key = 1 final signal per window.
  deduped AS (
    SELECT DISTINCT ON (window_days, normalized_match_key) *
    FROM joined
    ORDER BY window_days, normalized_match_key,
      display_score_rank ASC NULLS LAST,
      generated_score DESC NULLS LAST,
      shown_at DESC,
      source_row_id
  ),
  -- STEP 6 — resolved-only funnel counts per window.
  counts AS (
    SELECT
      w.window_days,
      w.min_resolved,
      (SELECT count(*) FROM shown s WHERE s.window_days = w.window_days)::int AS raw_shown_rows,
      count(d.*)::int                                                        AS unique_matches,
      count(*) FILTER (WHERE d.is_resolved_row)::int                         AS resolved_unique_rows,
      count(*) FILTER (WHERE NOT coalesce(d.is_resolved_row, false))::int    AS pending_unique_rows
    FROM windows w
    LEFT JOIN deduped d ON d.window_days = w.window_days
    GROUP BY w.window_days, w.min_resolved
  ),
  -- STEP 7 — ALL resolved unique shown rows for ready windows. No synthetic
  -- 6/4 balancing, no dropped wins/losses, no fill from global
  -- generated_signal_pairs — every resolved unique shown row is included.
  final_rows AS (
    SELECT
      d.*,
      row_number() OVER (
        PARTITION BY d.window_days
        ORDER BY
          d.display_score_rank ASC NULLS LAST,
          d.generated_score DESC NULLS LAST,
          d.shown_at DESC,
          d.source_row_id
      ) AS final_rank
    FROM deduped d
    JOIN counts c ON c.window_days = d.window_days
    WHERE d.is_resolved_row
      AND c.resolved_unique_rows >= c.min_resolved
  )
  INSERT INTO public.track_record_window_results (
      window_days, source_row_id, score_rank, match_key, signal_key,
      event_title, market_question, selected_outcome, position, source_model,
      result_source_table, signal_result, display_status, is_resolved,
      resolved_at, winning_outcome, entry_price_num, decimal_odds, stake_usd,
      real_pnl_usd, return_label, metric_formula_version, generated_at,
      shown_batch_day, normalized_match_key, row_hash
    )
    SELECT
      f.window_days,
      f.source_row_id,
      f.final_rank,
      f.normalized_match_key,
      f.normalized_match_key || '|' || coalesce(f.selected_outcome, ''),
      f.event_title,
      f.market_question,
      f.selected_outcome,
      f.selected_outcome,
      'shown-history-all-resolved',
      'generated_signal_pairs',
      f.result_bucket,
      CASE WHEN f.result_bucket = 'won' THEN 'Hit' ELSE 'Miss' END,
      true,
      f.resolved_at,
      f.winning_outcome,
      f.entry_price_num,
      1.0 / f.entry_price_num,
      f.stake_usd,
      CASE WHEN f.result_bucket = 'won'
           THEN f.stake_usd * ((1.0 / f.entry_price_num) - 1)
           ELSE -f.stake_usd END,
      CASE WHEN f.result_bucket = 'won'
           THEN '+$' || round(f.stake_usd * ((1.0 / f.entry_price_num) - 1))::text
           ELSE '-$' || round(f.stake_usd)::text END,
      'realized-flat-stake-v1',
      now(),
      f.shown_batch_day,
      f.normalized_match_key,
      md5(f.window_days::text || '|' || f.source_row_id::text || '|' ||
          f.result_bucket || '|' || f.entry_price_num::text)
    FROM final_rows f;

  -- STEP 8 — summary/status per window (insufficient_history keeps PnL at 0).
  -- Separate statement: it re-derives the funnel counts and aggregates the
  -- just-inserted read-model rows (visible here within the same transaction).
  WITH anchor AS (
    SELECT date_trunc('day', now() AT TIME ZONE 'utc')::date AS anchor_date
  ),
  windows AS (
    SELECT w.window_days, w.min_resolved
    FROM (VALUES (7, 20), (14, 40)) AS w(window_days, min_resolved)
  ),
  shown AS (
    SELECT w.window_days, w.min_resolved, h.*
    FROM windows w
    JOIN anchor a ON true
    JOIN public.track_record_shown_signal_history h
      ON h.shown_batch_day >= a.anchor_date - make_interval(days => w.window_days)
     AND h.shown_batch_day <  a.anchor_date
  ),
  joined AS (
    SELECT
      s.*,
      lower(g.signal_result) AS result_bucket,
      g.score                AS generated_score,
      (g.resolved_at IS NOT NULL
         AND lower(g.signal_result) IN ('won', 'lost')
         AND g.entry_price_num > 0) AS is_resolved_row
    FROM shown s
    LEFT JOIN public.generated_signal_pairs g ON g.id = s.source_row_id
  ),
  deduped AS (
    SELECT DISTINCT ON (window_days, normalized_match_key) *
    FROM joined
    ORDER BY window_days, normalized_match_key,
      display_score_rank ASC NULLS LAST,
      generated_score DESC NULLS LAST,
      shown_at DESC,
      source_row_id
  ),
  -- Funnel/readiness counts only (raw_shown_rows, unique_matches,
  -- resolved_unique_rows, pending_unique_rows, is_ready). No win/loss target
  -- sizing here — wins/losses/net_pnl below are aggregated straight from the
  -- already-inserted track_record_window_results rows (see the LEFT JOIN),
  -- never recomputed from strict buckets.
  summary_counts AS (
    SELECT
      w.window_days,
      (SELECT count(*) FROM shown s WHERE s.window_days = w.window_days)::int AS raw_shown_rows,
      count(d.*)::int                                                        AS unique_matches,
      count(*) FILTER (WHERE d.is_resolved_row)::int                         AS resolved_unique_rows,
      count(*) FILTER (WHERE NOT coalesce(d.is_resolved_row, false))::int    AS pending_unique_rows,
      (count(*) FILTER (WHERE d.is_resolved_row) >= w.min_resolved)          AS is_ready
    FROM windows w
    LEFT JOIN deduped d ON d.window_days = w.window_days
    GROUP BY w.window_days, w.min_resolved
  )
  INSERT INTO public.track_record_window_summary (
    window_days, status, raw_shown_rows, unique_matches, resolved_unique_rows,
    pending_unique_rows, wins_count, losses_count, net_pnl_usd, net_return_pct,
    generated_at
  )
  SELECT
    t.window_days,
    CASE WHEN t.is_ready THEN 'ready' ELSE 'insufficient_history' END,
    t.raw_shown_rows,
    t.unique_matches,
    t.resolved_unique_rows,
    t.pending_unique_rows,
    CASE WHEN t.is_ready THEN coalesce(i.wins, 0) ELSE 0 END,
    CASE WHEN t.is_ready THEN coalesce(i.losses, 0) ELSE 0 END,
    CASE WHEN t.is_ready THEN coalesce(i.net_pnl, 0) ELSE 0 END,
    CASE WHEN t.is_ready AND coalesce(i.rows_count, 0) > 0
         THEN round(coalesce(i.net_pnl, 0) / (i.rows_count * 100) * 100, 2)
         ELSE 0 END,
    now()
  FROM summary_counts t
  LEFT JOIN (
    SELECT window_days,
      count(*)::int AS rows_count,
      count(*) FILTER (WHERE display_status = 'Hit')::int  AS wins,
      count(*) FILTER (WHERE display_status = 'Miss')::int AS losses,
      sum(real_pnl_usd) AS net_pnl
    FROM public.track_record_window_results
    WHERE window_days IN (7, 14)
    GROUP BY window_days
  ) i ON i.window_days = t.window_days
  ON CONFLICT (window_days) DO UPDATE SET
    status               = EXCLUDED.status,
    raw_shown_rows       = EXCLUDED.raw_shown_rows,
    unique_matches       = EXCLUDED.unique_matches,
    resolved_unique_rows = EXCLUDED.resolved_unique_rows,
    pending_unique_rows  = EXCLUDED.pending_unique_rows,
    wins_count           = EXCLUDED.wins_count,
    losses_count         = EXCLUDED.losses_count,
    net_pnl_usd          = EXCLUDED.net_pnl_usd,
    net_return_pct       = EXCLUDED.net_return_pct,
    generated_at         = EXCLUDED.generated_at;

  SELECT jsonb_build_object(
    'status', 'ok',
    'refreshed_at', now(),
    'windows_refreshed', jsonb_agg(DISTINCT s.window_days ORDER BY s.window_days),
    'summary_rows', (
      SELECT jsonb_agg(to_jsonb(s2) ORDER BY s2.window_days)
      FROM public.track_record_window_summary s2
      WHERE s2.window_days IN (7, 14)
    )
  )
  INTO result
  FROM public.track_record_window_summary s
  WHERE s.window_days IN (7, 14);

  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.refresh_track_record_window_results() IS
  'Callable wrapper for the track-record window read-model refresh (see '
  '20260702_track_record_window_results.sql REFRESH block, STEP 2-8). '
  'Business logic is unchanged — only exposed as an RPC-callable function '
  'so a scheduled runner can invoke it via supabase-js `.rpc()` instead of '
  'requiring a manual SQL console run. Returns a JSONB status summary.';

-- Least-privilege: only the server-side service role may execute this.
REVOKE ALL ON FUNCTION public.refresh_track_record_window_results() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_track_record_window_results() TO service_role;

COMMIT;
