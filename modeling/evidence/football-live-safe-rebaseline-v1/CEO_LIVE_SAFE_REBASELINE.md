# Football live-safe rebaseline (FOOTBALL_DENOMINATOR_V2_2026-08-04_2026-09-24, 52 days)

Flat 1u. WIN = 1/entry_price - 1, LOSS = -1, OPEN = no PnL. One bet per physical event. Priority applied before settlement. Market class = canonical `marketBucketOf` (no title/slug inference). Historical B and the research portfolio B_THEN_A remain RESEARCH authority and are not overwritten.

## Historical B market composition (FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200; diagnostic)
| Class | Selected | Settled | Open | PnL u | ROI % |
|---|---|---|---|---|---|
| MONEYLINE | 218 | 158 | 60 | +17.77 | 11.25 |
| TOTALS | 229 | 186 | 43 | +10.81 | 5.81 |
| SPREADS | 189 | 150 | 39 | +97.89 | 65.26 |
| TOTAL_CORNERS | 7 | 5 | 2 | +0.61 | 12.29 |
| OTHER_STRUCTURED | 83 | 67 | 16 | +8.14 | 12.14 |

Total selected 726, PnL +135.21u. (The 118 total-corners figure belongs to FOOTBALL_TOTAL_CORNERS_ODDS_225_250 at odds 2.25-2.50, not to B.)

## Strategies
| Strategy | Selected | Settled | Open | Wins | Losses | PnL u | ROI % | MaxDD u | Bets/day |
|---|---|---|---|---|---|---|---|---|---|
| HISTORICAL_B (research) | 726 | 566 | 160 | 367 | 199 | +135.21 | 23.89 | -8.65 | 13.96 |
| FOOTBALL_LIVE_MLTS_ODDS_175_200 | 644 | 496 | 148 | 327 | 169 | +128.31 | 25.87 | -8.65 | 12.38 |
| FOOTBALL_MONEYLINE_TOTALS_SPREADS_ODDS_185_200 | 514 | 438 | 76 | 285 | 153 | +117.05 | 26.72 | -10.46 | 9.88 |
| FOOTBALL_LIVE_MLTS_175_200_THEN_MLTS_185_200 | 674 | 524 | 150 | 346 | 178 | +138.31 | 26.39 | -9.46 | 12.96 |

## Overlap and fallback increment
LIVE_B 644 / fallback 514; OVERLAP_PHYSICAL_EVENT_N 484 (SAME_IDENTITY_N 425, DIFFERENT_IDENTITY_N 59); fallback dropped 484.
FALLBACK_INCREMENTAL: selected 30, settled 28, open 2, PnL +10.00u.

## Value loss / retention (LIVE_B vs historical B)
HISTORICAL_B_PNL_U 135.21; LIVE_B_PNL_U +128.31; DELTA_PNL_U -6.90; PNL_RETENTION_PCT 94.9.
HISTORICAL_B_SELECTED_N 726; LIVE_B_SELECTED_N 644; SELECTED_RETENTION_PCT 88.71.

Historical-B events whose selected identity was in a non-live class:
| Class | Events | Settled | Winning identities | Losing identities | Open | Re-claimed by LIVE_B (other identity) | Not claimed by LIVE_B |
|---|---|---|---|---|---|---|---|
| TOTAL_CORNERS | 7 | 5 | 3 | 2 | 2 | 0 | 7 |
| OTHER_STRUCTURED | 83 | 67 | 39 | 28 | 16 | 8 | 75 |

## Period diagnostics (fixed strategies, no optimization)
| Set | Period | Settled | PnL u | ROI % | MaxDD u |
|---|---|---|---|---|---|
| LIVE_B | AUG | 8 | +5.59 | 69.93 | -1.00 |
| LIVE_B | SEP_1_12 | 48 | -1.43 | -2.99 | -8.65 |
| LIVE_B | SEP_13_24 | 440 | +124.15 | 28.22 | -7.94 |
| LIVE_SAFE_PORTFOLIO | AUG | 11 | +8.59 | 78.13 | -1.00 |
| LIVE_SAFE_PORTFOLIO | SEP_1_12 | 62 | +2.57 | 4.14 | -9.46 |
| LIVE_SAFE_PORTFOLIO | SEP_13_24 | 451 | +127.15 | 28.19 | -7.94 |

Predicate parity: decimal-odds form vs (0.50 < p <= 4/7) mismatches on the structural corpus: 0.
