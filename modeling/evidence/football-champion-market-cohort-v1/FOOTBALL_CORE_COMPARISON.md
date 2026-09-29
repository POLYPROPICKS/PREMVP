# FOOTBALL_CORE_COMPARISON - Aug04..Sep24 historical authority

Status: **HISTORICAL_REFERENCE_PNL / NOT_EXECUTION_AUTHORITY / AGGREGATE_ONLY**. Clone reads: 0 rows (committed aggregates only). DB writes 0. Production reads 0. Sep25+ is not included.

`NC` = `NOT_COMPARABLE_FROM_CANONICAL_AGGREGATES`: the exact metric is not present in any committed canonical aggregate and was **not** reconstructed or approximated.

## Provenance (reused, not rebuilt)

Reference commit (read-only worktree): `555036047fe63583e2b9cda14161b2f22071b45c` (`origin/claude/tender-johnson-z3zm8e`; these authorities are committed there and not yet on `main`).

| Input | Last commit | SHA-256 |
|---|---|---|
| modeling/evidence/football-structural-authority-v2/FOOTBALL_STRUCTURAL_AUTHORITY_2026-08-04_2026-09-24.json | f2a9e3fe9b38 | 7dfd7d3424dfed74dd14b1035b69fd98b21e78e04d6ee5f9ccb154ce424f0a3a |
| modeling/evidence/p5052-p5054-c1-restored-lineage-audit-v2/AUDIT_REPORT.json | 992348be4818 | 59979f2901e541431ed42bdc0f5ed3fe0f0c6e65ab43524680ecd3da782e31b1 |
| modeling/evidence/football-denominator-reconciliation-v2/FOOTBALL_DENOMINATOR_OVERLAY_2026-08-04_2026-09-24.jsonl.gz | 0ff47c9c9d48 | 944d45b4a5c8dcffbbc12a54fbe4926a1bba269fad1fefc592ca7db2e4ce1665 |
| modeling/evidence/candidate-v3-freeze-v1/CANDIDATE_V3_CONTRACT.json | 28099ddaf255 | 3f88b1947e4a116332abcaa6c19348dd4540a0ef4cd0c9732214d834f57d52a9 |
| modeling/evidence/candidate-v3-bounded-repair-v1/AMENDED_CANDIDATE_V3_CONTRACT.json | 555036047fe6 | 4a380e876b0003f7b22004d9fe8590908638399dc3143cf55958c8d08924dd05 |
| modeling/evidence/step4c-contract-a-final-replay-v1/FINDINGS.md | 59189fb2c18e | 471e97c3a31fa6731ab3922cab32cf9843182cc9011360a172cee364e736b42a |

Semantics inherited from the inputs: SELECTION_BEFORE_SETTLEMENT_V1, one bet per physical event **per policy/cell**, chronological-first, flat 1u, DISPLAY_ODDS = 1/entry_price, OPEN != LOSS (OPEN excluded from PnL/ROI, counted in N_OPEN), exact-score and unresolved market types excluded from ordinary HOLD. MaxDD is chronological and is shown negative (closer to 0 is better).

Periods: AUG 2026-08-04..08-31 (28 d), SEP_EARLY 09-01..09-12 (12 d), SEP_LATE 09-13..09-24 (12 d), COMBINED 52 d. Historical capture limitations remain: sibling identities are never fabricated; unresolved sport/market rows are excluded fail-closed.

## Comparability warning

The five policies do **not** share one candidate universe: the live reference is restricted to moneyline/totals/spreads; P50_52/P50_54/ODDS_1_75_2_00 use all resolved non-exact-score families; P50 bands are entry [0.50,0.54)/[0.50,0.52) while 1.75-2.00 is entry (0.50,0.5714], so they overlap but are not nested (P50 includes entry == 0.50). Rankings below are therefore **factual attribution, not a like-for-like tournament**.

## Policy definitions (resolved from Git)

- **CURRENT_LIVE_FOOTBALL_REFERENCE** - football (canonical soccer, frozen denominator v2), entry_price in [0.50,0.54), market type in {moneyline, totals, spreads}, one bet per physical event, chronological-first, flat 1u, SELECTION_BEFORE_SETTLEMENT, OPEN keeps slot (not a loss)  
  Source: `p5052-p5054-c1-restored-lineage-audit-v2 / AUDIT_REPORT.json LIVE_POLICY_REPLAY.TOTAL`
- **CANDIDATE_V3_CONTROL** - CANDIDATE_V3_CONTRACT_A_NO_MOMENTUM (amended): soccer only; market type in allowed_fullmatch_{moneyline,spread,total} via lib/contur3/taxonomy.ts; Signal Score >= 65; entry price >= 0.30; 0 < minutes-to-start <= 1440; T-90 snapshot; esports excluded; one winner per physical event (highest score, earliest created_at, smallest identity).  
  Source: `candidate-v3-freeze-v1/CANDIDATE_V3_CONTRACT.json + candidate-v3-bounded-repair-v1/AMENDED_CANDIDATE_V3_CONTRACT.json`
- **P50_52** - football (canonical soccer, frozen denominator v2), ordinary HOLD (resolved non-exact-score market types), entry_price in [0.50,0.52), one bet per physical event, chronological-first, flat 1u, SELECTION_BEFORE_SETTLEMENT, OPEN keeps slot (not a loss)  
  Source: `p5052-p5054-c1-restored-lineage-audit-v2 / AUDIT_REPORT.json MODELS.P50_52`
- **P50_54** - football (canonical soccer, frozen denominator v2), ordinary HOLD (resolved non-exact-score market types), entry_price in [0.50,0.54), one bet per physical event, chronological-first, flat 1u, SELECTION_BEFORE_SETTLEMENT, OPEN keeps slot (not a loss)  
  Source: `p5052-p5054-c1-restored-lineage-audit-v2 / AUDIT_REPORT.json MODELS.P50_54`
- **ORDINARY_FOOTBALL_ODDS_1_75_2_00** - football (canonical soccer, frozen denominator v2), ordinary HOLD (resolved non-exact-score market types), DISPLAY_ODDS = 1/entry_price in [1.75,2.00) (entry_price in (0.50,0.5714]), one bet per physical event, chronological-first, flat 1u, SELECTION_BEFORE_SETTLEMENT, OPEN keeps slot (not a loss)  
  Source: `football-structural-authority-v2 / ODDS_GRID.<period>.1_75_2_00`

## Per-policy, per-period economics

| Model | Period | N_SEL | N_SET | N_OPEN | W | L | PnL_u | ROI_% | MaxDD_u | MeanDecOdds | MedDecOdds | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CURRENT_LIVE_FOOTBALL_REFERENCE | AUG | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| CURRENT_LIVE_FOOTBALL_REFERENCE | SEP_EARLY | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| CURRENT_LIVE_FOOTBALL_REFERENCE | SEP_LATE | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| CURRENT_LIVE_FOOTBALL_REFERENCE | COMBINED | 514 | 438 | 76 | 285 | 153 | 117.05 | 26.72 | -10.46 | 1.9452 | NC | MAIN_EVIDENCE |
| CANDIDATE_V3_CONTROL | AUG | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| CANDIDATE_V3_CONTROL | SEP_EARLY | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| CANDIDATE_V3_CONTROL | SEP_LATE | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| CANDIDATE_V3_CONTROL | COMBINED | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| P50_52 | AUG | 75 | 72 | 3 | 42 | 30 | 11.18 | 15.53 | -5.02 | 1.9841 | NC | PROMISING_SMALL_SAMPLE |
| P50_52 | SEP_EARLY | 50 | 44 | 6 | 20 | 24 | -4.14 | -9.4 | -10 | 1.9871 | NC | SMALL_SAMPLE |
| P50_52 | SEP_LATE | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| P50_52 | COMBINED | 476 | 416 | 60 | 266 | 150 | 110.05 | 26.45 | -14.57 | 1.9796 | NC | MAIN_EVIDENCE |
| P50_54 | AUG | 98 | 94 | 4 | 52 | 42 | 8.21 | 8.73 | -5.02 | 1.9641 | NC | PROMISING_SMALL_SAMPLE |
| P50_54 | SEP_EARLY | 71 | 64 | 7 | 31 | 33 | -3.22 | -5.03 | -11.46 | 1.9615 | NC | PROMISING_SMALL_SAMPLE |
| P50_54 | SEP_LATE | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC | NC |
| P50_54 | COMBINED | 637 | 554 | 83 | 335 | 219 | 100.25 | 18.1 | -11.46 | 1.9527 | NC | MAIN_EVIDENCE |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | AUG | 96 | 76 | 20 | 46 | 30 | 12.52 | 16.4716 | -6.5 | 1.913504 | 1.941748 | PROMISING_SMALL_SAMPLE |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | SEP_EARLY | 68 | 50 | 18 | 26 | 24 | -1.45 | -2.9079 | -8.65 | 1.869649 | 1.886792 | PROMISING_SMALL_SAMPLE |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | SEP_LATE | 562 | 440 | 122 | 295 | 145 | 124.15 | 28.2151 | -7.94 | 1.902427 | 1.923077 | MAIN_EVIDENCE |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | COMBINED | 726 | 566 | 160 | 367 | 199 | 135.21 | 23.8889 | -8.65 | 1.900822 | 1.923077 | MAIN_EVIDENCE |

Mean decimal odds are published as MEAN for P50_*/live (`AVG_DECIMAL_ODDS`, computed as mean of 1/entry) and as MEAN/MEDIAN display odds for ODDS_1_75_2_00; the table's MedDecOdds is `NC` for policies whose audit does not publish a median.

### P50 SEP_LATE sub-periods (as published, not merged)

| Model | Period | N_SEL | N_SET | N_OPEN | W | L | PnL_u | ROI_% | MaxDD_u | MeanDecOdds | MedDecOdds | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P50_52 | SEP_13_20 | 225 | 216 | 9 | 142 | 74 | 64.74 | 29.97 | -11.27 | 1.9781 | NC | MAIN_EVIDENCE |
| P50_52 | SEP_21_24 | 129 | 87 | 42 | 63 | 24 | 37.2 | 42.76 | -6.06 | 1.9766 | NC | PROMISING_SMALL_SAMPLE |
| P50_54 | SEP_13_20 | 305 | 289 | 16 | 179 | 110 | 60.56 | 20.96 | -7.31 | 1.9509 | NC | MAIN_EVIDENCE |
| P50_54 | SEP_21_24 | 171 | 115 | 56 | 78 | 37 | 36.26 | 31.53 | -7.22 | 1.945 | NC | MAIN_EVIDENCE |

Sum of the four published period rows differs from the COMBINED row (P50_52 selected 479 vs 476; P50_54 selected 645 vs 637) because each period is selected independently while COMBINED dedupes events across periods. This is shown, not smoothed.

## Supply and price descriptors

| Model | Period | Selected/calendar-day (N_SEL / days, exact) | ACTIVE_DAY_N | Mean bets/active day | Median bets/active day | P25/P75 bets/active day | Mean entry | Median entry |
|---|---|---|---|---|---|---|---|---|
| CURRENT_LIVE_FOOTBALL_REFERENCE | AUG | NC | NC | NC | NC | NC | NC | NC |
| CURRENT_LIVE_FOOTBALL_REFERENCE | SEP_EARLY | NC | NC | NC | NC | NC | NC | NC |
| CURRENT_LIVE_FOOTBALL_REFERENCE | SEP_LATE | NC | NC | NC | NC | NC | NC | NC |
| CURRENT_LIVE_FOOTBALL_REFERENCE | COMBINED | 9.8846 | NC | NC | NC | NC | 0.5143 | NC |
| CANDIDATE_V3_CONTROL | AUG | NC | NC | NC | NC | NC | NC | NC |
| CANDIDATE_V3_CONTROL | SEP_EARLY | NC | NC | NC | NC | NC | NC | NC |
| CANDIDATE_V3_CONTROL | SEP_LATE | NC | NC | NC | NC | NC | NC | NC |
| CANDIDATE_V3_CONTROL | COMBINED | NC | NC | NC | NC | NC | NC | NC |
| P50_52 | AUG | 2.6786 | NC | NC | NC | NC | 0.5041 | NC |
| P50_52 | SEP_EARLY | 4.1667 | NC | NC | NC | NC | 0.5033 | NC |
| P50_52 | SEP_LATE | NC | NC | NC | NC | NC | NC | NC |
| P50_52 | COMBINED | 9.1538 | NC | NC | NC | NC | 0.5052 | NC |
| P50_54 | AUG | 3.5 | NC | NC | NC | NC | 0.5094 | NC |
| P50_54 | SEP_EARLY | 5.9167 | NC | NC | NC | NC | 0.5101 | NC |
| P50_54 | SEP_LATE | NC | NC | NC | NC | NC | NC | NC |
| P50_54 | COMBINED | 12.25 | NC | NC | NC | NC | 0.5124 | NC |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | AUG | 3.4286 | NC | NC | NC | NC | NC | NC |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | SEP_EARLY | 5.6667 | NC | NC | NC | NC | NC | NC |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | SEP_LATE | 46.8333 | NC | NC | NC | NC | NC | NC |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | COMBINED | 13.9615 | NC | NC | NC | NC | NC | NC |

Only the ordinary-HOLD pool has committed active-day distributions (COMBINED: 45 active days of 52, mean 83.62/day, median 51, P25 7, P75 129 - a pooled figure, not any policy). Per-policy active-day, bets/day percentiles and median entry price require per-day rows that the bounded-read contract does not allow, so they are `NC`.

## Core Pareto set (COMBINED; PnL, ROI, MaxDD, selected per calendar day)

Models with all four COMBINED metrics: CURRENT_LIVE_FOOTBALL_REFERENCE, ORDINARY_FOOTBALL_ODDS_1_75_2_00, P50_52, P50_54. CANDIDATE_V3_CONTROL is excluded (`CONTROL_NOT_HISTORICALLY_COMPARABLE`).

| Model | PnL_u | ROI_% | MaxDD_u | Sel/cal-day | Dominated by |
|---|---|---|---|---|---|
| CURRENT_LIVE_FOOTBALL_REFERENCE | 117.05 | 26.72 | -10.46 | 9.8846 | - |
| ORDINARY_FOOTBALL_ODDS_1_75_2_00 | 135.21 | 23.8889 | -8.65 | 13.9615 | - |
| P50_52 | 110.05 | 26.45 | -14.57 | 9.1538 | CURRENT_LIVE_FOOTBALL_REFERENCE |
| P50_54 | 100.25 | 18.1 | -11.46 | 12.25 | ORDINARY_FOOTBALL_ODDS_1_75_2_00 |

**CORE_PARETO_SET = {CURRENT_LIVE_FOOTBALL_REFERENCE, ORDINARY_FOOTBALL_ODDS_1_75_2_00}** (not dominated on all four metrics by any other comparable model). Pareto membership is a descriptive statement across differing universes, not a promotion.

## Period stability (concentration and price-implied diagnostic)

| Model | Period | PnL_u | Hit_% | Mean entry | z(hit vs mean entry) |
|---|---|---|---|---|---|
| P50_52 | SEP_13_20 | 64.74 | 65.74 | 0.5056 | 4.46 |
| P50_52 | SEP_21_24 | 37.2 | 72.41 | 0.506 | 4.07 |
| P50_52 | AUG | 11.18 | 58.33 | 0.5041 | 1.34 |
| P50_52 | SEP_EARLY | -4.14 | 45.45 | 0.5033 | -0.65 |
| P50_52 | COMBINED | 110.05 | 63.94 | 0.5052 | 5.48 |
| P50_54 | SEP_13_20 | 60.56 | 61.94 | 0.5129 | 3.62 |
| P50_54 | SEP_21_24 | 36.26 | 67.83 | 0.5144 | 3.52 |
| P50_54 | AUG | 8.21 | 55.32 | 0.5094 | 0.85 |
| P50_54 | SEP_EARLY | -3.22 | 48.44 | 0.5101 | -0.41 |
| P50_54 | COMBINED | 100.25 | 60.47 | 0.5124 | 4.35 |
| CURRENT_LIVE_FOOTBALL_REFERENCE | COMBINED | 117.05 | 65.07 | 0.5143 | 5.71 |

- ODDS_1_75_2_00: AUG +12.52u, SEP_EARLY -1.45u, SEP_LATE +124.15u - SEP_LATE carries 91.8% of period-sum PnL. Its SEP_LATE hit rate is 67.05% at mean display odds 1.902427 (mean-odds figure, so no exact z is computed).
- P50_52 / P50_54 / live reference: every band near entry 0.50 shows hit rates far above price-implied probability from Sep13 onward (z column, mean entry from the audit; hit rate uses settled bets only). SEP_EARLY is negative for both P50 bands. **Sep13+ outperformance across every 0.50-band cell is a stability flag, not a confirmation**: it needs production forward confirmation before any freeze, and the settled-only denominator excludes 42-56 OPEN bets in SEP_21_24.

## Reconciliation of required leads

| Lead | Status |
|---|---|
| P50_52 | Defined and reported (audit v2), COMBINED +110.05u / ROI 26.45% / MaxDD -14.57; dominated by the live reference on all four combined metrics; SEP_LATE not mergeable (sub-periods preserved) |
| P50_54 | Defined and reported (audit v2), COMBINED +100.25u / ROI 18.10% / MaxDD -11.46; dominated by ODDS_1_75_2_00; SEP_LATE not mergeable |
| football odds 1.75-2.00 | Defined and reported for all four periods (structural authority); largest PnL and lowest MaxDD of the comparable set; 91.8% of period-sum PnL sits in SEP_LATE |
| moneyline / spreads / totals | Reported as family cohort (see FOOTBALL_MARKET_FAMILY_COHORT.md); live-band family cells also reported |
| total_corners / other_structured / exact_score | Reported as family cohort with period splits; exact_score kept outside ordinary HOLD |
| Candidate V3 control | CONTROL_NOT_HISTORICALLY_COMPARABLE (see policy row); not the champion by construction |

## Not comparable from canonical aggregates (explicit list)

- Per-period AUG / SEP_EARLY / SEP_LATE for CURRENT_LIVE_FOOTBALL_REFERENCE.
- Exact SEP_LATE (09-13..09-24) row for P50_52 and P50_54.
- Any Candidate V3 historical PnL/ROI/MaxDD/supply.
- Per-policy ACTIVE_DAY_N, mean/median/P25/P75 bets per active day, median entry price, and median decimal odds for P50_*/live (only the pooled ordinary-HOLD daily distribution and mean values are committed).

Why: the clone accepts neither SQL (Supabase MCP denied for project nppznoujvnyjargjkmnv) nor PostgREST aggregates (`PGRST123`), and the exact selection/MaxDD semantics live in the client engine that needs the full 75,743-row corpus. Reading it was not authorised (cap 200 raw rows), and re-implementing settlement in SQL was excluded.

