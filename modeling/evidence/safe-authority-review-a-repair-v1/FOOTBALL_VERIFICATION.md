# Football Verification — Review A Repair V1

PNL_CLASS: `REFERENCE_PNL` (display price) — `NOT_EXECUTION_AUTHORITY`.
Unresolved rows mean final realised historical PnL is **not yet closed**.
`PRICE_INDEPENDENT_ALPHA_PROVEN=NO` (no execution-price evidence exists here — display-price reference only).

Frozen football denominator (canonical, combined Aug+Sep, unchanged by this note): **4694** physical events (modeling/evidence/football-denominator-reconciliation-v1).

Exact Score excluded before physical-event selection and cap: 822 candidates. EXACT_SCORE_SELECTED_N = **0**.

Football-only subset of the SAFE UNCAPPED price-band selection (reconciled fail-closed sport; denominator-style, no cap):

## P50_52_SAFE (football only)
| Period | N | Terminal | Unresolved (by status) | Reference PnL | Terminal ROI | MaxDD |
|---|---|---|---|---|---|---|
| Aug | 74 | 71 | 3 (OPEN=3) | 12.18u | 17.15% | -5.02u |
| Sep | 941 | 645 | 296 (OPEN=296) | 119.61u | 18.54% | -14.69u |
| Combined | 1015 | 716 | 299 (OPEN=299) | 131.79u | 18.41% | -14.69u |

## P50_54_SAFE (football only)
| Period | N | Terminal | Unresolved (by status) | Reference PnL | Terminal ROI | MaxDD |
|---|---|---|---|---|---|---|
| Aug | 96 | 92 | 4 (OPEN=4) | 8.29u | 9.01% | -5.02u |
| Sep | 1127 | 789 | 338 (OPEN=338) | 135.32u | 17.15% | -12.48u |
| Combined | 1223 | 881 | 342 (OPEN=342) | 143.61u | 16.3% | -12.48u |

## Discrepancy vs. independent DB cross-check

An independent architect DB cross-check reported P50_52 combined N=1016, terminal=671, unresolved=345, reference PnL ~+122.89u, terminal ROI ~+18.31%, MaxDD ~-13.55u; P50_54 combined N=1225, terminal=824, unresolved=401, reference PnL ~+144.65u, terminal ROI ~+17.55%, MaxDD ~-12.65u. The canonical repaired-runner output above (P50_52 combined N=1015, terminal=716, unresolved=299; P50_54 combined N=1223, terminal=881, unresolved=342) is the authority for this note — N matches within 1-2 events but terminal/unresolved and PnL/MaxDD diverge (runner shows materially fewer terminal, more unresolved). This divergence is unexplained and unresolved by this mission (evidence persistence only, no new hypothesis search); it is flagged here for Review A2, not adjudicated.

Source: scripts/modeling/football-verification-review-a.ts (canonical repaired runner primitives, reused verbatim). Raw data: FOOTBALL_VERIFICATION_DATA.json.
