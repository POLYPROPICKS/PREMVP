# Legacy reference reconciliation

Two metric layers are kept apart and never overwrite each other: **LEGACY_REPORTED_METRICS** (historical figures with source path/commit, in `STRATEGY_REGISTRY.json`) and **COMMON_CORPUS_METRICS** (`COMMON_CORPUS_SCORECARD.json`).

| Strategy | Legacy record | Legacy span | Legacy sel/settled/open | Legacy PnL u | Legacy MaxDD | Common sel/settled/open | Common PnL u | Common MaxDD | Verdict |
|---|---|---|---|---:|---:|---|---:|---:|---|
| FOOTBALL_ODDS_192_200_REPAIRED_SAFE | LEGACY_FROZEN_RUNNER_PRE_BACKFILL | 2026-08-04..2026-09-20 | 1015/716/299 | +131.79 | -14.69 | 1141/800/341 | +170.05 | -14.69 | DIFFERENT_SPAN (not comparable) |
| FOOTBALL_ODDS_192_200_REPAIRED_SAFE | LEGACY_WITH_POLYMARKET_299_BACKFILL | 2026-08-04..2026-09-20 | 1015/953/62 | +182.80 | n/a | 1141/800/341 | +170.05 | -14.69 | DIFFERENT_SPAN (not comparable) |
| FOOTBALL_ODDS_185_200_REPAIRED | LEGACY_FROZEN_RUNNER | 2026-08-04..2026-09-20 | 1223/881/342 | +143.61 | -12.48 | 1386/988/398 | +178.31 | -12.48 | DIFFERENT_SPAN (not comparable) |
| FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200 | STRUCTURAL_AUTHORITY_V2_COMBINED | 2026-08-04..2026-09-24 | 726/566/160 | +135.21 | -8.65 | 726/566/160 | +135.21 | -8.65 | EXACT_MATCH |
| FOOTBALL_MONEYLINE_TOTALS_SPREADS_ODDS_185_200 | RESTORED_LINEAGE_AUDIT_V2_LIVE_POLICY_REPLAY | 2026-08-04..2026-09-24 | 514/438/76 | +117.05 | -10.46 | 514/438/76 | +117.05 | -10.46 | EXACT_MATCH |
| FOOTBALL_ODDS_192_200_PRICE_BAND | RESTORED_LINEAGE_AUDIT_V2_COMBINED | 2026-08-04..2026-09-24 | 476/416/60 | +110.05 | -14.57 | 476/416/60 | +110.05 | -14.57 | EXACT_MATCH |
| FOOTBALL_ODDS_185_200_PRICE_BAND | RESTORED_LINEAGE_AUDIT_V2_COMBINED | 2026-08-04..2026-09-24 | 637/554/83 | +100.25 | -11.46 | 637/554/83 | +100.25 | -11.46 | EXACT_MATCH |
| FOOTBALL_TOTAL_CORNERS_ODDS_225_250 | STRUCTURAL_AUTHORITY_V2_INTERACTION_CELL | 2026-08-04..2026-09-24 | 118/77/41 | +22.78 | -7 | 118/77/41 | +22.78 | -7 | EXACT_MATCH |
| FOOTBALL_SPREADS_ODDS_185_200_AUDIT_REQUIRED | RESTORED_LINEAGE_AUDIT_V2_LIVE_POLICY_REPLAY_SPREADS | 2026-08-04..2026-09-24 | 250/201/49 | +122.14 | -6 | 250/201/49 | +122.14 | -6 | EXACT_MATCH |

## Why strategies 1 and 2 differ from their legacy values

- Legacy span was 2026-08-04..2026-09-20 on the v1 overlay; the common corpus runs to 2026-09-24 on the v2 overlay/classification, so the selected sets are larger.
- Strategy 1's legacy +182.80u (953 terminal / 62 open) applied a one-off Polymarket lookup to 299 open identities of that strategy only. The common corpus applies ONE uniform settlement attachment (`research_model_ready_rows.settlement_label`) to all strategies, so that backfill is deliberately NOT applied; identities nonterminal under it stay OPEN and are never losses.
- The SAFE selection is all-sport first, football subset after (see `CANONICAL_RECONCILIATION_P50_52.md`); strategies 5/6 are football-first with the ordinary-market filter. They are different strategies and are not merged.

## Diagnostic: SAFE strategies replayed on the legacy window (model_date <= 2026-09-20, v2 classification, common settlement)

Informational only — shows how much of the difference is span/overlay/settlement rather than selector semantics.

| Strategy | Selected | Settled | Open | PnL u | ROI % | MaxDD u |
|---|---:|---:|---:|---:|---:|---:|
| FOOTBALL_ODDS_192_200_REPAIRED_SAFE | 1015 | 716 | 299 | +131.79 | 18.41 | -14.69 |
| FOOTBALL_ODDS_185_200_REPAIRED | 1223 | 881 | 342 | +143.61 | 16.30 | -12.48 |

## Legacy unreproducible reference

`LEGACY_UNREPRODUCIBLE_REFERENCE_ALL_FOOTBALL_3835`: selected 3835 / settled 2522 / open 1313 / −0.73u. No implementation exists; status NOT_EXECUTABLE / NOT_MODEL_AUTHORITY. Replaced by executable baseline `FOOTBALL_ORDINARY_STRUCTURED_NO_ODDS_FILTER` (Founder/Architect decision); its common-corpus figures are recomputed, not inherited.
