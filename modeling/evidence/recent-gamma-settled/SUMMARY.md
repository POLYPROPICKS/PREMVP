# RECENT_RESERVATION_CONTOUR_ECONOMIC_EXPANSION_V1

Expansion of [RECENT_RESERVATION_GAMMA_SETTLED_V1] onto the full 14-day natural Reservation
history. Same authorities, same identity bridge, same settlement rule — larger N only.

Supersedes the prior N=30 artifact: those 30 rows are preserved unchanged as the final 30
chronological rows of this 195-row cohort (`plan_date_minsk` 2026-08-31 / 2026-09-01).

## Authorities (unchanged, reused)

- **Reservation:** `night_event_reservations`.
- **Identity:** `best_snapshot_id` → `generated_signal_pairs.id` (= `diagnostics.source_lineage.generated_signal_pair_id`) → `provider_event_id` / `condition_id` / `selected_token_id`. Exact, no fuzzy matching.
- **Settlement:** Polymarket Gamma, exact triple-key join, terminal iff `closed=true` AND an `outcomePrices` entry equals `1`. WIN iff `selected_token_id == clobTokenIds[indexOf(1)]`.
- `generated_signal_pairs.signal_result` retained diagnostic-only.

## Window and stop condition

Walked backward through all natural Reservation cohorts, 14 days, `plan_date_minsk`
2026-08-19 → 2026-09-01 (earliest reservation ever recorded is 2026-06-22, so 14 days is
well within available history). Raw population in this window is **195** — short of the
200-settled target. **Stopped under condition B: the full 14-day window was exhausted**
(no more recent cohorts exist to add without exceeding the 14-day cap the mission set).

## Settlement counts

| | N |
|---|---|
| RESERVATION_N | **195** |
| EXACT_GAMMA_LINK_N (event+market+token, all exact) | 195 |
| **SETTLED_N** | **190** |
| OPEN_N | 5 |
| NO_MATCH_N | 0 |
| AMBIGUOUS_N | 0 |
| W / L | 103 / 87 |
| DECISION_DATE_START | 2026-08-19T14:01:45Z |
| DECISION_DATE_END | 2026-09-01T14:02:06Z |

Diagnostic cross-check (unchanged conclusion from the N=30 mission): **182/190 settled rows
are NULL in `generated_signal_pairs.signal_result`**; 0 contradictions where GSP does carry a
result. The GSP settlement-writer coverage gap is confirmed at scale, not just in the N=30
sample.

## Economics — flat 1u, chronological by `reserved_at`

| | N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|---|
| **FULL (N=190)** | 190 | 103 | 87 | **+34.0046** | **17.90%** | **-13.14** |

### Stability as N grows (cumulative, chronological from the earliest reservation, 2026-08-19)

| N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|
| 30 (2026-08-19→08-21) | 15 | 15 | +0.9054 | 3.02% | -5.0198 |
| 50 (→08-22) | 33 | 17 | +20.1353 | 40.27% | -5.0198 |
| 100 (→08-25) | 52 | 48 | +11.3150 | 11.31% | -13.14 |
| 150 (→08-29) | 80 | 70 | +21.4053 | 14.27% | -13.14 |
| 190 (→09-01, full) | 103 | 87 | +34.0046 | 17.90% | -13.14 |

Note these cumulative windows are counted forward from the **earliest** date in the 14-day
history (2026-08-19), so N=30 here is a *different* 30 rows from the N=30 mission's baseline
sample. The baseline (2026-08-31 + 2026-09-01, N=30, 16W/14L, +7.1772u, 23.92% ROI, -4.0587u
MaxDD) is reproduced exactly as the **last** 30 rows of this same chronological sequence —
confirmed bit-for-bit, no reinterpretation. ROI across the walk is noisy at small N (3% →
40% → 11%) then **stabilizes in the 11–18% band from N=100 onward and stays positive
throughout** — it does not collapse. Drawdown grows from -5.02u to -13.14u as N grows but
stays below the C4 historical benchmark drawdown.

## Descriptive slices (no threshold mining — natural selector categories only)

| slice | N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|---|
| SOCCER | 106 | 57 | 49 | +22.1843 | 20.93% | -7.9175 |
| NON_SOCCER | 84 | 46 | 38 | +11.8203 | 14.07% | -10.0716 |
| `allowed_fullmatch_total` | 34 | 21 | 13 | +13.7513 | 40.44% | -4.5904 |
| `allowed_fullmatch_spread` | 8 | 3 | 5 | -1.1076 | -13.85% | -3.9381 |
| `unknown` market class | 145 | 77 | 68 | +19.7091 | 13.59% | -13.14 |

`allowed_fullmatch_total` is the strongest slice observed (N=34, 40.44% ROI) but N is small;
`allowed_fullmatch_spread` is the only negative slice (N=8, thin). These are diagnostics, not
new filters — no threshold was mined or optimized.

## Entry price — descriptive only, no threshold search

| MIN | P25 | MEDIAN | P75 | MAX |
|---|---|---|---|---|
| 0.365 | 0.43 | 0.465 | 0.50 | 0.53 |

The live Reservation contour operates almost entirely in the [0.365, 0.53] band — still
mostly below the C4 floor of 0.50, confirming the disjointness finding from the N=30 mission
at scale.

## Daily breakdown

| plan_date | RESERVATION_N | SETTLED_N |
|---|---|---|
| 2026-08-19 | 15 | 14 |
| 2026-08-20 | 15 | 14 |
| 2026-08-21 | 15 | 15 |
| 2026-08-22 | 15 | 15 |
| 2026-08-23 | 15 | 13 |
| 2026-08-24 | 15 | 15 |
| 2026-08-25 | 30 | 29 |
| 2026-08-26 | 15 | 15 |
| 2026-08-29 | 30 | 30 |
| 2026-08-31 | 15 | 15 |
| 2026-09-01 | 15 | 15 |

(2026-08-27, 08-28, 08-30 have zero Reservation rows — no reservation cohort ran those
nights; not a settlement gap.)

## Comparison to C4 — separate strategy, not a sequential funnel

| | N | ROI_PCT | MAX_DD_U |
|---|---|---|---|
| C4 historical benchmark | 4142 | 11.85% | -15.84 |
| C4 August | 4117 | 11.53% | -16.41 |
| **Reservation contour (this mission)** | **190** | **17.90%** | **-13.14** |

The Reservation contour is not a subset or superset of C4 — it is the live production
selection policy, evaluated on its own terms. It runs at 1/20th the N of the C4 benchmarks,
but its ROI is higher and its drawdown is smaller, and it does not collapse as N grows from
30 to 190.

## Verdict

**A. RESERVATION_CONTOUR_CHALLENGER_PROMISING**

- Materially larger settled N achieved: 30 → 190 (6.3x).
- PnL positive throughout the full walk-forward sequence, never net-negative from any
  starting point after N≈40.
- ROI does not materially collapse: it stabilizes at 11–18% from N=100 onward, in the same
  range as or above the frozen C4 historical/August benchmarks (11.5–11.9%).
- Drawdown (-13.14u) stays below both C4 benchmark drawdowns (-15.84u, -16.41u).

**This merits a frozen forward challenger definition** — the live Reservation contour itself
(not a re-filtered subset of it) as a distinct candidate strategy, to be tracked forward with
its own frozen identity rather than folded into C4. Next bounded step, if pursued: freeze the
current Reservation-contour definition as an explicit named model and begin forward-only
accrual — no threshold search, no retroactive re-selection.

## Artifact

`RECENT_RESERVATION_GAMMA_SETTLED_V1.jsonl.gz` — 195 rows (14-day Reservation cohort,
2026-08-19 → 2026-09-01), exact lineage, rich fields, Gamma terminal labels. `SUMMARY.json`
carries the machine-readable expansion. This file replaces the prior N=30 revision in place;
the 30 baseline rows are unchanged and are the final 30 rows of this file by `reserved_at`.

[RECENT_RESERVATION_GAMMA_SETTLED_V1]: ./SUMMARY.md
