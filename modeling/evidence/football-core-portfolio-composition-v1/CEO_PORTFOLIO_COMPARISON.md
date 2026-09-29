# Football CORE portfolio composition (FOOTBALL_DENOMINATOR_V2_2026-08-04_2026-09-24, 52 days)

Flat 1u. WIN = 1/entry_price - 1, LOSS = -1, OPEN = no PnL. One bet per physical event. Priority is applied before settlement.

## Portfolios
| Portfolio | Selected | Settled | Open | Wins | Losses | PnL u | ROI % | MaxDD u | Bets/day |
|---|---|---|---|---|---|---|---|---|---|
| CORE_A alone | 1386 | 988 | 398 | 595 | 393 | +178.31 | 18.05 | -12.48 | 26.65 |
| CORE_B alone | 726 | 566 | 160 | 367 | 199 | +135.21 | 23.89 | -8.65 | 13.96 |
| A_THEN_B | 1564 | 1113 | 451 | 670 | 443 | +188.71 | 16.96 | -14.80 | 30.08 |
| B_THEN_A | 1564 | 1079 | 485 | 669 | 410 | +218.19 | 20.22 | -11.41 | 30.08 |

## Overlap
A 1386 / B 726; overlap 548 (same identity 446, different 102); A-only 838; B-only 178; union 1564. Naive no-overlap ceiling 2112 selected / +313.52u.

## Incremental contribution
- A_THEN_B, B adds: selected 178, settled 125, open 53, PnL +10.41u. Delta vs A: PnL +10.40u, ROI -1.09pp, MaxDD -2.32u.
- B_THEN_A, A adds: selected 838, settled 513, open 325, PnL +82.98u. Delta vs B: PnL +82.98u, ROI -3.67pp, MaxDD -2.76u.

## Period diagnostics (fixed strategies, no optimization)
| Set | Period | Settled | PnL u | ROI % | MaxDD u |
|---|---|---|---|---|---|
| CORE_A | AUG | 92 | +8.29 | 9.01 | -5.02 |
| CORE_A | SEP_1_12 | 500 | +74.76 | 14.95 | -12.48 |
| CORE_A | SEP_13_24 | 396 | +95.26 | 24.06 | -7.31 |
| CORE_B | AUG | 76 | +12.52 | 16.47 | -6.50 |
| CORE_B | SEP_1_12 | 50 | -1.45 | -2.91 | -8.65 |
| CORE_B | SEP_13_24 | 440 | +124.15 | 28.22 | -7.94 |
| A_THEN_B | AUG | 105 | +10.04 | 9.56 | -5.02 |
| A_THEN_B | SEP_1_12 | 515 | +77.53 | 15.05 | -11.41 |
| A_THEN_B | SEP_13_24 | 493 | +101.15 | 20.52 | -12.88 |
| B_THEN_A | AUG | 96 | +16.52 | 17.21 | -4.02 |
| B_THEN_A | SEP_1_12 | 513 | +77.53 | 15.11 | -11.41 |
| B_THEN_A | SEP_13_24 | 470 | +124.15 | 26.41 | -7.94 |

Primary PnL-max portfolio: **B_THEN_A** (+218.19u).
