# CONTRACT_A_LARGE_INTERVAL_ECONOMIC_VALIDATION_V1

Validates the live production Contract A selection policy — the contour whose accepted
selections become `night_event_reservations` rows — on the full available current-policy
history. Contract A is evaluated as-is. No comparison or redesign of C4 in this mission.

## Authority (unchanged, reused)

- **Contract A / Reservation:** `night_event_reservations`.
- **Identity:** `best_snapshot_id` → `generated_signal_pairs.id` → `provider_event_id` /
  `condition_id` / `selected_token_id`. Exact, no fuzzy matching.
- **Settlement:** Polymarket Gamma, exact triple-key join, terminal iff `closed=true` AND an
  `outcomePrices` entry equals `1`. WIN iff `selected_token_id == clobTokenIds[indexOf(1)]`.
- `generated_signal_pairs.signal_result` diagnostic-only.

## Policy-lineage boundary (current Contract A only)

`diagnostics.selector_id` / `diagnostics.contract_a_version` were inspected across all
history (earliest reservation: 2026-06-22):

| period | selector_id | contract_a_version | treatment |
|---|---|---|---|
| ≤ 2026-07-20 | absent | absent | **excluded** — pre-Contract-A / undiagnosed policy |
| 2026-07-21 → 2026-08-04 | `CONTRACT_A_PLANNING_V1` | absent | **excluded** — partial instrumentation, version field not yet emitted |
| **2026-08-05 → 2026-09-01** | `CONTRACT_A_PLANNING_V1` | `CONTRACT_A_PLANNING_V1` | **included — current lineage** |

Only the fully-instrumented, version-matched current lineage (2026-08-05 onward) is used.
This is **all available current-Contract-A history** — the mission's ≥500-settled target was
not reached because that much history does not yet exist; per the mission's fallback rule,
all available rows are used.

## Baseline reconciliation (not refit)

The prior 14-day sample (2026-08-19 → 2026-09-01, N=195/190 settled, PNL +34.0046u, ROI
17.90%, MaxDD -13.14u) is the **final 195 rows** of this same current-lineage sequence,
verified to reproduce unchanged. This mission adds the remaining 2026-08-05 → 2026-08-18
history underneath it.

## Population and settlement

| | N |
|---|---|
| CONTRACT_A_RAW_N | **381** |
| CONTRACT_A_EXACT_GAMMA_LINK_N (event+market+token, all exact) | 345 |
| **CONTRACT_A_SETTLED_N** | **330** |
| CONTRACT_A_OPEN_N | 15 |
| CONTRACT_A_NO_MATCH_N | 36 |
| CONTRACT_A_AMBIGUOUS_N | 0 |
| W / L | 156 / 174 |
| DECISION_DATE_START | 2026-08-05T14:57:03Z |
| DECISION_DATE_END | 2026-09-01T14:02:06Z |

The 36 `NO_MATCH` rows are concentrated entirely in 2026-08-05 (15) and 2026-08-06 (20), plus
one on 2026-08-10 — the earliest days of the current lineage, where `provider_event_id` is
null in `diagnostics.source_lineage` and the fallback `condition_id`-only Gamma market lookup
returns no market at all (verified live: `gamma-api.polymarket.com/markets?condition_ids=...`
→ `[]`). This is a lineage-completeness gap in the earliest rollout days, not a settlement
failure or a fuzzy-match workaround — no fuzzy matching was used.

Diagnostic cross-check: **322/330 settled rows are NULL in `generated_signal_pairs.signal_result`**,
0 contradictions where GSP does carry a value. Confirms the GSP settlement-writer coverage
gap at the largest scale examined yet.

## Economics — flat 1u, chronological, priority order PNL → ROI → MaxDD → N

| | N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|---|
| **FULL (current lineage)** | 330 | 156 | 174 | **+11.4912** | **3.48%** | **-27.3109** |

### Stability as N grows (cumulative, chronological)

| N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|
| 50 | 16 | 34 | -13.8589 | -27.72% | -15.0811 |
| 100 | 39 | 61 | -13.5014 | -13.50% | -21.4809 |
| 150 | 57 | 93 | -24.3109 | -16.21% | -26.2911 |
| 200 | 89 | 111 | -5.6649 | -2.83% | -27.3109 |
| 300 | 140 | 160 | +4.3140 | 1.44% | -27.3109 |
| 330 (full) | 156 | 174 | +11.4912 | 3.48% | -27.3109 |

(N=400/500 not reachable — only 330 settled rows exist in the current-lineage history.)

**Total PnL and ROI do not grow monotonically with N — they are net-negative through N=200**
and only turn and stay positive from roughly N=280 onward. Drawdown (-27.31u) is materially
worse than either C4 benchmark drawdown (-15.84u / -16.41u) and worse than the 14-day
sample's -13.14u. This is a real reversal versus the recent-only read, not measurement noise
— it comes from including the earlier, weaker settled history that the 14-day sample
excluded.

## Time robustness — fixed chronological quartiles (unmixed, no boundary optimization)

| quartile | N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|---|
| Q1 (earliest) | 83 | 29 | 54 | -19.1378 | -23.06% | -21.4809 |
| Q2 | 83 | 37 | 46 | -2.8742 | -3.46% | -14.6963 |
| Q3 | 83 | 43 | 40 | +10.4436 | 12.58% | -13.14 |
| Q4 (latest) | 81 | 47 | 34 | +23.0597 | 28.47% | -7.00 |

**POSITIVE_PNL_QUARTILE_N = 2 / 4** (Q3, Q4). Q1 and Q2 are net losers. There is a clear
monotonic improvement Q1 → Q4 in both PnL and ROI — the most recent quarter of history is
materially stronger than the earliest — but only half of the fixed quartiles are positive,
which fails the "majority positive" bar.

## Natural composition — descriptive only, no filtering applied

**SPORT_FAMILY (strategic_scope) counts:** SOCCER 166, TENNIS 105, ESPORT 38, MLB 17,
BASKETBALL 2, MMA 2.

**MARKET_CLASS counts:** `unknown` 248, `esports_non_policy` 35, `allowed_fullmatch_spread`
11, `allowed_fullmatch_total` 34, `allowed_fullmatch_moneyline` 1, `forbidden_props` 1.

**ENTRY_PRICE distribution:** MIN 0.295, P25 0.425, MEDIAN 0.46, P75 0.50, MAX 0.53.

**Major sport families (N ≥ 30), descriptive only:**

| sport_family | N | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|
| SOCCER | 166 | +22.7332 | 13.69% | -11.7721 |
| NON_SOCCER (all other families combined, for contrast) | 164 | -11.2419 | -6.85% | -25.5155 |

TENNIS (N=105) and ESPORT (N=38) are the two other individually-qualifying families but are
not broken out further here — no filter or promotion is applied to any of these in this
mission; they are reported as composition only.

## Benchmark context only (not the same population, no funnel comparison, no explanation)

| | N | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|
| C4 historical | 4142 | +490.71 | 11.85% | -15.84 |
| C4 August | 4117 | +474.56 | 11.53% | -16.41 |
| **Contract A (this mission)** | **330** | **+11.4912** | **3.48%** | **-27.3109** |

Reference only. Why Contract A differs from C4 is explicitly out of scope — owned by
`CONTRACT_A_VS_C4_PREDICATE_DIFFERENCE_V1`.

## Verdict

**B. CONTRACT_A_EDGE_WEAKENS_AT_SCALE**

- ROI collapses from the 14-day baseline's 17.90% to 3.48% over the full current-lineage
  history — a material deterioration, not noise (net-negative PnL persists through N=200).
- Max drawdown more than doubles, from -13.14u to -27.3109u, exceeding both frozen C4
  benchmark drawdowns.
- Only 2 of 4 fixed chronological quartiles are net-positive (Q1, Q2 negative).

This does **not** mean the edge is fake going forward: Q3/Q4 show a clear, monotonic
improving trend, and the previously-validated 14-day sample is exactly the tail of that
improving trend (Q4 alone: N=81, +23.06u, 28.47% ROI). But evaluated on the full available
current-lineage denominator, as this mission requires, Contract A's historical track record
is weak and volatile, not strong. Whether the recent improvement is a durable regime shift or
a transient run cannot be determined from this evidence alone.

No production routing change made. No threshold search, no sport/market-class filter
created.

## Artifact

`CONTRACT_A_LARGE_INTERVAL_V1.jsonl.gz` — 381 rows (current Contract A lineage,
2026-08-05 → 2026-09-01), exact lineage, rich fields, Gamma terminal labels, derived
settlement. `SHA256.txt` covers this file, this summary, and no separate JSON summary was
emitted (all reported figures are in this document).
