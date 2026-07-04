# Work_tru_PPP04July — Funnel Log

## Purpose

Permanent filesystem note for the 4 July working funnel and ownership map.

## Runtime Contracts

- Top Weekly / Paywall: legacy 7d proof — `/api/signals/resolved?mode=latest&days=7&limit=7` → `legacyWeekResultsCard`.
- Latest Resolved: `/api/signals/resolved?mode=latest&days=14&limit=7` → `json.signals`.
- WhyTrust: isolated `/api/why-trust/track-record?days=14&limit=25` → `weekResultsCard`.

## Tables

- `generated_signal_pairs` — canonical signal pairs with resolved outcomes (`signal_result`, `resolved_at`, `entry_price_num`).
- `track_record_display_signals` — materialized displayed signals.
- `track_record_shown_signal_history` — permanent history of shown signals (`source_row_id`, `shown_batch_day`, `normalized_match_key`).
- `track_record_window_summary` — window counters and `status` (`ready` / `insufficient_history`).
- `track_record_window_results` — ready-window detail rows (populated only when thresholds are met).

## Scripts / RPC

- `scripts/refresh-track-record-window-results.ts`
- `refresh:track-record` (read/dry-run)
- `refresh:track-record:write`
- `track-record:daily:write`
- `refresh_track_record_window_results()` (Supabase RPC)

None of these run automatically from the WhyTrust endpoint — it is read-only.

## Current WhyTrust Preview Rule

When `track_record_window_results` is empty because thresholds are not met:

- use `track_record_shown_signal_history` JOIN `generated_signal_pairs`;
- include only real resolved won/lost rows;
- build ledger rows;
- build `returnCurve` from the same rows;
- preserve `status=insufficient_history`;
- keep headline PnL zero.

## Test Coverage

- `tests/signals/whyTrustTrackRecordContract.test.ts`
- `tests/signals/resolvedLatestContract.test.ts`
- `tests/signals/publishedActivity.test.ts`
- `tests/signals/trackRecordWindowApi.test.ts`
- `tests/signals/trackRecordRefreshRunner.test.ts`

## Verification Commands

```
node --import tsx --test tests/signals/whyTrustTrackRecordContract.test.ts
node --import tsx --test tests/signals/*.test.ts
npx tsc --noEmit
npm run build
```

## Production API Checks

```
curl "https://polypropicks.com/api/why-trust/track-record?days=14&limit=25"
curl "https://polypropicks.com/api/signals/resolved?mode=latest&days=14&limit=7"
curl "https://polypropicks.com/api/signals/resolved?mode=latest&days=7&limit=7"
```

## Do Not Commit

- generated JSON curl artifacts
- screenshots
- local reports unless explicitly scoped
