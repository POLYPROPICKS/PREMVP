# Real Resolved Track Record Flow

## 0. Three-table read-model (canonical flow)

The trust-block track record is built from **three** tables. Do not conflate them:

| Stage | Table | Role |
| --- | --- | --- |
| Selected universe | `public.track_record_display_signals` | Product rules decide WHICH signals belong to the 7D/14D window. Source of the selected universe only. |
| Real outcomes | `public.generated_signal_pairs` | Resolver (`signal-resolve-cron`) writes real results: `signal_result`, `resolved_at`, `winning_outcome`, `entry_price_num`, `realized_return_pct`. |
| UI read-model | `public.track_record_window_results` | Materialized join: selected universe + real outcomes + computed real PnL. **The API reads this table.** |

**Correct join:** `track_record_display_signals.source_row_id` → `generated_signal_pairs.id`
(`g.id::text = d.source_row_id`).

- Selected universe count (per window) drives `signalsTracked`. Expected: ~46/47 rows
  for 7D and ~90/91 rows for 14D — **not capped at 20**.
- `track_record_window_results.display_status` (`Hit`/`Miss`/`Pending`) comes from the
  real `signal_result`, never from projected EV.
- `projected_return_usd` / `projected_pnl_units` / `projected_win_probability` are
  **FORBIDDEN** for real PnL.
- The API `limit` affects **ledger rows only**, never summary metrics. `signalsTracked`
  equals the table row count for the window, not the ledger limit.
- 14D is a superset of 7D: every 7D `source_row_id` must exist in the 14D rows.

Real PnL (flat $100 stake), computed once at refresh time:

```
won:  real_pnl_usd = stake_usd * ((1 / entry_price_num) - 1)
lost: real_pnl_usd = -stake_usd
pending: real_pnl_usd = null, return_label = '—'
```

**Refresh path:** `supabase/migrations/20260702_track_record_window_results.sql`
(create table + idempotent UPSERT refresh on `unique(window_days, source_row_id)`,
plus stale-row cleanup). Re-run the refresh block after each resolver cron cycle.

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
with near-zero `projected_return_usd`. Never use it to derive Hit/Miss/Pending or real
PnL. It remains valid only for the legacy projected-EV display functions
(`computeDisplaySignalsSummary`, `mapDisplaySignalRowToTrackRecordRow`) that are no
longer wired into `weekResultsCard`.

## 4. API

`GET /api/signals/resolved?mode=latest&days=<7|14>&limit=<n>`

Target source (read-model): `public.track_record_window_results` (see §0). The API
reads all rows for the requested `window_days`; summary metrics are computed over the
full row set and are never truncated by the ledger `limit`.

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

Selection runs on the 14D (or wider requested) window first via `selectResolvedRows`
(dedupe by `matchKey`, prefer higher score → newer `resolved_at` → newer `created_at` →
stable `id`), then 7D is derived as a subset filtered by `resolved_at`. Every 7D
`sourceRowId` is guaranteed to exist in the 14D selection.

## 8. Test command

```
node --import tsx --test tests/signals/publishedActivity.test.ts
```

## 9. Warning

Never derive Hit/Miss/Pending/PnL from projected EV or from
`track_record_display_signals`. Real performance = `generated_signal_pairs` resolved
rows only.
