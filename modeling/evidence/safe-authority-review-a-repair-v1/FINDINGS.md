# SAFE Modeling Authority — Review A Repair V1 (2026-08-04..2026-09-20)

PNL_CLASS: `REFERENCE_PNL` (display price) — `NOT_EXECUTION_AUTHORITY`.

## Repairs (runner: scripts/modeling/tennis-safe-comparable-leaderboard.ts)
1. `soccer_exact_score` removed before safe-tennis gate, physical-event selection and any cap (822 candidates). EXACT_SCORE_SELECTED_N = 0 in every row.
2. Sport comes only from the frozen fail-closed overlay `football-denominator-reconciliation-v1` (exact identity join; 0 misses; missing/conflicting → unresolved).
3. `runPortfolioStrict` freezes each event decision at its first observation that qualifies for any tier (prefix-invariant). Thresholds/tiers unchanged.
4. Finality: WIN/LOSS terminal; VOID terminal, 0 PnL, counted in ROI denominator (RESEARCH_CORPUS_CONTRACT §5.3/§PRIMARY); OPEN/NO_MATCH/AMBIGUOUS/other all bounded LOSS/WIN. `FILL_RATE` → `DAYS_SUPPLY_AT_CAP_RATE` (supply coverage, not venue fill probability). In this window VOID_N = 0 and OPEN is the only nonterminal status observed.

## Baseline drift (not part of Review A)
The published CURRENT_MODELING_AUTHORITY_V1 is reproduced exactly (300/300 fields) only with the tennis gate before #389 (`7fb1f08`). On current main, #389 cuts approved safe tennis from 901 to 416. `DELTA_VS_PUBLISHED` separates the two effects: repair-only (pre-#389 gate) vs total on current main.
`CURRENT_MODELING_AUTHORITY.js` (the dashboard) is NOT overwritten; the founder has to pick which tennis basis becomes authoritative.
