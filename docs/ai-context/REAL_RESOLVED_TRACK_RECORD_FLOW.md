# Real Resolved Track Record Flow

## 0. Lagged read-model (canonical flow)

The trust-block track record is built from a **lagged historical resolved-row
read-model**, not a row-for-row join of the current selected universe. Do not
conflate the roles below:

| Stage | Table | Role |
| --- | --- | --- |
| Current selected universe | `public.track_record_display_signals` | The current product-selected 7D/14D window. **May contain unresolved/future rows.** Used ONLY to size target row counts per `window_days` (count only — never row-joined). |
| Real historical outcomes | `public.generated_signal_pairs` | Resolver (`signal-resolve-cron`) writes real results: `signal_result`, `resolved_at`, `winning_outcome`, `entry_price_num`, `selected_outcome`, `premium_signal`, `event_slug`, `market_slug`, `score`, `created_at`. The only source of historical resolved rows. |
| UI read-model | `public.track_record_window_results` | Materialized: lagged (completed-day) historical resolved rows from `generated_signal_pairs`, sized to the target counts above, with computed real PnL. **The API reads only this table.** |

**Why lagged, not joined:** `track_record_display_signals` holds the *current*
selected signals — many are unresolved/future and would show up 100% Pending if
joined row-for-row (this was the bug: 47/47 and 91/91 rows Pending). The
correct historical performance source is `generated_signal_pairs`'s own
resolved rows, lagged to a completed-day boundary so same-day/unsettled rows
never enter the pool. `track_record_display_signals` contributes only a
**count** (how many rows a window should show), not identity.

**Lag anchor:**
```
as_of_at = date_trunc('day', now() at time zone 'utc')
7D pool:  resolved_at >= as_of_at - interval '7 days'  AND resolved_at < as_of_at
14D pool: resolved_at >= as_of_at - interval '14 days' AND resolved_at < as_of_at
```

**Eligibility (resolved-only, no winner-only filtering):** `resolved_at is not
null`, `signal_result in ('won','lost')` (both eligible — never filter to
winners only), `entry_price_num` strictly between 0 and 1.

**Dedup:** one row per `match_key` (`lower(event_slug/eventTitle/market_slug/id)`),
preferring higher `score` → newer `resolved_at` → newer `created_at` → stable `id`.

**14D ⊇ 7D invariant:** 7D is selected first from the lagged 14D-deduped
candidate pool (ranked by `resolved_at desc`, capped to the 7D target count).
14D selection ranks previously-selected-7D rows first (tie-break), then fills
remaining slots with older/other candidates up to the 14D target count — so
every 7D row is guaranteed present in 14D whenever `target_count_14 >=
count(selected 7D rows)`.

- Target counts (per window) come from `count(track_record_display_signals)`
  grouped by `window_days`. Expected: ~46/47 for 7D, ~90/91 for 14D — **not
  capped at 20**. If the resolved candidate pool is smaller than a target
  count, all available candidates are used (shortage, not backfilled with
  pending rows).
- `track_record_window_results.display_status` (`Hit`/`Miss`) comes from the
  real `signal_result` on a resolved-only lagged pool, never from projected EV.
- `projected_return_usd` / `projected_pnl_units` / `projected_win_probability` are
  **FORBIDDEN** for real PnL.
- The API `limit` affects **ledger rows only**, never summary metrics. `signalsTracked`
  equals the table row count for the window, not the ledger limit.
- Source label: `track_record_window_results` (API `weekResultsCard.source`);
  the underlying lagged refresh strategy is internally labeled
  `lagged_generated_signal_pairs_resolved_results`.

Real PnL (flat $100 stake), computed once at refresh time:

```
won:  real_pnl_usd = stake_usd * ((1 / entry_price_num) - 1)
lost: real_pnl_usd = -stake_usd
```
(Rows entering this table are resolved-only by construction; no `Pending`
rows are produced by the lagged refresh.)

**Refresh path:** `supabase/migrations/20260702_track_record_window_results.sql`
(create table + idempotent UPSERT refresh on `unique(window_days, source_row_id)`,
plus stale-row cleanup against the frozen refresh selection). Re-run the refresh
block after each resolver cron cycle.

**Test command:** `node --import tsx --test tests/signals/publishedActivity.test.ts`

**Latest resolved signals component:** `components/why-trust/WhyTrustSection.tsx`
(sole trust-block consumer of resolved results as of this writing; see §5).

## 1. Resolver

Railway cron service: `signal-resolve-cron` (every 6h UTC, `0 */6 * * *`). Writes resolution
results directly onto rows in `public.generated_signal_pairs`.

## 2. Real resolved source table

`public.generated_signal_pairs` — the only valid source for real (non-projected)
Hit/Miss/PnL performance.

Result columns used by the trust block:
- `signal_result` (`'won' | 'lost'`, filter: not null / in `('won','lost')`)
- `resolved_at` (filter: not null; window filtering)
- `winning_outcome`
- `realized_return_pct` (informational; not used in the $100-flat-stake formula)
- `entry_price_num` (filter: `> 0 and < 1`)
- `selected_outcome`, `created_at`, `premium_signal`, `market_slug`, `event_slug`

## 3. Invalid source for real PnL

`public.track_record_display_signals` — contains unresolved `Published` projected rows
with near-zero `projected_return_usd`, and (as the current selected universe) may be
entirely unresolved/future. Never use it to derive Hit/Miss/Pending or real PnL, and
never join it row-for-row into `track_record_window_results` — use it only for
`window_days` target *counts* (see §0). It remains valid only for the legacy
projected-EV display functions (`computeDisplaySignalsSummary`,
`mapDisplaySignalRowToTrackRecordRow`) that are no longer wired into `weekResultsCard`.

## 4. API

`GET /api/signals/resolved?mode=latest&days=<7|14>&limit=<n>`

Source (read-model): `public.track_record_window_results` (see §0). The API queries
`.eq("window_days", days)` and reads all matching rows; summary metrics
(`computeWindowResultsSummary`) are computed over the full row set for that window and
are never truncated by the ledger `limit`. The API never re-derives selection or PnL
from `generated_signal_pairs` or `track_record_display_signals` directly — that work
happens once at refresh time in the migration's REFRESH block.

## 5. UI consumers

- `components/why-trust/WhyTrustSection.tsx` — reads `weekResultsCard` fields
  (`netProfitUsd`, `signalsTracked`, `resolvedCount`, `pendingCount`, `returnCurve`,
  `trackRecordDisplayTable.rows[].displayStatus/returnLabel`).
- No standalone "Resolved Signals Section" component exists in the repo as of this
  writing; `WhyTrustSection` is the sole trust-block consumer of resolved results.

## 6. Real PnL formula (flat $100 stake)

```
won:  realPnlUsd = 100 * ((1 / entry_price_num) - 1)
lost: realPnlUsd = -100
```

No projected EV formula (`p * (odds - 1) - (1 - p)`), no `winProbability`, no
`projected_return_usd` / `projected_pnl_units` in this path.

## 7. 14D superset 7D invariant

Enforced at refresh time (see §0), not at API read time: the SQL refresh ranks
previously-selected-7D rows first when building the 14D selection, so every 7D
`source_row_id` is present in the 14D rows whenever `target_count_14 >=
count(selected 7D rows)`. The API's `supersetMissingCount` safe-log field (when
`days=14`) reports any 7D rows missing from the 14D read-model rows as a live proof
check.

## 8. Test command

```
node --import tsx --test tests/signals/publishedActivity.test.ts
```

## 9. Warning

Never derive Hit/Miss/Pending/PnL from projected EV or from
`track_record_display_signals`. Real performance = `generated_signal_pairs` resolved
rows only.
