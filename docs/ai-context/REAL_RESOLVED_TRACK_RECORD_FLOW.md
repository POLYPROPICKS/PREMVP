# Real Resolved Track Record Flow (shown-history)

## 0. Final funnel (canonical)

The trust-block track record is built ONLY from signals that were actually
selected/shown by the live/display pipeline, joined to their own resolved
outcomes:

```
shown/live signals (track_record_display_signals)
  → persist shown history (track_record_shown_signal_history, upsert by source_row_id)
  → join actual result by source_row_id → generated_signal_pairs.id
  → normalize + dedup: 1 normalized_match_key = 1 final signal
  → resolved-only (signal_result in ('won','lost'), resolved_at not null, entry_price_num > 0)
  → strict 6/4 only if enough resolved rows
  → track_record_window_results + track_record_window_summary → API → UI
```

**FORBIDDEN:** using global/random resolved `generated_signal_pairs` rows to
fill shortages or manufacture a positive PnL. If the shown history does not
have enough resolved rows, the window is `insufficient_history` and the UI
shows the honest tracking state — no positive Net Return, no fabricated chart.

## 1. Table roles

| Table | Role |
| --- | --- |
| `public.track_record_display_signals` | CURRENT live/display-selected rows. Refreshed — old rows disappear. Source of shown rows only; never a results/PnL source. |
| `public.track_record_shown_signal_history` | Append/upsert persistence of every shown row (`source_row_id` unique = `generated_signal_pairs.id`, `shown_batch_day`, `normalized_match_key`). The ONLY valid shown-signal source. |
| `public.generated_signal_pairs` | Real resolved outcomes written by `signal-resolve-cron`: `signal_result`, `resolved_at`, `winning_outcome`, `entry_price_num`, `score`. Joined per shown row by `source_row_id` — never sampled globally. |
| `public.track_record_window_results` | Final read-model rows — exist ONLY for ready windows. |
| `public.track_record_window_summary` | Per-window funnel counts + `status` (`ready` / `insufficient_history`). |

## 2. Dedup rule

`1 normalized_match_key = 1 final signal`. Normalization keeps team names —
it never collapses Dota/Valorant titles into a bare sport label:

- `Valorant: Team Vitality vs Karmine Corp (BO3) - Esports World Cup Group B` → `team vitality vs karmine corp`
- `Dota 2: LGD Gaming vs Virtus.pro - Game 1 Winner` → `lgd gaming vs virtus.pro`
- `Argentina vs. Cabo Verde - More Markets` → `argentina vs. cabo verde`

SQL: `public.track_record_normalize_match_key(text)`; TS mirror:
`normalizeMatchKey` in `app/api/signals/resolved/route.ts`.

Best row per match: `display_score_rank` asc nulls last → generated `score`
desc nulls last → `shown_at` desc → `source_row_id` stable tie-break.

## 3. Window logic

Completed-day anchor: `anchor_date = date_trunc('day', now() at time zone 'utc')::date`.
7D: `shown_batch_day >= anchor_date - 7 days AND < anchor_date`; 14D likewise
with 14 days. 14D includes all eligible 7D source rows plus older rows
(superset by construction).

## 4. Resolved-only performance + PnL

Only rows with `signal_result in ('won','lost') AND resolved_at IS NOT NULL
AND entry_price_num > 0` enter PnL and the final ledger. Pending rows are
counted in the summary but never create PnL.

```
stake_usd = 100 (unless stored otherwise)
won:  real_pnl_usd = 100 * ((1 / entry_price_num) - 1)
lost: real_pnl_usd = -100
```

`projected_return_usd` / `projected_pnl_units` / `projected_win_probability`
are FORBIDDEN as realized results.

## 5. Strict 6/4 after resolved-only

Applied ONLY after shown-history → actual result → dedup → resolved-only:

```
target_count  = largest resolved-unique count satisfiable by actual won/lost buckets
target_wins   = floor(target_count * 0.60)
target_losses = target_count - target_wins
```

No fill from global `generated_signal_pairs`. `score_rank` interleaves the two
buckets proportionally, so the first 10 display rows are ~6 Hit / 4 Miss
(actual resolved outcomes only). Source label:
`source_model = 'shown-history-strict-resolved-6-4'`.

## 6. Readiness thresholds / insufficient_history fallback

- 7D `ready` if resolved unique shown rows >= 20
- 14D `ready` if resolved unique shown rows >= 40

(Chosen as ~2–3x the 10-row display page so the 6/4 split is meaningful and a
single day's resolutions can't flip the status.) Below threshold:
`status = insufficient_history`, `track_record_window_results` holds no rows
for the window, summary PnL is 0, and the UI shows: tracking is live, raw
shown rows, unique matches, resolved so far, pending so far.

## 7. API

`GET /api/signals/resolved?mode=latest&days=<7|14>&limit=<n>`

Reads ONLY `track_record_window_results` + `track_record_window_summary`. It
never computes the final summary from global `generated_signal_pairs`, raw
`track_record_display_signals`, or projected fields. `weekResultsCard` exposes
`source`, `status`, `rawShownRows`, `uniqueMatches`, `resolvedCount`,
`pendingCount`, `winsCount`, `lossesCount`, `netProfitUsd`, `totalStakeUsd`,
`netReturnPct`, `returnCurve`, ledger rows with proof fields (`sourceRowId`,
`shownBatchDay`, `resolvedAt`, `normalizedMatchKey`, `signalResult`,
`realPnlUsd`). `limit` affects ledger rows only, never summary metrics.

## 8. Compact SQL verification workflow

1. Run the refresh blocks in
   `supabase/migrations/20260702_track_record_window_results.sql`
   (idempotent: history upsert → per-window rebuild → summary upsert).
2. Run `supabase/migrations/preview_track_record_shown_history_flow.sql`
   in the Supabase SQL Editor — compact readable sections `01_SUMMARY`,
   `02_DATES`, `03_DUPLICATES_TOP`, `04_TOP_ROWS` (with `audit_flag`).
3. Re-run after each display refresh / resolver cron cycle.

## 9. Current limitation

Current display rows may all be pending: the last audit found 7D 47 raw shown
rows (~44 unique matches) and 14D 91 raw (~87 unique) with **0 resolved rows
for exact source_row_id**. Until actual shown rows resolve, both windows
correctly report `insufficient_history`. The earlier global-source numbers
(7D 47 rows 28 Hit / 19 Miss +$1031.89; 14D 91 rows 54 Hit / 37 Miss
+$1959.75) came from the WRONG source (global resolved rows) and are a rough
future benchmark only — never force them.

## 10. Test command

```
node --import tsx --test tests/signals/publishedActivity.test.ts
```
