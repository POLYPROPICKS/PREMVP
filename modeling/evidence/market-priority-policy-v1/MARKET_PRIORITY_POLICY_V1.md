# MARKET_PRIORITY_POLICY_V1 — FOUNDER_ACCEPTED_CONCRETE_MARKET_PRIORITY_V1

## Founder-accepted concrete market priority V1 (authoritative)
Status: FOUNDER_ACCEPTED_CONCRETE_MARKET_PRIORITY_V1. Supersedes the earlier Founder-facing interpretation below; artifact/guide correction only (no DB query, no modeling rerun, no selector/runner change).

| # | Market | Odds band | Settled | W/L | P&L u | ROI % | MaxDD u | Flag |
|---|---|---|---|---|---|---|---|---|
| 1 | SPREADS / ФОРЫ | 1.85-2.00 | 246 | 197/49 | +139.69 | 56.79 | -5.00 | AUDIT_REQUIRED |
| 2 | TOTAL_CORNERS / ТОТАЛ УГЛОВЫХ | 2.25-2.50 | 117 | 59/58 | +22.64 | 19.35 | -7.00 |  |
| 3 | MONEYLINE / ПОБЕДИТЕЛЬ | 1.85-2.00 | 158 | 89/69 | +13.85 | 8.77 | -5.50 |  |
| 4 | TOTALS / ТОТАЛ ГОЛОВ | 1.85-2.00 | 167 | 90/77 | +8.16 | 4.89 | -9.28 |  |

Final order: 1) SPREADS / ФОРЫ → 2) TOTAL_CORNERS / ТОТАЛ УГЛОВЫХ → 3) MONEYLINE / ПОБЕДИТЕЛЬ → 4) TOTALS / ТОТАЛ ГОЛОВ.

### Policy semantics
For one reserved physical football match:
SPREADS 1.85-2.00
→ else TOTAL_CORNERS 2.25-2.50
→ else MONEYLINE 1.85-2.00
→ else TOTALS 1.85-2.00
→ else SKIP / existing fallback outside this policy. One physical match = maximum one economic bet. Tie-break inside the chosen market: existing canonical deterministic tie-break. Settlement/outcome is never used to choose.

### Terminology
SAFE, ORDINARY STRUCTURED and WINNER+TOTALS+SPREADS are removed from the priority ORDER: they are filters/baskets/portfolio strategies, not concrete market classes.
- SAFE = eligibility/filter layer, not a market.
- ordinary structured = umbrella basket, not a market.
- winner+totals+spreads = combined portfolio, not a market.
- other_structured = observation-only catch-all until a concrete subtype has sufficient evidence.

---
## Secondary research evidence — previous same-event experiment (does NOT override the guide above)
Original title/status: MARKET_PRIORITY_POLICY_V1 — NOT_BETTER_THAN_CURRENT_BASELINE. Its "TOTALS > MONEYLINE > SPREADS" frozen order was a re-test hypothesis only and is not the Founder guide.
Evidence: 2026-08-04..2026-09-25 (sliced from cached read; no new DB scan). Unique physical events in choice set: 4364. Saturated GSP conditions 5, excluded events 1.

Frozen ordered priority (RE-TEST HYPOTHESIS ONLY, not adopted; live stays early-pin): TOTALS > MONEYLINE > SPREADS (then TOTAL_CORNERS, OTHER_STRUCTURED after core; corners has 0 same-event overlap, so no evidence). Tie-break: existing chronological comparator order — decisionTimestamp, entryPrice, conditionId, tokenId; no outcome used.

## Same-event overlap N (first decision time)
- spreads&moneyline: 291
- spreads&totals: 379
- spreads&total_corners: 0
- spreads&other_structured: 59
- moneyline&totals: 371
- moneyline&total_corners: 0
- moneyline&other_structured: 37
- totals&total_corners: 0
- totals&other_structured: 85
- total_corners&other_structured: 13

## Core policies (all events) | baseline = early pin
| Policy | Sel N | Settled | Open | W/L | PnL u | ROI% | MaxDD u | Bets/day |
|---|---|---|---|---|---|---|---|---|
| BASELINE | 4364 | 2543 | 1821 | 986/1557 | 41.5 | 1.6317 | -98.15 | 94.8696 |
| SPREADS_FIRST (ALL_ORDINARY_EVENTS, dom N 4364) | 4364 | 2501 | 1863 | 987/1514 | 33.85 | 1.3535 | -98.62 | 94.8696 |
| MONEYLINE_FIRST (ALL_ORDINARY_EVENTS, dom N 4364) | 4364 | 2551 | 1813 | 1001/1550 | 45.64 | 1.789 | -85.84 | 94.8696 |
| TOTALS_FIRST (ALL_ORDINARY_EVENTS, dom N 4364) | 4364 | 2531 | 1833 | 1008/1523 | 66.89 | 2.6429 | -79.14 | 94.8696 |
| SPREAD_OVER_ML (PAIR spreads&moneyline, dom N 291) | 291 | 171 | 120 | 41/130 | -13.51 | -7.9007 | -31.04 | 26.4545 |
| ML_OVER_SPREAD (PAIR spreads&moneyline, dom N 291) | 291 | 221 | 70 | 55/166 | -1.72 | -0.78 | -19.76 | 26.4545 |
| SPREAD_OVER_TOTALS (PAIR spreads&totals, dom N 379) | 379 | 229 | 150 | 54/175 | -34.89 | -15.2376 | -49.81 | 13.5357 |
| TOTALS_OVER_SPREAD (PAIR spreads&totals, dom N 379) | 379 | 256 | 123 | 73/183 | -7.37 | -2.8784 | -31.81 | 13.5357 |
| ML_OVER_TOTALS (PAIR moneyline&totals, dom N 371) | 371 | 273 | 98 | 70/203 | -5.52 | -2.0201 | -30.07 | 33.7273 |
| TOTALS_OVER_ML (PAIR moneyline&totals, dom N 371) | 371 | 250 | 121 | 73/177 | 16.87 | 6.7464 | -33.34 | 33.7273 |
| CORE_OVER_CORNERS (corners&any-core, dom N 0) | 0 | 0 | 0 | 0/0 | 0 | 0 | 0 | 0 |
| CORNERS_OVER_CORE (corners&any-core, dom N 0) | 0 | 0 | 0 | 0/0 | 0 | 0 | 0 | 0 |
| CORE_OVER_OTHER (other_structured&any-core, dom N 101) | 101 | 75 | 26 | 27/48 | 14.44 | 19.253 | -18.98 | 3.8846 |
| OTHER_OVER_CORE (other_structured&any-core, dom N 101) | 101 | 83 | 18 | 35/48 | 14.65 | 17.6557 | -7.43 | 3.8846 |

Selected family mix: SPREADS_FIRST {"totals":784,"spreads":783,"moneyline":1239,"other_structured":1179,"total_corners":379}; MONEYLINE_FIRST {"totals":784,"spreads":492,"moneyline":1530,"other_structured":1179,"total_corners":379}; TOTALS_FIRST {"totals":1246,"spreads":404,"moneyline":1156,"other_structured":1179,"total_corners":379}

## Verdicts (frozen rule)
- SPREADS_FIRST: pass=false n=169 dPnL=-3.0235 z=-0.1051
- MONEYLINE_FIRST: pass=false n=193 dPnL=12.5067 z=0.3753
- TOTALS_FIRST: pass=false n=179 dPnL=24.8672 z=0.8278
- SPREAD_OVER_ML: pass=false n=97 dPnL=-1.0704 z=-0.0466
- ML_OVER_SPREAD: pass=false n=121 dPnL=14.4599 z=0.5081
- SPREAD_OVER_TOTALS: pass=false n=111 dPnL=4.0331 z=0.1741
- TOTALS_OVER_SPREAD: pass=false n=135 dPnL=23.2791 z=0.8498
- ML_OVER_TOTALS: pass=false n=148 dPnL=18.5969 z=0.5932
- TOTALS_OVER_ML: pass=false n=110 dPnL=31.046 z=1.2081
- CORE_OVER_CORNERS: pass=false n=0 dPnL=0 z=0
- CORNERS_OVER_CORE: pass=false n=0 dPnL=0 z=0
- CORE_OVER_OTHER: pass=false n=53 dPnL=7.245 z=0.4701
- OTHER_OVER_CORE: pass=false n=34 dPnL=-8.9011 z=-0.6567

## Caveats
- Reference price is REFERENCE_PNL, not executable full-stake fill.
- signal_score/100 is not probability; no probabilities invented.
- Single frozen predeclared rule; no retuning. Overlap-domain pair policies test priority only where both families coexist at T0.
- T0-only choice set is a conservative simultaneity definition; later-arriving markets are excluded (shown only in ANY_TIME diagnostic).
- Source-regime split uses population_id as proxy; pre/post fan-out marker not canonical in code.
- Settled N differs by day-lag; OPEN excluded from PnL/ROI.
