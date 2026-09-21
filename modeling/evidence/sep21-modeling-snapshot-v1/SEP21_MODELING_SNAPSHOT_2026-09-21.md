# SEP21 MODELING FREEZE

**Dataset:** 2026-08-04 → 2026-09-20 · 48 closed days · 68,949 model-ready rows · 7,985 processed physical events.

**Preferred research candidate:** `QUALITY_FILL_A`

This is the permanent, human-readable frozen authority for what was achieved on Sep21. It freezes the
modeling state accepted in this PR as of 2026-09-21 and does not recompute or revisit any historical decision.
Browser dashboard: `modeling/evidence/modeling-dashboard-v1/MODELING_DASHBOARD.html`. Daily refresh command:
`npm run research-clone:modeling-dashboard-refresh`.

Flat 1u backtest research economics only — never equated with realized live cash P&L. Source authority:
PREMVP-DB-CLONE / `research_model_ready_days` / `research_model_ready_rows`. Engine authority:
`scripts/modeling/daily-portfolio-frontier.ts` (`runStandalone` / `runPortfolio` / `applyDailyCap` /
`computeCapacity` / `metricsFor`), reused verbatim by every model definition below — no second
settlement/capacity implementation exists.

## Founder table

Primary rows only (B/C variants kept as appendix reference). All rows are the frozen Aug04–Sep20 evidence at
cap 50 unless noted; no raw rows below, aggregate metrics only.

| STATUS | MODEL | DATASET | CAP | SELECTED N | ROI | P&L | MAX DD | 30-DAY P&L | FILL30 | FILL40 | FILL50 | SPORT MIX | MAIN RULES |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PREFERRED_RESEARCH_PORTFOLIO | QUALITY_FILL_A | Aug04–Sep20 (48d) | 50 | 1382 | 29.11% | +402.25u | -28.62u | +251.41u | 50.00% | 37.50% | 31.25% | tier composition only¹ | 1. Tennis P50_52 → 2. Soccer P50_54 → 3. remaining P50_52 |
| FILL_REFERENCE | QUALITY_FILL_D | Aug04–Sep20 (48d) | 50 | 1465 | 27.22% | +398.76u | -32.28u | +249.22u | 58.33% | 39.58% | 33.33% | tier composition only¹ | QUALITY_FILL_A + Soccer P54_60 last fallback |
| STRONG_SIMPLE_BASELINE | P50_52 | Aug04–Sep20 (48d) | 50 | 1343 | 28.24% | +379.30u | -29.04u | +237.06u | 47.92% | 35.42% | 29.17% | all sports | 0.50 ≤ entry_price < 0.52 |
| PRODUCTION_REFERENCE_MODEL_NOT_RESEARCH_PNL_LEADER | PORTFOLIO_BROAD | Aug04–Sep20 (48d) | 50 | 1454 | 25.78% | +374.88u | -31.87u | +234.30u | 56.25% | 37.50% | 33.33% | tiered, multi-sport | tier1 Tennis/Score63-64 P50_52 → tier2 P50_52 → tier3 P52_54 |
| STRONG_RESEARCH_BASELINE | P50_54 | Aug04–Sep20 (48d) | 50 | 1448 | 24.82% | +359.45u | -36.96u | +224.66u | 56.25% | N/A² | 31.25% | all sports | 0.50 ≤ entry_price < 0.54 |
| TRACKED_REFERENCE_PRICE_ANCHOR_BAND | C5 | Aug04–Sep20 (48d) | 50 | 1618 | 20.68% | +334.56u | -39.86u | +209.10u | 66.67% | N/A² | 37.50% | price-anchor band, all sports | frozen C5 definition (lib/modeling/research-engine/models.ts) |
| TRACKED_REFERENCE_PRICE_ANCHOR_BAND | C0 | Aug04–Sep20 (48d) | 50 | 1648 | 19.83% | +326.75u | -46.86u | +204.22u | 68.75% | N/A² | 37.50% | price-anchor band, all sports | 0.50 ≤ entry_price < 0.60 |
| STRONG_HIGH_QUALITY_SATELLITE_SPARSE_SUPPLY | TENNIS_P50_52 | Aug04–Sep20 (48d) | 50 | 586 | 62.45% | +365.96u | -10.02u | +228.73u | 20.83%³ | N/A² | 14.58%³ | 100% tennis by construction | 0.50 ≤ entry_price < 0.52, sportFamily = tennis |

¹ Per-event sport-mix aggregate not present in the accepted evidence artifacts read for this freeze; not
recomputed here (`RAW_ROW_BUDGET=0`, no new calculation search in scope). Tier composition (MAIN RULES column)
is the accepted substitute.
² Fill40 not published as a standalone aggregate figure for this model in the accepted evidence; not a zero,
not recomputed.
³ TENNIS_P50_52's Fill30/Fill50 reflect its full 48-day sparse-supply profile (uncapped daily supply threshold),
consistent with its "sparse supply" status — see Appendix B/C notes below for the frozen conclusion.

## Appendix — QUALITY_FILL B / C (reference only, not promoted)

| MODEL | CAP | SELECTED N | ROI | P&L | MAX DD | 30-DAY P&L | FILL30 | FILL40 | FILL50 |
|---|---|---|---|---|---|---|---|---|---|
| QUALITY_FILL_B | 50 | 1382 | 28.96% | +400.25u | -30.62u | +250.16u | 50.00% | 37.50% | 31.25% |
| QUALITY_FILL_C | 50 | 1465 | 27.08% | +396.76u | -32.28u | +247.97u | 58.33% | 39.58% | 33.33% |

## Frozen research decision

**Primary research candidate: `QUALITY_FILL_A`.** At cap 50: N=1382, P&L=+402.25u, ROI=29.11%,
MaxDD=-28.62u, 30-day flat-1u projection=+251.41u. Fill30=0.5000, Fill40=0.3750, Fill50=0.3125.

Rules (evaluated in priority order per physical event, `runPortfolio` tiered semantics):
1. Tennis P50_52
2. Soccer P50_54
3. remaining P50_52 (all sports, including Esports)

**Fill reference: `QUALITY_FILL_D`.** At cap 50: N=1465, P&L=+398.76u, ROI=27.22%, MaxDD=-32.28u, 30-day
projection=+249.22u. Fill30=0.5833, Fill40=0.3958, Fill50=0.3333. QUALITY_FILL_D's additional 83 events vs
QUALITY_FILL_A produce a total P&L delta of **-3.49u** (all in the added-event set — 0 removed, 0 reselected;
canonical `applyDailyCap()` output, reconciled exactly). Therefore `QUALITY_FILL_D` is preferred as the
**fill reference**, not as a replacement for the preferred research portfolio.

`QUALITY_FILL_A = PREFERRED_RESEARCH_PORTFOLIO`. `QUALITY_FILL_D = FILL_REFERENCE`. This classification is
not changed in this mission.

## Frozen other conclusions

| Item | Accepted status |
|---|---|
| P50_52 | strong simple baseline |
| PORTFOLIO_BROAD | production/reference model, not research P&L leader |
| P50_54 | strong research baseline |
| TENNIS_P50_52 | strong high-quality satellite, sparse supply |
| signal score | useful information / ranking context, NON-MONOTONIC, not a universal hard gate |
| hard score >= 65 | NO_GO as mandatory gate |
| volume | NOT_ACTIONABLE_CURRENT_COVERAGE |
| sub-0.50 | NO_GO |
| legacy BAD_BUCKET hard reject | NO_GO |
| C4 non-Soccer lead >= 24 | NO_GO |
| dynamic score trajectory | DATA_NOT_AVAILABLE |
| Exact Score / First-to-score | SMALL_SAMPLE |

## Reproducibility

All model/cap calculations reuse the existing Git-owned capacity/economics engine
(`scripts/modeling/daily-portfolio-frontier.ts`: `runStandalone`, `runPortfolio`, `applyDailyCap`,
`computeCapacity`, `metricsFor`). No second settlement/capacity implementation was introduced by this
mission. No accepted analytics exists only in chat — every number above traces to a Git-tracked evidence
artifact:

- `modeling/evidence/daily-cap-pnl-optimization-v1/DAILY_CAP_PNL_OPTIMIZATION_2026-08-04_2026-09-20.md`
- `modeling/evidence/daily-cap-pnl-optimization-v1/QUALITY_FILL_PORTFOLIO_TEST_2026-08-04_2026-09-20.md`
- `modeling/evidence/daily-cap-pnl-optimization-v1/QUALITY_FILL_D_RESULT_2026-08-04_2026-09-20.md`

## Daily append

Historical dashboard values through 2026-09-20 are FROZEN and are never silently rewritten. Future refreshes
via `npm run research-clone:modeling-dashboard-refresh` detect newly closed `MODEL_READY` dates strictly
after the last date present in `modeling/evidence/modeling-dashboard-v1/MODELING_DAILY_DATA.js`, fetch only
those dates' model-ready rows, evaluate the frozen model set above through the same engine, and append daily
aggregates. No historical Sep21 decision is recomputed or optimized by the daily refresh.

## Browser dashboard

Open `modeling/evidence/modeling-dashboard-v1/MODELING_DASHBOARD.html` directly in Chrome/Edge/Safari (no
local server required — it loads `MODELING_DAILY_DATA.js` from the same folder and Plotly from a pinned CDN
build). It renders the KPI cards, the founder analytics table, and all six required plots (P&L by daily cap,
marginal P&L, P&L/fill frontier, signal score, Aug/Sep regime, and daily history) from this frozen aggregate
data.

This mission is FREEZE / PRESENTATION / REPRODUCIBILITY / DAILY APPEND scope only. No new modeling search,
threshold sweep, or hypothesis was run to produce this snapshot or the dashboard it backs.
