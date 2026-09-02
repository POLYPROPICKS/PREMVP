# FORWARD_RICH_CAPTURE_V1 — Research Context

Status: **IMPLEMENTATION** (capture wired, not yet released).
Next semantic transition: `FORWARD_RICH_CAPTURE_RELEASE_V1`.
Do **not** treat this file as acceptance of `CURRENT_STATE.yaml`.

## What shipped

1. **Score writer correction.** Every `generated_signal_research_snapshots` row now
   carries a canonical, immutable `diagnostics.scoreObservation` block
   (`lib/feed/researchScoreObservation.ts`, persisted by
   `lib/feed/cacheResearchSnapshots.ts::toResearchSnapshotRow`). It records the
   already-computed strategic/fire-model score, its exact metric/formula version,
   `snapshot_run_id`, `condition_id`, `selected_token_id`, `featureObservedAt` /
   `sourceCreatedAt` (both `= snapshot_at`), and producer lineage
   (`PUBLIC_PATH_ENRICHMENT` | `S2_WIDE_SCORER` | `S2_DIRECT_UNSCORED`).
   No new table, no migration. Score movement is derived downstream from repeated
   independent snapshots — no separate poller.

2. **Daily research materializer.** `lib/modeling/forward-rich/` +
   `npm run modeling:forward-rich -- --since <ISO>`. Deterministic, no-LLM,
   append/cutoff based; never rewrites accepted historical rows. Reads only the
   immutable `generated_signal_pairs` (DECISION_AT, `entry_price_num`,
   `diagnostics.volumeUsd`, signal-side classification) and
   `generated_signal_research_snapshots` (score / price observation series).
   Point-in-time rule: only observations with `FEATURE_OBSERVED_AT <= DECISION_AT`
   become features. Four instants kept distinct on every row: `DECISION_AT`,
   `FEATURE_OBSERVED_AT`, `SOURCE_CREATED_AT`, `MATERIALIZED_AT`.

3. **Frozen August research context.** Canonical tracked surface:
   `lib/modeling/forward-rich/augustFrozenResearchContext.ts`.

| cohort | selector | N | PnL (u) | ROI % | MaxDD (u) |
|---|---|---:|---:|---:|---:|
| August C4 baseline (2026-08-05..2026-08-25) | `model=C4` | 4,117 | +474.56 | 11.5269 | -16.41 |
| Hypothesis 1 | `C4 + market_type_raw=soccer_first_to_score` | 621 | +103.29 | 16.63 | -13.31 |
| Hypothesis 2 | `C4 + market_type_raw=soccer_exact_score` | 196 | +113.13 | 57.72 | -6.00 |
| Hypothesis 3 | `C4 + provider_sport_code=uwcl` | 87 | +22.35 | 25.69 | -3.00 |

All three hypotheses: `FROZEN_DIAGNOSTIC_HYPOTHESIS`, `NOT_FORWARD_VALIDATED`,
`NO_PRODUCTION_MODEL_CHANGE`.

Forward evaluation keys preserved on every materialized row:
`marketTypeRaw = soccer_first_to_score`, `marketTypeRaw = soccer_exact_score`,
`providerSportCode = uwcl` — reusing existing deterministic signal-side semantics,
no new taxonomy.

## Verification

- `npm run test:modeling:forward-rich`
- `node --import tsx --test tests/feed/researchSnapshotScoreWriter.test.ts`
