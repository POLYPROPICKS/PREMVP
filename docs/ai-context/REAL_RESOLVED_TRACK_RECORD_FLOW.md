# Real Resolved Track Record Flow

## 0. Strict resolved-display read-model (canonical flow)

The trust-block track record is built from a **strict actual-resolved
read-model** — not raw all-resolved history, and not a row-for-row join of the
current selected universe. Do not conflate the roles below:

| Stage | Table | Role |
| --- | --- | --- |
| Target counts only | `public.track_record_display_signals` | The current product-selected 7D/14D window. **May contain unresolved/future rows.** Used ONLY to size target row counts per `window_days` (count only — never row-joined). |
| Real resolved outcomes | `public.generated_signal_pairs` | Resolver (`signal-resolve-cron`) writes real results: `signal_result`, `resolved_at`, `winning_outcome`, `entry_price_num`, `selected_outcome`, `premium_signal`, `event_slug`, `market_slug`, `score`, `created_at`. The only source of real resolved outcomes. |
| Final UI read-model | `public.track_record_window_results` | Materialized strict 6/4 selection of actual won/lost rows from `generated_signal_pairs`, sized to the target counts above, with computed real PnL. **The API reads only this table.** |

**Strict resolved display rule** (per window):
```
target_count  = count(track_record_display_signals for that window_days)
target_wins   = floor(target_count * 0.60)
target_losses = target_count - target_wins
```
The selection takes the top `target_wins` actual `won` rows and the top
`target_losses` actual `lost` rows from `generated_signal_pairs`, ranked by real
outcome preference (`score` desc → `resolved_at` desc → `created_at` desc →
stable `id`). `score_rank` interleaves the two buckets proportionally, so the
first 10 display rows are ~6 Hit / 4 Miss (using actual resolved outcomes only).

**Current expected values:**
- 7D: `target_count` 47 → 28 Hit / 19 Miss, pending 0.
- 14D: `target_count` 91 → 54 Hit / 37 Miss, pending 0.

**Eligibility (resolved-only):** `resolved_at is not null`, `signal_result in
('won','lost')`, `entry_price_num` strictly between 0 and 1. Deduped one row per
`match_key` (`lower(event_slug/eventTitle/market_slug/id)`).

**14D ⊇ 7D invariant:** both windows draw from the same global won/lost ordering;
7D win/loss counts are a prefix of the 14D win/loss counts, so every 7D-selected
row is present in 14D (missing 0).

- `track_record_window_results.display_status` (`Hit`/`Miss`) comes from the real
  `signal_result` only. Selection is resolved-only, so `pending = 0`.
- `projected_return_usd` / `projected_pnl_units` / `projected_win_probability` are
  **FORBIDDEN** for real PnL.
- The API `limit` affects **ledger rows only**, never summary metrics.
  `signalsTracked` equals the table row count for the window, not the ledger limit.
- Source label: `track_record_window_results` (API `weekResultsCard.source`);
  `source_model = 'strict-resolved-6-4-display'`.

Real PnL (flat $100 stake), computed once at refresh time:

```
won:  real_pnl_usd = 100 * ((1 / entry_price_num) - 1)
lost: real_pnl_usd = -100
```

**Refresh path:** `supabase/migrations/20260702_track_record_window_results.sql`
(create table + idempotent UPSERT refresh on `unique(window_days, source_row_id)`,
plus a `generated_at`-guarded stale-row cleanup). Re-run the refresh block after
each resolver cron cycle.

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

Enforced at refresh time (see §0), not at API read time: both windows draw from
the same global won/lost ordering, and 7D win/loss counts are a prefix of the 14D
win/loss counts, so every 7D `source_row_id` is present in the 14D rows (verified
missing 0). The API's `supersetMissingCount` safe-log field (when `days=14`)
reports any 7D rows missing from the 14D read-model rows as a live proof check.

## 8. Test command

```
node --import tsx --test tests/signals/publishedActivity.test.ts
```

## 9. Warning

Never derive Hit/Miss/Pending/PnL from projected EV or from
`track_record_display_signals`. Real performance = `generated_signal_pairs` resolved
rows only.
