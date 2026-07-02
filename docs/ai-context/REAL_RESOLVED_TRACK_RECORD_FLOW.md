# Real Resolved Track Record Flow

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

Response `weekResultsCard.source = "generated_signal_pairs_resolved_results"`.

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
