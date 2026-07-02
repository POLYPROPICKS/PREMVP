-- ============================================================================
-- Track record shown-history flow — trust-block read-model built ONLY from
-- signals that were actually selected/shown by the live/display pipeline.
--
-- DATA FUNNEL (see docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md):
--   1. public.track_record_display_signals      = CURRENT live/display-selected
--      rows (refreshed; old rows disappear). Source of shown rows only.
--   2. public.track_record_shown_signal_history = append/upsert persistence of
--      every shown row (source_row_id unique), so shown history survives
--      display-table refreshes.
--   3. public.generated_signal_pairs            = REAL resolved outcomes
--      (signal-resolve-cron): signal_result, resolved_at, winning_outcome,
--      entry_price_num, score. Joined by shown_history.source_row_id = g.id.
--   4. Normalize + dedup: 1 normalized_match_key = 1 final signal.
--   5. Resolved-only: signal_result in ('won','lost'), resolved_at not null,
--      entry_price_num > 0. Pending rows are tracked in the summary but NEVER
--      create PnL.
--   6. Uses ALL actual resolved unique shown rows for ready windows. No
--      synthetic 6/4 (or any other) balancing, no dropped wins/losses to hit
--      a target ratio. NO fill from global generated_signal_pairs.
--   7. Readiness thresholds: 7D ready if resolved unique rows >= 20,
--      14D ready if resolved unique rows >= 40. Below threshold the window is
--      status = 'insufficient_history': summary counts only, NO result rows,
--      NO positive Net Return.
--   8. public.track_record_window_results + public.track_record_window_summary
--      = the only tables the API reads.
--
-- FORBIDDEN: projected_return_usd / projected_pnl_units /
--            projected_win_probability MUST NOT be used as realized results.
-- ============================================================================

BEGIN;

-- ── Normalizer: keep teams, drop sport prefix / series suffix / parentheticals.
-- 'Valorant: Team Vitality vs Karmine Corp (BO3) - Esports World Cup Group B'
--   => 'team vitality vs karmine corp'
-- 'Dota 2: LGD Gaming vs Virtus.pro - Game 1 Winner' => 'lgd gaming vs virtus.pro'
-- 'Argentina vs. Cabo Verde - More Markets'          => 'argentina vs. cabo verde'
CREATE OR REPLACE FUNCTION public.track_record_normalize_match_key(raw_title text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        -- Strip a leading 'Sport Name: ' prefix only when the remainder still
        -- looks like a team matchup ('vs'), so team names are never collapsed
        -- into a bare sport label.
        CASE
          WHEN lower(btrim(coalesce(raw_title, ''))) ~ '^[^:]{1,40}:\s+.*\svs\.?\s'
            THEN regexp_replace(lower(btrim(coalesce(raw_title, ''))), '^[^:]{1,40}:\s+', '')
          ELSE lower(btrim(coalesce(raw_title, '')))
        END,
        '\s+-\s+.*$', ''),          -- drop ' - Game 1 Winner' / ' - More Markets'
      '\s*\([^)]*\)\s*$', '')       -- drop trailing '(BO3)' style qualifiers
  );
$$;

COMMENT ON FUNCTION public.track_record_normalize_match_key(text) IS
  'Normalized match key for track-record dedup: lowercased team matchup, sport '
  'prefix and series/market suffix removed. Keeps team names (never collapses '
  'Dota/Valorant titles into a bare sport label).';

-- ── Shown-history table: persisted copy of every live/display-selected row. ──
CREATE TABLE IF NOT EXISTS public.track_record_shown_signal_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_row_id         uuid NOT NULL UNIQUE,
  shown_batch_day       date NOT NULL,
  shown_at              timestamptz NOT NULL DEFAULT now(),
  event_title           text NOT NULL,
  market_question       text,
  selected_outcome      text,
  stake_usd             numeric NOT NULL DEFAULT 100,
  display_score_rank    integer,
  display_source_model  text,
  normalized_match_key  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS track_record_shown_history_batch_day_idx
  ON public.track_record_shown_signal_history (shown_batch_day DESC);
CREATE INDEX IF NOT EXISTS track_record_shown_history_match_key_idx
  ON public.track_record_shown_signal_history (normalized_match_key);

COMMENT ON TABLE public.track_record_shown_signal_history IS
  'Append/upsert history of actually shown/display-selected signals '
  '(source_row_id = generated_signal_pairs.id). Persists shown rows so they '
  'do not disappear when track_record_display_signals refreshes. The ONLY '
  'valid shown-signal source for the trust-block track record.';

ALTER TABLE public.track_record_shown_signal_history ENABLE ROW LEVEL SECURITY;

-- ── Final read-model: per-window result rows (ready windows only). ───────────
CREATE TABLE IF NOT EXISTS public.track_record_window_results (
  id                        bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  window_days               integer NOT NULL CHECK (window_days IN (7, 14)),
  source_row_id             uuid NOT NULL,
  score_rank                integer,
  match_key                 text,
  signal_key                text,
  event_title               text NOT NULL,
  market_question           text,
  selected_outcome          text,
  position                  text,
  source_model              text,
  selection_generated_at    timestamptz,
  selection_latest_batch_at timestamptz,
  result_source_table       text NOT NULL DEFAULT 'generated_signal_pairs',
  signal_result             text,
  display_status            text NOT NULL CHECK (display_status IN ('Hit', 'Miss', 'Pending')),
  is_resolved               boolean NOT NULL DEFAULT false,
  resolved_at               timestamptz,
  winning_outcome           text,
  entry_price_num           numeric,
  decimal_odds              numeric,
  stake_usd                 numeric NOT NULL DEFAULT 100,
  real_pnl_usd              numeric,
  return_label              text NOT NULL DEFAULT '—',
  metric_formula_version    text NOT NULL DEFAULT 'realized-flat-stake-v1',
  generated_at              timestamptz NOT NULL DEFAULT now(),
  row_hash                  text
);

-- Shown-history provenance columns (idempotent add for pre-existing installs).
ALTER TABLE public.track_record_window_results
  ADD COLUMN IF NOT EXISTS shown_batch_day date;
ALTER TABLE public.track_record_window_results
  ADD COLUMN IF NOT EXISTS normalized_match_key text;

CREATE UNIQUE INDEX IF NOT EXISTS track_record_window_results_window_source_uidx
  ON public.track_record_window_results (window_days, source_row_id);
CREATE INDEX IF NOT EXISTS track_record_window_results_window_rank_idx
  ON public.track_record_window_results (window_days, score_rank);
CREATE INDEX IF NOT EXISTS track_record_window_results_window_resolved_idx
  ON public.track_record_window_results (window_days, is_resolved, resolved_at DESC);

COMMENT ON TABLE public.track_record_window_results IS
  'Final trust-block read-model. Rows exist ONLY for ready windows and come '
  'exclusively from shown-history rows joined to their own actual resolved '
  'outcome (generated_signal_pairs by source_row_id), deduped one row per '
  'normalized_match_key, resolved-only. Uses all actual resolved unique shown '
  'rows. No synthetic balancing. No global fill. projected_* fields are '
  'FORBIDDEN as realized results.';
COMMENT ON COLUMN public.track_record_window_results.source_row_id IS
  'track_record_shown_signal_history.source_row_id = generated_signal_pairs.id.';
COMMENT ON COLUMN public.track_record_window_results.real_pnl_usd IS
  'Realized flat-$100-stake PnL from the shown row''s own resolved outcome. Never projected EV.';

ALTER TABLE public.track_record_window_results ENABLE ROW LEVEL SECURITY;

-- ── Per-window summary/status (the API reads status from here). ──────────────
CREATE TABLE IF NOT EXISTS public.track_record_window_summary (
  window_days           integer PRIMARY KEY CHECK (window_days IN (7, 14)),
  status                text NOT NULL CHECK (status IN ('ready', 'insufficient_history')),
  raw_shown_rows        integer NOT NULL DEFAULT 0,
  unique_matches        integer NOT NULL DEFAULT 0,
  resolved_unique_rows  integer NOT NULL DEFAULT 0,
  pending_unique_rows   integer NOT NULL DEFAULT 0,
  wins_count            integer NOT NULL DEFAULT 0,
  losses_count          integer NOT NULL DEFAULT 0,
  net_pnl_usd           numeric NOT NULL DEFAULT 0,
  net_return_pct        numeric NOT NULL DEFAULT 0,
  generated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.track_record_window_summary IS
  'Per-window funnel summary for the trust block. status=insufficient_history '
  'means the shown history does not yet have enough resolved unique rows '
  '(7D >= 20, 14D >= 40) — the UI must show the honest tracking state and no '
  'positive Net Return. Counts are shown-history counts, never global rows.';

ALTER TABLE public.track_record_window_summary ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- REFRESH — run after each display refresh / resolver cron cycle. Idempotent.
-- ============================================================================

BEGIN;

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

-- STEPS 3–7 — join actual results, dedup, resolved-only, all resolved rows.
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

COMMIT;
