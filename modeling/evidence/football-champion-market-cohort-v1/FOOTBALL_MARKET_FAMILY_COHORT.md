# FOOTBALL_MARKET_FAMILY_COHORT - Aug04..Sep24

Status: **HISTORICAL_REFERENCE_PNL / NOT_EXECUTION_AUTHORITY / ATTRIBUTION ONLY**. Each family is evaluated independently with at most one economic bet per physical event; family rows are **not** a portfolio and must not be summed.

`NC` = `NOT_COMPARABLE_FROM_CANONICAL_AGGREGATES`. Server-side GROUP BY was not reachable (Supabase MCP denied for the clone; PostgREST aggregates disabled; no aggregate RPC), so only committed aggregates are used; nothing is estimated.

Evidence status: N_SETTLED >= 100 MAIN_EVIDENCE; 50-99 PROMISING_SMALL_SAMPLE; < 50 SMALL_SAMPLE. All rows are kept; small cells are not promoted.

## Canonical families (structural authority buckets)

| Family | Period | N_SEL | N_SET | N_OPEN | W | L | PnL_u | ROI_% | MaxDD_u | MeanDecOdds | MedDecOdds | Sel/cal-day | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| moneyline | AUG | 174 | 158 | 16 | 78 | 80 | 30.89 | 19.5476 | -10.53 | 3.978873 | 2.298851 | 6.2143 | MAIN_EVIDENCE |
| moneyline | SEP_EARLY | 649 | 402 | 247 | 161 | 241 | -15.26 | -3.7972 | -39.78 | 2.557822 | 2.325581 | 54.0833 | MAIN_EVIDENCE |
| moneyline | SEP_LATE | 719 | 442 | 277 | 129 | 313 | 6.18 | 1.3976 | -25.75 | 3.563538 | 3.773585 | 59.9167 | MAIN_EVIDENCE |
| moneyline | COMBINED | 1536 | 996 | 540 | 364 | 632 | 18.39 | 1.8463 | -50.53 | 3.190479 | 2.702703 | 29.5385 | MAIN_EVIDENCE |
| totals | AUG | 208 | 193 | 15 | 90 | 103 | 20.22 | 10.4786 | -15.67 | 3.251223 | 2.298851 | 7.4286 | MAIN_EVIDENCE |
| totals | SEP_EARLY | 626 | 408 | 218 | 153 | 255 | -37.4 | -9.1666 | -59.9 | 2.463707 | 2.247191 | 52.1667 | MAIN_EVIDENCE |
| totals | SEP_LATE | 582 | 387 | 195 | 133 | 254 | 1.87 | 0.4827 | -41.93 | 3.501177 | 3.921569 | 48.5 | MAIN_EVIDENCE |
| totals | COMBINED | 1415 | 987 | 428 | 376 | 611 | -14.31 | -1.4497 | -59.9 | 3.006206 | 2.409639 | 27.2115 | MAIN_EVIDENCE |
| spreads | AUG | 75 | 64 | 11 | 21 | 43 | -7.01 | -10.9594 | -12.5 | 5.204793 | 2.898551 | 2.6786 | PROMISING_SMALL_SAMPLE |
| spreads | SEP_EARLY | 289 | 180 | 109 | 55 | 125 | -25.64 | -14.2417 | -39.6 | 2.818468 | 2.380952 | 24.0833 | MAIN_EVIDENCE |
| spreads | SEP_LATE | 534 | 323 | 211 | 116 | 207 | -0.48 | -0.1491 | -60.49 | 3.284357 | 3.278689 | 44.5 | MAIN_EVIDENCE |
| spreads | COMBINED | 897 | 567 | 330 | 192 | 375 | -33.13 | -5.8432 | -92.39 | 3.295864 | 3.030303 | 17.25 | MAIN_EVIDENCE |
| total_corners | AUG | 29 | 22 | 7 | 9 | 13 | 2.15 | 9.7862 | -4 | 2.521904 | 2.272727 | 1.0357 | SMALL_SAMPLE |
| total_corners | SEP_EARLY | 138 | 70 | 68 | 30 | 40 | 0.86 | 1.2238 | -8.43 | 2.345199 | 2.272727 | 11.5 | PROMISING_SMALL_SAMPLE |
| total_corners | SEP_LATE | 170 | 124 | 46 | 61 | 63 | 14.77 | 11.9127 | -11.25 | 2.259372 | 2.173913 | 14.1667 | MAIN_EVIDENCE |
| total_corners | COMBINED | 336 | 215 | 121 | 100 | 115 | 18.78 | 8.7355 | -11.25 | 2.317869 | 2.222222 | 6.4615 | MAIN_EVIDENCE |
| other_structured | AUG | 229 | 163 | 66 | 56 | 107 | 4.06 | 2.4931 | -16.1 | 3.420843 | 2.702703 | 8.1786 | MAIN_EVIDENCE |
| other_structured | SEP_EARLY | 674 | 378 | 296 | 147 | 231 | 23.46 | 6.2056 | -26.19 | 2.781254 | 2.597403 | 56.1667 | MAIN_EVIDENCE |
| other_structured | SEP_LATE | 274 | 212 | 62 | 72 | 140 | -29.27 | -13.8088 | -42.62 | 2.658144 | 2.272727 | 22.8333 | MAIN_EVIDENCE |
| other_structured | COMBINED | 1174 | 751 | 423 | 274 | 477 | -3.68 | -0.4894 | -42.62 | 2.875624 | 2.531646 | 22.5769 | MAIN_EVIDENCE |
| soccer_exact_score | AUG | 34 | 19 | 15 | 2 | 17 | -13.49 | -71.0065 | -15 | 49.911678 | 47.619048 | 1.2143 | SMALL_SAMPLE |
| soccer_exact_score | SEP_EARLY | 7 | 3 | 4 | 0 | 3 | -3 | -100 | -3 | 3.691239 | 3.703704 | 0.5833 | SMALL_SAMPLE |
| soccer_exact_score | SEP_LATE | 9 | 6 | 3 | 1 | 5 | -3.92 | -65.2778 | -3.92 | 2.825396 | 2.105263 | 0.75 | SMALL_SAMPLE |
| soccer_exact_score | COMBINED | 50 | 28 | 22 | 3 | 25 | -20.41 | -72.8853 | -20.41 | 34.965286 | 4.545455 | 0.9615 | SMALL_SAMPLE |
| UNRESOLVED_MARKET_TYPE | AUG | 55 | 53 | 2 | 14 | 39 | 11.63 | 21.9392 | -10 | 4.500984 | 4.545455 | 1.9643 | PROMISING_SMALL_SAMPLE |
| UNRESOLVED_MARKET_TYPE | SEP_EARLY | 1656 | 810 | 846 | 266 | 544 | -159.39 | -19.6782 | -161.65 | 2.799235 | 2.272727 | 138.0 | MAIN_EVIDENCE |
| UNRESOLVED_MARKET_TYPE | SEP_LATE | 5 | 4 | 1 | 0 | 4 | -4 | -100 | -4 | 3.632865 | 3.636364 | 0.4167 | SMALL_SAMPLE |
| UNRESOLVED_MARKET_TYPE | COMBINED | 1716 | 867 | 849 | 280 | 587 | -151.77 | -17.5047 | -168.68 | 2.856207 | 2.298851 | 33.0 | MAIN_EVIDENCE |

MEAN/MEDIAN_ENTRY_PRICE, ACTIVE_DAY_N and bets-per-active-day statistics per family are `NC` (not in the structural authority). `UNRESOLVED_MARKET_TYPE` is a fail-closed diagnostic bucket, excluded from ordinary HOLD and from every leader list below. `soccer_exact_score` is kept outside ordinary HOLD.

## other_structured: which families are actually present

The structural authority folds every type outside {moneyline, totals, spreads, total_corners, soccer_exact_score} into `other_structured`. The frozen overlay (Git artifact, no prices/settlement) lists the actual types. Events-present is a **presence census**, not N_SELECTED and not economics; economics per sub-family are `NC` because no committed aggregate splits them.

| Market type (as named in overlay) | Structural bucket | AUG events | SEP_EARLY events | SEP_LATE events | COMBINED events | Economics |
|---|---|---|---|---|---|---|
| UNRESOLVED | UNRESOLVED_MARKET_TYPE | 55 | 1656 | 5 | 1716 | NC |
| moneyline | moneyline | 174 | 649 | 719 | 1536 | NC |
| totals | totals | 208 | 626 | 582 | 1415 | NC |
| spreads | spreads | 75 | 289 | 534 | 897 | NC |
| soccer_halftime_result | other_structured | 68 | 373 | 85 | 524 | NC |
| total_corners | total_corners | 29 | 138 | 170 | 336 | NC |
| first_half_totals | other_structured | 41 | 131 | 16 | 187 | NC |
| both_teams_to_score | other_structured | 20 | 94 | 20 | 134 | NC |
| soccer_team_total_corners | other_structured | 16 | 23 | 89 | 128 | NC |
| soccer_first_half_total_corners | other_structured | 13 | 31 | 41 | 85 | NC |
| soccer_team_totals | other_structured | 29 | 43 | 2 | 74 | NC |
| soccer_exact_score | soccer_exact_score | 34 | 7 | 9 | 50 | NC |
| soccer_first_to_score | other_structured | 27 | 21 | 0 | 48 | NC |
| second_half_moneyline | other_structured | 12 | 0 | 26 | 38 | NC |
| soccer_second_half_result | other_structured | 29 | 2 | 0 | 31 | NC |
| soccer_second_half_team_totals | other_structured | 19 | 0 | 0 | 19 | NC |
| both_teams_to_score_first_half | other_structured | 10 | 5 | 2 | 17 | NC |
| second_half_totals | other_structured | 17 | 0 | 0 | 17 | NC |
| soccer_first_half_team_totals | other_structured | 14 | 3 | 0 | 17 | NC |
| soccer_game_corners_odd_even | other_structured | 6 | 0 | 8 | 14 | NC |
| both_teams_to_score_second_half | other_structured | 11 | 0 | 0 | 11 | NC |
| soccer_second_half_total_corners | other_structured | 11 | 0 | 0 | 11 | NC |
| anytime_touchdowns | other_structured | 0 | 0 | 10 | 10 | NC |
| soccer_first_corner | other_structured | 9 | 0 | 1 | 10 | NC |
| soccer_anytime_goalscorer | other_structured | 0 | 1 | 6 | 7 | NC |
| first_half_moneyline | other_structured | 4 | 1 | 0 | 5 | NC |
| first_half_spreads | other_structured | 2 | 2 | 0 | 4 | NC |
| soccer_penalty_shootout | other_structured | 0 | 4 | 0 | 4 | NC |
| receptions | other_structured | 0 | 0 | 3 | 3 | NC |
| soccer_first_half_exact_score | other_structured | 0 | 2 | 0 | 2 | NC |
| q1_moneyline | other_structured | 0 | 1 | 0 | 1 | NC |
| receiving_yards | other_structured | 0 | 0 | 1 | 1 | NC |
| soccer_team_to_advance | other_structured | 1 | 0 | 0 | 1 | NC |
| team_totals | other_structured | 1 | 0 | 0 | 1 | NC |
| two_plus_touchdowns | other_structured | 0 | 0 | 1 | 1 | NC |

Census validation: distinct events per bucket equal the structural N_SELECTED for all six named buckets and `other_structured` in every period: **True**.

Expected family names from the mission versus names actually present (exact-name test only; no merging, no invented families):

| Expected name | Present under exact name |
|---|---|
| moneyline | yes |
| spreads | yes |
| totals | yes |
| total_corners | yes |
| team_totals | yes |
| first_half_totals | yes |
| second_half_totals | yes |
| first_half_team_totals | no (exact name) |
| second_half_team_totals | no (exact name) |
| halftime_result | no (exact name) |
| second_half_result | no (exact name) |
| both_teams_to_score | yes |
| first_half_btts | no (exact name) |
| second_half_btts | no (exact name) |
| first_to_score | no (exact name) |
| exact_score | no (exact name) |
| other_structured | yes |

`other_structured` is the structural bucket, not an overlay market type. `first_half_btts` / `second_half_btts` exist only as `both_teams_to_score_first_half` / `both_teams_to_score_second_half`; `halftime_result`, `second_half_result`, `first_to_score`, `exact_score` exist only with a `soccer_` prefix.

**Data-quality flag:** market types anytime_touchdowns, receptions, two_plus_touchdowns, receiving_yards, q1_moneyline appear inside the canonical soccer denominator (a few events each, all in other_structured). They look non-football; they are reported, not dropped, and should be reviewed in the denominator lineage before any sleeve uses other_structured.

## Odds x market family

Committed family x odds aggregates exist for **two cells only** (COMBINED, no period split). Every other family x odds x period cell is `NC`; whether those cells are empty is unknown. No new band was searched or optimised.

| Family | Odds cell | N_SEL | N_SET | PnL_u | ROI_% | MaxDD_u | Evidence |
|---|---|---|---|---|---|---|---|
| other_structured | 2.25-2.50 | 285 | 169 | 15.84 | 9.3737 | -11.58 | MAIN_EVIDENCE |
| total_corners | 2.25-2.50 | 118 | 77 | 22.78 | 29.5894 | -7 | PROMISING_SMALL_SAMPLE |

These two cells were pre-specified in the earlier structural mission, not derived here; they are still post-hoc relative to that mission's outputs and need forward confirmation.

### Pooled ordinary-HOLD odds attribution (all resolved non-exact families together, COMBINED)

| Odds | N_SEL | N_SET | PnL_u | ROI_% | MaxDD_u | Evidence |
|---|---|---|---|---|---|---|
| <1.35 | 55 | 29 | -1.93 | -6.6539 | -2.86 | SMALL_SAMPLE |
| 1.35-1.50 | 530 | 327 | 15.05 | 4.6016 | -9.36 | MAIN_EVIDENCE |
| 1.50-1.75 | 482 | 304 | 7.06 | 2.3222 | -9.56 | MAIN_EVIDENCE |
| 1.75-2.00 | 726 | 566 | 135.21 | 23.8889 | -8.65 | MAIN_EVIDENCE |
| 2.00-2.25 | 1896 | 1270 | -106.48 | -8.3844 | -115.09 | MAIN_EVIDENCE |
| 2.25-2.50 | 1226 | 803 | 20.68 | 2.5756 | -32.72 | MAIN_EVIDENCE |
| 2.50-3.00 | 1105 | 675 | 4.52 | 0.6693 | -48.7 | MAIN_EVIDENCE |
| 3.00-4.00 | 1252 | 783 | -6.46 | -0.8256 | -67.18 | MAIN_EVIDENCE |
| 4.00-5.00 | 728 | 482 | -8.57 | -1.7788 | -56.9 | MAIN_EVIDENCE |
| 5.00+ | 135 | 74 | 23.74 | 32.0855 | -12 | PROMISING_SMALL_SAMPLE |

Per-period pooled cells are in FOOTBALL_MARKET_ODDS_COHORT.json (`POOLED_ODDS_ATTRIBUTION`).

### Live-band family cells (entry [0.50,0.54), COMBINED)

| Family | N_SEL | N_SET | N_OPEN | W | L | PnL_u | ROI_% | MaxDD_u | Mean entry | z(hit vs entry) | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|
| moneyline | 191 | 158 | 33 | 92 | 66 | 19.21 | 12.16 | -6.43 | 0.5192 | 1.59 | MAIN_EVIDENCE |
| totals | 234 | 189 | 45 | 105 | 84 | 15.04 | 7.96 | -8.55 | 0.5152 | 1.11 | MAIN_EVIDENCE |
| spreads | 250 | 201 | 49 | 165 | 36 | 122.14 | 60.77 | -6 | 0.5115 | 8.78 | MAIN_EVIDENCE |

**Anomaly flag:** spreads in this band show 165W/36L (hit 82.09%) at mean entry 0.5115 (z = 8.78), whereas spreads over all prices are -33.13u / ROI -5.8432%. A hit rate this far from price-implied needs a lineage/settlement audit before spreads are treated as a sleeve. Family cells here are independent (their PnLs do not sum to the live TOTAL).

## Leader tables (from committed aggregates only)

**MAIN_EVIDENCE families (COMBINED N_SETTLED >= 100, ordinary or diagnostic):**

| Family | N_SET | PnL_u | ROI_% | MaxDD_u | Evidence |
|---|---|---|---|---|---|
| moneyline | 996 | 18.39 | 1.8463 | -50.53 | MAIN_EVIDENCE |
| totals | 987 | -14.31 | -1.4497 | -59.9 | MAIN_EVIDENCE |
| spreads | 567 | -33.13 | -5.8432 | -92.39 | MAIN_EVIDENCE |
| total_corners | 215 | 18.78 | 8.7355 | -11.25 | MAIN_EVIDENCE |
| other_structured | 751 | -3.68 | -0.4894 | -42.62 | MAIN_EVIDENCE |
| UNRESOLVED_MARKET_TYPE | 867 | -151.77 | -17.5047 | -168.68 | MAIN_EVIDENCE |

**Positive-PnL families in COMBINED** (attribution only, not a sleeve decision): moneyline (+18.39u, ROI 1.8463%), total_corners (+18.78u, ROI 8.7355%). Canonical families with positive PnL in all three periods: total_corners. total_corners: AUG +2.15u on 22 settled (SMALL_SAMPLE), SEP_EARLY +0.86u on 70 (PROMISING_SMALL_SAMPLE), SEP_LATE +14.77u on 124 (MAIN_EVIDENCE), COMBINED MaxDD -11.25u. moneyline COMBINED +18.39u / ROI 1.8463% with MaxDD -50.53u and SEP_EARLY -15.26u.

**PROMISING_SMALL_SAMPLE cells:** total_corners SEP_EARLY (70 settled); 2.25-2.50 x total_corners COMBINED (77 settled, +22.78u, ROI 29.59%, MaxDD -7.0u).

**Negative families (COMBINED):** totals (-14.31u, ROI -1.4497%, N_SET 987), spreads (-33.13u, ROI -5.8432%, N_SET 567), other_structured (-3.68u, ROI -0.4894%, N_SET 751), soccer_exact_score (-20.41u, ROI -72.8853%, N_SET 28), UNRESOLVED_MARKET_TYPE (-151.77u, ROI -17.5047%, N_SET 867).

## Not comparable from canonical aggregates (explicit list)

- Economics for every individual other_structured sub-family (team_totals, first/second-half totals, BTTS variants, halftime/second-half result, first_to_score, corner variants, ...).
- Every family x odds x period cell other than the two committed COMBINED cells.
- Per-family ACTIVE_DAY_N, mean/median bets per active day, mean/median entry price.

