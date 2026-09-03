# DETERMINISTIC_RICH_MODEL_SCORECARD_V1 — FINDINGS

**BACKWARD-LOOKING DESCRIPTIVE ONLY. `FORWARD_VALIDATED = false` for every cell. No forward-performance
claim. No threshold search. No winner chosen.**

- Authority: canonical rolling research corpus on `origin/main` `88b12ea` (PR #238), windows ending
  Europe/Minsk **2026-09-02**, all complete + immutable (7d/14d/30d, `PIT_FUTURE_LEAK_N=0`).
- Models: frozen `C0/C1/C4/C5` predicates + flat-1u settlement + MaxDD/ROI primitives imported
  verbatim from `lib/modeling/research-engine` (`engine-version freeze-v1`) — nothing redefined.
- Economics: one physical economic event → at most one selected bet (chronological first eligible
  decision); flat 1u; `WIN pnl_u = 1/entry_price − 1`, `LOSS pnl_u = −1`; OPEN/NO_MATCH/VOID and
  identity/coverage gaps excluded from PnL and reported explicitly.
- Label view: latest Gamma-authoritative AS-OF label (`labelAsOf`); immutable feature rows never mutated.
- Determinism: `SCORECARD_CANONICAL_CONTENT_SHA256 = 72da11e6bb5302fde75b0cd26ad8c8256cb95181e07057b7835f3cd8207dd32f`,
  identical across runs and reversed partition input order.
- Score SERIES: **0% coverage both populations**, `STATUS=DATA_QUALITY_ONLY`,
  `SCORE_SERIES_USED_AS_PREDICATE=false`. No model here needs it.

## MODEL × POPULATION × PERIOD — primary economics

`N` = selected physical-event bets; PnL in units; ROI% on flat-1u stake per selected event;
MaxDD in units; `+/- wk` = positive vs negative 7-day chronological buckets (30d); `burst` =
max |single-bucket PnL| / Σ|bucket PnL| (→1.0 = one isolated period).

| Model | Population | 7d N / PnL / ROI% | 14d N / PnL / ROI% | 30d N / PnL / ROI% | 30d MaxDD | 30d +/- wk | 30d burst |
|---|---|---|---|---|---|---|---|
| C0 PRICE_ANCHOR | SEP_PUBLIC_RICH_V1 | 453 / +183.00 / +40.40 | 454 / +182.00 / +40.09 | 590 / +168.04 / +28.48 | −20.33 | 2 / 2 | 0.75 |
| C0 PRICE_ANCHOR | SEP_SHADOW_STRATEGIC_V1 | 18 / −1.34 / −7.44 | 155 / −26.05 / −16.81 | 626 / −14.46 / −2.31 | −42.92 | 1 / 4 | 0.40 |
| C1 HIGH_ROI (soccer) | SEP_PUBLIC_RICH_V1 | 20 / −0.07 / −0.33 | 20 / −0.07 / −0.33 | 20 / −0.07 / −0.33 | −3.00 | 1 / 1 | 0.53 |
| C1 HIGH_ROI (soccer) | SEP_SHADOW_STRATEGIC_V1 | 0 / 0 / 0 | 3 / −1.02 / −33.99 | 48 / +7.28 / +15.17 | −4.04 | 1 / 2 | 0.87 |
| C4 BALANCED (soccer OR lead≥24h) | SEP_PUBLIC_RICH_V1 | 20 / −0.07 / −0.33 | 21 / −1.07 / −5.08 | 23 / −3.07 / −13.33 | −5.32 | 1 / 4 | 0.23 |
| C4 BALANCED | SEP_SHADOW_STRATEGIC_V1 | 0 / 0 / 0 | 36 / −7.08 / −19.67 | 203 / −13.82 / −6.81 | −26.62 | 1 / 2 | 0.70 |
| C5 PNL_SCALE (≠ table-tennis) | SEP_PUBLIC_RICH_V1 | 453 / +183.00 / +40.40 | 454 / +182.00 / +40.09 | 590 / +168.04 / +28.48 | −20.33 | 2 / 2 | 0.75 |
| C5 PNL_SCALE | SEP_SHADOW_STRATEGIC_V1 | 18 / −1.34 / −7.44 | 137 / −18.05 / −13.17 | 566 / −12.46 / −2.20 | −37.92 | 1 / 4 | 0.38 |

C5 == C0 for SEP_PUBLIC_RICH_V1 (no table-tennis in that population). C5 = C0 minus 60 table-tennis
physical events for SEP_SHADOW_STRATEGIC_V1.

## What the honest data actually supports

1. **Only C0/C5 on SEP_PUBLIC_RICH_V1 show positive economics** (30d +168u / +28.5% ROI, N=590) —
   but `burst=0.75` and the 7-day cumulative PnL is `[−14.33, −14.33, −15.33, +132.46, +167.67]`:
   **the entire positive result is the single week 2026-08-25 → 2026-09-01 (+147.79u)**. The three
   earlier weeks are flat/negative. This is one recent burst, not a repeated effect.
2. **SEP_PUBLIC_RICH_V1 physical-event attribution collapses in the older window.** 30d has 4510
   unique selections but only 2014 unique `provider_event_id`; `UNRESOLVED_PHYSICAL_EVENT_N` grows
   backward in time (early-August partitions carry almost no `provider_event_id`). 7d N=453 vs 30d
   N=590 for C0 — the extra 23 days add only 137 attributable bets.
3. **C1 (soccer) has almost no data**: N=20 for SEP_PUBLIC_RICH_V1 across the whole 30d, N=48 for
   SEP_SHADOW_STRATEGIC_V1 (and that +7.28u is `burst=0.87`, one bucket). `providerSportFamily` is
   null on ~74% of corpus rows — soccer is only ~1973 rows total. C1 is not evaluable at scale here.
4. **C4 is negative in every cell it has data for.**
5. **SEP_SHADOW_STRATEGIC_V1 is net-negative for C0/C4/C5** across 14d and 30d.
6. Score LEVEL diagnostic (SEP_PUBLIC_RICH_V1, 30d; descriptive, NOT thresholds): the `60-64`
   bucket carries most settled volume (1847 settled, +181.94u / +20.4% ROI); `55-59` +8.8%; the
   `<55`, `65-69`, `75+` buckets are near-flat or negative. This is a description of the existing
   population, not a proposed cut.

## Data-quality ceiling (per population, 30d)

| | SEP_PUBLIC_RICH_V1 | SEP_SHADOW_STRATEGIC_V1 |
|---|---|---|
| INPUT_ROWS (pre-collapse) | 4607 | 26089 |
| UNIQUE_SELECTION_N | 4510 | 15419 |
| UNIQUE_PHYSICAL_EVENT_SELECTION_N | 2014 | 1168 |
| SETTLED_N / OPEN_N / NO_MATCH_N | 3149 / 1361 / 0 | 9168 / 6251 / 0 |
| WIN/LOSS with NO provider_event_id (excluded from economics) | 115 | 4826 |
| ECONOMIC_ELIGIBLE_ROW_N (fed to engine) | 3034 | 4342 |
| Score LEVEL coverage / min / max | 100% / 53 / 83 | 0% / null / null |
| Score SERIES coverage | 0% (DATA_QUALITY_ONLY) | 0% (DATA_QUALITY_ONLY) |
| Volume coverage | 0% | 38.1% |
| price-path coverage | 88.0% | 4.0% |
| lead-time coverage | 100% | 50.6% |

## For the next mission (`FREEZE_2_TO_3_FORWARD_VALIDATION_CANDIDATES_V1`)

This scorecard is **input to a choice, not the choice**. The evidence points at a very small
candidate set — C0/C5 on SEP_PUBLIC_RICH_V1 is the only positive economics, and it needs
forward validation precisely because it is a single recent burst on a window whose older half
has thin physical-event attribution. C1/C4 lack the data to be forward-validated here.
Do not tune a Score LEVEL threshold from the diagnostic buckets.

Machine-readable: `modeling/evidence/rich-model-scorecard-v1/SCORECARD_7d14d30d_2026-09-02.json`.
