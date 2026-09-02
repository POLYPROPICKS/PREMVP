# RECENT_RESERVATION_GAMMA_SETTLED_V1

Read-only diagnosis. Actual PREMVP Reservations 2026-08-31 → 2026-09-02, settled with the
exact accepted August research Gamma authority, enriched, evaluated flat-1u.

## Authority

- **Reservation authority:** `night_event_reservations` (`selection_reason=RESERVED_EVENT_MAX_SIGNAL_SCORE_V1`,
  `diagnostics.reservation_authority=CONTRACT_A_PLANNING_DECISION`, `selector_id=CONTRACT_A_PLANNING_V1`).
- **Identity bridge:** `night_event_reservations.best_snapshot_id` → `generated_signal_pairs.id`
  (= `diagnostics.source_lineage.generated_signal_pair_id`). 30/30 exact, no fuzzy matching.
- **Settlement authority (unchanged from August):** Polymarket Gamma.
  `provider_event_id` → `/events/{id}`; `condition_id` → `market.conditionId`;
  `selected_token_id` → `market.clobTokenIds`. Terminal iff `closed=true` AND
  `outcomePrices` contains a `1`. WIN iff `selected_token_id == clobTokenIds[indexOf(1)]`.
- `generated_signal_pairs.signal_result` used as **diagnostic only**, never as authority.

## Population (kept separate, not one funnel)

| | N |
|---|---|
| RESERVATION_ROW_N | 30 |
| UNIQUE_PHYSICAL_EVENT_N | 30 |
| UNIQUE_MARKET_SIDE_N | 30 |
| plan_date 2026-08-31 | 15 |
| plan_date 2026-09-01 | 15 |
| plan_date 2026-09-02 | 0 |

All 30 reservations are `status=QUEUED`. No 2026-09-02 cohort exists yet.

## Settlement — the recent resolver question, settled permanently

| | N |
|---|---|
| GAMMA_EXACT_EVENT_LINK_N | 30 |
| GAMMA_EXACT_MARKET_LINK_N | 30 |
| GAMMA_EXACT_TOKEN_LINK_N | 30 |
| **GAMMA_SETTLED_N** | **30** |
| GAMMA_OPEN_N | 0 |
| GAMMA_NO_MATCH_N | 0 |
| GAMMA_AMBIGUOUS_N | 0 |
| WIN_N | 16 |
| LOSS_N | 14 |
| **GAMMA_SETTLED_BUT_GSP_NULL_N** | **30** |
| GAMMA_SETTLED_AND_GSP_WON_LOST_N | 0 |
| GSP_CONTRADICTS_GAMMA_N | 0 |

**30/30 recent Reservations are economically settled under the accepted August authority,
and 30/30 are NULL in `generated_signal_pairs.signal_result`.** The Founder's runtime
expectation is confirmed. The prior 0-resolved reading was a GSP settlement-writer coverage
gap, not reality. (Repair is explicitly out of scope for this mission.)

## Rich feature coverage over GAMMA_SETTLED (denominator 30)

| feature | N | % |
|---|---|---|
| ENTRY_PRICE_PRESENT | 30 | 100% |
| VOLUME_PRESENT (`provider_market_volume`) | 30 | 100% |
| MARKET_TYPE_PRESENT (excl. `unknown`) | 23 | 76.67% |
| PROVIDER_SPORT_CODE_PRESENT | 30 | 100% |
| SCORE_PRESENT | 0 | 0% |

Observed market classes: `allowed_fullmatch_total` 20, `unknown` 7, `allowed_fullmatch_spread` 3.
Scope: SOCCER 28, MLB 2. Lead time 1.9h – 8.9h (no row ≥ 24h).

## Economics (flat 1u, chronological by `reserved_at`)

Cohort as a whole — context only, not a model:

| slice | N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|---|
| ALL_SETTLED | 30 | 16 | 14 | +7.1772 | 23.92% | -4.0587 |

Frozen models:

| model | N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|---|
| MODEL_1_C4 | 0 | 0 | 0 | 0 | n/a | 0 |
| MODEL_2_C1_SOCCER_CORE | 0 | 0 | 0 | 0 | n/a | 0 |
| MODEL_3_C4_NON_SOCCER | 0 | 0 | 0 | 0 | n/a | 0 |

**Structural cause: observed `entry_price` range is [0.385, 0.495]. Every single one of the
30 reservations sits below the C4 floor of 0.50.** C4 has zero intersection with the live
Reservation contour for these dates. This is a population/predicate disjointness fact, not a
sample-size accident.

## Frozen high-ROI hypotheses

| hypothesis | Aug anchor | recent TOTAL_N | SETTLED_N | status |
|---|---|---|---|---|
| A — C4 ∧ `provider_sport_code=uwcl` | N=87, ROI 25.69% | 0 | 0 | NOT_OBSERVED |
| B — C4 ∧ `market_type_raw=soccer_first_to_score` | N=621, ROI 16.63% | 0 | 0 | NOT_OBSERVED |
| C — C4 ∧ `market_type_raw=soccer_exact_score` | N=196, ROI 57.72% | 0 | 0 | NOT_OBSERVED |

All three are gated behind C4 (N=0). Independently, no `uwcl` sport code and no
first-to-score / exact-score market type appears in the cohort — the live Reservation
contour is emitting full-match totals and spreads only.

## Daily breakdown

| date | RESERVATION_N | GAMMA_SETTLED_N | C4_SETTLED_N | C4_PNL_U | cohort PNL_U | cohort ROI |
|---|---|---|---|---|---|---|
| 2026-08-31 | 15 | 15 | 0 | 0 | +5.6031 | 37.35% |
| 2026-09-01 | 15 | 15 | 0 | 0 | +1.5742 | 10.49% |
| 2026-09-02 | 0 | 0 | 0 | 0 | 0 | n/a |

## Verdict

- **CURRENT_C4_RECENT: INSUFFICIENT_N** (N=0 — disjoint from the live Reservation price band)
- **UWCL: NOT_OBSERVED**
- **FIRST_TO_SCORE: NOT_OBSERVED**
- **EXACT_SCORE: NOT_OBSERVED**
- **NEXT_CHALLENGER: none selected.**

No challenger can be selected: every candidate hypothesis has N=0 on recent Reservation
evidence. Not promoted to production.

## Artifact

`RECENT_RESERVATION_GAMMA_SETTLED_V1.jsonl.gz` — 30 rows, one per Reservation, carrying exact
lineage (`reservation_id`, `plan_run_id`, `provider_event_id`, `condition_id`,
`selected_token_id`, `selected_outcome`, `reserved_at`, `event_start`, sport, market identity),
rich fields, Gamma terminal state and the derived WIN/LOSS label. `SUMMARY.json` carries the
machine-readable counts.
