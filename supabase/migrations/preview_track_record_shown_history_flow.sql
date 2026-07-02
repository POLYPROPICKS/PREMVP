-- ============================================================================
-- PREVIEW (read-only) — shown-history track-record funnel audit.
-- Run in Supabase SQL Editor AFTER the 20260702 migration's history upsert.
-- Outputs compact readable rows (no huge JSON). Sections:
--   01_SUMMARY / 02_DATES / 03_DUPLICATES_TOP / 04_TOP_ROWS
-- Sources: track_record_shown_signal_history JOIN generated_signal_pairs by
-- source_row_id. Never global resolved rows, never projected_* fields.
-- ============================================================================

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
    g.resolved_at,
    g.winning_outcome,
    g.entry_price_num,
    g.score AS generated_score,
    (g.resolved_at IS NOT NULL
       AND lower(g.signal_result) IN ('won', 'lost')
       AND g.entry_price_num > 0) AS is_resolved_row,
    CASE
      WHEN g.id IS NULL THEN 'no_generated_row'
      WHEN g.resolved_at IS NULL THEN 'pending'
      WHEN lower(g.signal_result) NOT IN ('won', 'lost') THEN 'non_binary_result'
      WHEN NOT (g.entry_price_num > 0) THEN 'bad_entry_price'
      ELSE 'ok'
    END AS audit_flag
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
pnl AS (
  SELECT d.*,
    CASE
      WHEN d.is_resolved_row AND d.result_bucket = 'won'
        THEN round(d.stake_usd * ((1.0 / d.entry_price_num) - 1), 2)
      WHEN d.is_resolved_row AND d.result_bucket = 'lost'
        THEN -d.stake_usd
      ELSE NULL
    END AS real_pnl_usd
  FROM deduped d
)

-- 01_SUMMARY ------------------------------------------------------------------
SELECT
  '01_SUMMARY' AS section,
  w.window_days,
  (SELECT count(*) FROM shown s WHERE s.window_days = w.window_days) AS raw_shown_rows,
  count(p.*) AS unique_matches,
  count(*) FILTER (WHERE p.is_resolved_row) AS resolved_unique_rows,
  count(*) FILTER (WHERE NOT coalesce(p.is_resolved_row, false)) AS pending_unique_rows,
  count(*) FILTER (WHERE p.is_resolved_row AND p.result_bucket = 'won') AS hits,
  count(*) FILTER (WHERE p.is_resolved_row AND p.result_bucket = 'lost') AS misses,
  round(coalesce(sum(p.real_pnl_usd), 0), 2) AS net_pnl,
  min(p.shown_batch_day)::text AS min_shown_batch_day,
  max(p.shown_batch_day)::text AS max_shown_batch_day,
  min(p.resolved_at)::date::text AS min_resolved_date,
  max(p.resolved_at)::date::text AS max_resolved_date,
  CASE WHEN count(*) FILTER (WHERE p.is_resolved_row) >= w.min_resolved
       THEN 'ready' ELSE 'insufficient_history' END AS status
FROM windows w
LEFT JOIN pnl p ON p.window_days = w.window_days
GROUP BY w.window_days, w.min_resolved
ORDER BY w.window_days;

-- 02_DATES --------------------------------------------------------------------
WITH anchor AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'utc')::date AS anchor_date
),
windows AS (SELECT unnest(ARRAY[7, 14]) AS window_days),
shown AS (
  SELECT w.window_days, h.*
  FROM windows w
  JOIN anchor a ON true
  JOIN public.track_record_shown_signal_history h
    ON h.shown_batch_day >= a.anchor_date - make_interval(days => w.window_days)
   AND h.shown_batch_day <  a.anchor_date
)
SELECT
  '02_DATES' AS section,
  s.window_days,
  s.shown_batch_day,
  count(*) AS raw_rows,
  count(DISTINCT s.normalized_match_key) AS unique_matches,
  count(*) FILTER (
    WHERE g.resolved_at IS NOT NULL
      AND lower(g.signal_result) IN ('won', 'lost')
      AND g.entry_price_num > 0
  ) AS resolved_rows
FROM shown s
LEFT JOIN public.generated_signal_pairs g ON g.id = s.source_row_id
GROUP BY s.window_days, s.shown_batch_day
ORDER BY s.window_days, s.shown_batch_day;

-- 03_DUPLICATES_TOP -------------------------------------------------------------
WITH anchor AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'utc')::date AS anchor_date
),
windows AS (SELECT unnest(ARRAY[7, 14]) AS window_days),
shown AS (
  SELECT w.window_days, h.*
  FROM windows w
  JOIN anchor a ON true
  JOIN public.track_record_shown_signal_history h
    ON h.shown_batch_day >= a.anchor_date - make_interval(days => w.window_days)
   AND h.shown_batch_day <  a.anchor_date
)
SELECT
  '03_DUPLICATES_TOP' AS section,
  window_days,
  normalized_match_key,
  count(*) AS raw_rows,
  (array_agg(event_title ORDER BY display_score_rank ASC NULLS LAST, shown_at DESC))[1]
    AS chosen_event_title,
  count(*) - 1 AS duplicates_removed
FROM shown
GROUP BY window_days, normalized_match_key
HAVING count(*) > 1
ORDER BY count(*) DESC, window_days
LIMIT 20;

-- 04_TOP_ROWS -------------------------------------------------------------------
WITH anchor AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'utc')::date AS anchor_date
),
windows AS (SELECT unnest(ARRAY[7, 14]) AS window_days),
shown AS (
  SELECT w.window_days, h.*
  FROM windows w
  JOIN anchor a ON true
  JOIN public.track_record_shown_signal_history h
    ON h.shown_batch_day >= a.anchor_date - make_interval(days => w.window_days)
   AND h.shown_batch_day <  a.anchor_date
),
deduped AS (
  SELECT DISTINCT ON (s.window_days, s.normalized_match_key)
    s.*,
    lower(g.signal_result) AS result_bucket,
    g.resolved_at,
    g.winning_outcome,
    g.entry_price_num,
    (g.resolved_at IS NOT NULL
       AND lower(g.signal_result) IN ('won', 'lost')
       AND g.entry_price_num > 0) AS is_resolved_row,
    CASE
      WHEN g.id IS NULL THEN 'no_generated_row'
      WHEN g.resolved_at IS NULL THEN 'pending'
      WHEN lower(g.signal_result) NOT IN ('won', 'lost') THEN 'non_binary_result'
      WHEN NOT (g.entry_price_num > 0) THEN 'bad_entry_price'
      ELSE 'ok'
    END AS audit_flag
  FROM shown s
  LEFT JOIN public.generated_signal_pairs g ON g.id = s.source_row_id
  ORDER BY s.window_days, s.normalized_match_key,
    s.display_score_rank ASC NULLS LAST, g.score DESC NULLS LAST,
    s.shown_at DESC, s.source_row_id
)
SELECT
  '04_TOP_ROWS' AS section,
  window_days,
  row_number() OVER (
    PARTITION BY window_days
    ORDER BY is_resolved_row DESC, display_score_rank ASC NULLS LAST, shown_batch_day DESC
  ) AS final_rank,
  shown_batch_day,
  resolved_at::date AS resolved_date,
  left(event_title, 60) AS event_title,
  left(coalesce(market_question, ''), 60) AS market_question,
  selected_outcome,
  winning_outcome,
  CASE
    WHEN is_resolved_row AND result_bucket = 'won'  THEN 'Hit'
    WHEN is_resolved_row AND result_bucket = 'lost' THEN 'Miss'
    ELSE 'Pending'
  END AS result_status,
  CASE
    WHEN is_resolved_row AND result_bucket = 'won'
      THEN round(stake_usd * ((1.0 / entry_price_num) - 1), 2)
    WHEN is_resolved_row AND result_bucket = 'lost' THEN -stake_usd
    ELSE NULL
  END AS real_pnl_usd,
  audit_flag
FROM deduped
ORDER BY window_days, final_rank
LIMIT 40;
