# CONTRACT_A_CANDIDATES_V1 — two fixed corrections vs current baseline

`npm run modeling:offline-replay:contract-a-candidates` · window `2026-09-01..2026-09-10`
AS-OF `2026-09-10T14:04:29.586Z` · economics **GROSS_BEFORE_FEES** · one bet per physical
event · UNRESOLVED never in ROI · deterministic (identical rerun).
**No threshold search · no production query · no executable-market expansion.**

Candidate definitions (fixed, from the mission — nothing tuned):
- **C1 `CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF`** = current Contract A filter, change ONLY:
  (1) require `entry_price ≥ 0.50`; (2) disable `BAD_BUCKET`. Everything else unchanged.
- **C2 `CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF`** = C1, additionally narrow the
  **already-allowed** executable-market set to `allowed_fullmatch_total` only (rejects
  moneyline + spread; admits nothing the anchor forbids).

`NO_RESEARCH_ONLY_MARKET_ADMISSION = YES` (0 candidate bets flagged research-only).

## BASELINE_REPRODUCED = YES

| MODEL | FILTER_PASS_EVENTS | BETS | TERMINAL | UNRESOLVED | WINS | LOSSES | PNL_U | ROI_PCT | MAX_DD | WIN_RATE |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| **CONTRACT_A_FILTER_SIM_CURRENT** | 2,301 | 2,301 | **545** | 1,756 | **201** | **344** | **−86.91** | **−15.95 %** | −93.75 | 36.88 % |
| **CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF** | 1,213 | 1,213 | 291 | 922 | 149 | 142 | **−13.60** | **−4.67 %** | −25.50 | 51.20 % |
| **CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF** | 224 | 224 | 67 | 157 | 45 | 22 | **+10.61** | **+15.84 %** | −4.00 | 67.16 % |
| C0_REFERENCE | 5,565 | 5,565 | 1,578 | 3,987 | 931 | 647 | +241.60 | +15.31 % | −22.50 | 59.00 % |

(Baseline TERMINAL / WINS / LOSSES / PNL_U match the runner exactly.)

Δ vs current Contract A: **C1 = +73.31 u / +11.28 pp** · **C2 = +97.52 u / +31.79 pp**.

---

## SPORT TABLE

### C1 `CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF`
| SPORT | BETS | TERMINAL | WINS | LOSSES | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|--:|--:|
| soccer | 258 | 77 | 55 | 22 | +15.93 | +20.68 % |
| tennis | 865 | 192 | 82 | 110 | −29.85 | −15.54 % |
| baseball | 30 | 10 | 7 | 3 | +2.32 | +23.22 % |
| cricket | 55 | 12 | 5 | 7 | −2.00 | −16.67 % |
| hockey | 3 | 0 | 0 | 0 | 0 | — |
| mma | 1 | 0 | 0 | 0 | 0 | — |
| unknown | 1 | 0 | 0 | 0 | 0 | — |

### C2 `CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF`
| SPORT | BETS | TERMINAL | WINS | LOSSES | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|--:|--:|
| soccer | 153 | 47 | 37 | 10 | +15.20 | +32.34 % |
| tennis | 63 | 17 | 7 | 10 | −3.21 | −18.91 % |
| baseball | 7 | 3 | 1 | 2 | −1.37 | −45.80 % |
| mma | 1 | 0 | 0 | 0 | 0 | — |

---

## MARKET TABLE

### C1 `CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF`
| MARKET_FAMILY | BETS | TERMINAL | WINS | LOSSES | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|--:|--:|
| allowed_fullmatch_moneyline | 971 | 218 | 98 | 120 | **−27.95** | −12.82 % |
| allowed_fullmatch_spread | 29 | 7 | 7 | 0 | +4.74 | +67.78 % |
| allowed_fullmatch_total | 213 | 66 | 44 | 22 | **+9.61** | +14.56 % |

### C2 `CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF`
| MARKET_FAMILY | BETS | TERMINAL | WINS | LOSSES | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|--:|--:|
| allowed_fullmatch_total | 224 | 67 | 45 | 22 | **+10.61** | +15.84 % |

---

## ATTRIBUTION

### Candidate 1
| quantity | value |
|---|---|
| REMOVED_SUB_050_TERMINAL_N | **259** |
| REMOVED_SUB_050_PNL_U | **−58.44** |
| RESTORED_BY_BAD_BUCKET_OFF_TERMINAL_N | **0** |
| RESTORED_BY_BAD_BUCKET_OFF_PNL_U | **0** |

- The `entry_price ≥ 0.50` floor drops **259 terminal events** whose baseline pick was
  sub-0.50, worth **−58.44 u** (the full sub-0.50 selected population over the window is
  302 terminal / −70.98 u; the remaining ~43 events keep a ≥0.50 identity).
- **Disabling BAD_BUCKET adds ZERO new events once the ≥0.50 floor is also applied.**
  BAD_BUCKET's profitable slice (from the attribution mission: 54 events / +11.32 u at
  price 0.44–0.58) was concentrated below 0.50; the floor removes the same rows, and the
  0.50–0.58 remainder attaches to events already selected via another identity. **In
  Candidate 1, BAD_BUCKET-off is inert — Candidate 1 ≈ "just the price floor".**

### Candidate 2 (starts from Candidate 1)
| quantity | value |
|---|---|
| REMOVED_MONEYLINE_TERMINAL_N | **218** |
| REMOVED_MONEYLINE_PNL_U | **−27.95** |
| REMOVED_SPREAD_TERMINAL_N | **6** |
| REMOVED_SPREAD_PNL_U | **+3.94** |
| REMOVED_OTHER_FROM_C1_TERMINAL_N | 0 |
| RETAINED_TOTAL_TERMINAL_N | **67** |
| RETAINED_TOTAL_PNL_U | **+10.61** |

Removing moneyline from Candidate 1 recovers **+27.95 u** of loss; removing spread costs a
small **−3.94 u** (spread was mildly positive on 7 bets). Net C1 → C2: −13.60 → +10.61.

### Required-quantity summary
| acceptance quantity | value |
|---|---|
| SUB_050_DAMAGE | baseline sub-0.50 selected population = 302 terminal / **−70.98 u**; removed by C1 floor = 259 terminal / **−58.44 u** |
| BAD_BUCKET_EFFECT | standalone (attribution mission) = +54 events / **+11.32 u**; **within Candidate 1 (floor also on) = 0 events / 0 u** |
| MONEYLINE_EFFECT | Candidate 1 moneyline slice = 218 terminal / **−27.95 u**; removing it (C2) recovers +27.95 u |
| SPREAD_EFFECT | Candidate 1 spread slice = 7 terminal / **+4.74 u**; removing it (C2) costs −3.94 u |
| TOTAL_EFFECT | retained totals = 67 terminal / **+10.61 u** at **+15.84 % ROI** (≈ C0's +15.31 %) |

---

## DECISION: **BOTH_SUPPORTED_CANDIDATE_2_STRONGER**

- **Candidate 1 is supported:** terminal PnL −86.91 → **−13.60** (Δ +73.31 u, +11.28 pp),
  MAX_DD −93.75 → −25.50, win rate 36.88 % → 51.20 %. It removes the bulk of the measured
  loss and admits **no** research-only / non-executable market class. It does **not** reach
  positive — the residual loss is almost entirely `allowed_fullmatch_moneyline` (−27.95 u).
  Note it is effectively a single-lever change (the price floor; BAD_BUCKET-off is inert).

- **Candidate 2 is stronger:** terminal PnL **+10.61 u / +15.84 % ROI** (matching C0's
  +15.31 %), MAX_DD −4.00, win rate 67.16 %. It is a pure **narrowing** of the current
  allow-list (totals only) plus the price floor — no forbidden class admitted.

- **Tradeoff to weigh before implementation:** Candidate 2 collapses Contract A throughput
  by ~96 % (2,301 → 224 filter-pass events; 545 → 67 terminal). Its positive result rests
  on **67 terminal bets** over the 10-day resolvable subset — directionally strong but thin.
  Candidate 1 keeps ~4× the volume of Candidate 2 while removing most of the damage.

---

`BASELINE_REPRODUCED = YES` · `SUB_050_DAMAGE / BAD_BUCKET_EFFECT / MONEYLINE_EFFECT /
SPREAD_EFFECT / TOTAL_EFFECT = QUANTIFIED` · `NO_RESEARCH_ONLY_MARKET_ADMISSION = YES` ·
`THRESHOLD_SEARCH_N = 0` · `PRODUCTION_MUTATION_N = 0` · `FOUNDER_INTERMEDIATE_ACTIONS = 0` ·
`NEXT_VALUE_TRANSITION = IMPLEMENT_SELECTED_CONTRACT_A_CORRECTION_V1`
