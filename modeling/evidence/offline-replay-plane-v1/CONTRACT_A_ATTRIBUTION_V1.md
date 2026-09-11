# CONTRACT_A_ATTRIBUTION_V1 — why CONTRACT_A_FILTER_SIM_CURRENT loses vs C0

`npm run modeling:offline-replay:contract-a-attribution` · window `2026-09-01..2026-09-10`
AS-OF `2026-09-10T14:04:29.586Z` · economics **GROSS_BEFORE_FEES** · one bet per physical
event (chronologically-first passing identity) · UNRESOLVED never in ROI · deterministic
(identical rerun). **No production query · no threshold search · no policy change.**

## BASELINE_REPRODUCED = YES

| MODEL | TERMINAL | WINS | LOSSES | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|--:|
| C0 | 1,578 | 931 | 647 | **+241.60** | **+15.31 %** |
| CONTRACT_A_FILTER_SIM_CURRENT | 545 | 201 | 344 | **−86.91** | **−15.95 %** |

(TERMINAL / PNL_U / ROI match the runner exactly.)

---

## ANALYSIS 1 — Contract A **selected-bet** terminal economics by fixed bucket

### by ENTRY PRICE  ← the dominant signal
| bucket | BETS(term) | W-L | PNL_U | ROI_PCT | MAX_DD |
|---|--:|--:|--:|--:|--:|
| <0.44 | 217 | 60-157 | **−35.18** | −16.21 % | −55.95 |
| 0.44–0.50 | 85 | 23-62 | **−35.80** | **−42.12 %** | −38.20 |
| 0.50–0.54 | 213 | 98-115 | −17.76 | −8.34 % | −22.35 |
| 0.54–0.58 | 9 | 7-2 | +3.38 | +37.52 % | −1.00 |
| 0.58–0.60 | 2 | 1-1 | −0.32 | −15.97 % | −1.00 |
| ≥0.60 | 19 | 12-7 | −1.23 | −6.48 % | −5.00 |

**302 of 545 terminal bets (55 %) are priced < 0.50 → −70.98 u (82 % of the total −86.91 loss).**
Contract A's in-band (0.50–0.60) slice is 224 bets / −14.70 u — still negative, unlike C0's +15 %.

### by LEAD TIME
| bucket | term | W-L | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|
| 0–2h | 28 | 6-22 | −12.04 | −42.99 % |
| 2–6h | 44 | 17-27 | −6.57 | −14.94 % |
| 6–24h | 473 | 178-295 | **−68.30** | −14.44 % |
| ≥24h | 0 | — | — | — |

Short-lead (0–6h) = −18.6 u on 72 bets. The 6–24h bucket carries the loss but at the **same
ROI** as 2–6h — short-lead is not a disproportionate driver.

### by SCORE  ← score does not behave as a quality filter
| bucket | term | W-L | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|
| 50–59 | 71 | 30-41 | **+18.25** | **+25.71 %** |
| 60–64 | 337 | 134-203 | −55.93 | −16.60 % |
| 65–71 | 125 | 33-92 | **−46.79** | **−37.43 %** |
| ≥72 | 12 | 4-8 | −2.45 | −20.40 % |

The **only positive score bucket is the lowest (50–59)**; 65–71 is the worst.

### by DATA COVERAGE
| coverage | term | W-L | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|
| 25 | 420 | 166-254 | −64.40 | −15.33 % |
| 50 | 96 | 29-67 | −7.65 | −7.97 % |
| 75 | 29 | 6-23 | −14.86 | −51.26 % |

77 % of Contract A bets are cov=25 (TIER3 micro) and lose.

### by FORMULA VERSION (unchanged admission)
| formula_version | term | W-L | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|
| shadow-firemodel1_1_research_v0 | 303 | 134-169 | −35.62 | −11.76 % |
| trusted-initial-formula-v1.1 | 242 | 67-175 | **−51.29** | **−21.19 %** |

`trusted-initial-formula-v1.1` is ~1.8× worse per bet — but **both streams are net-negative**.

### by MARKET FAMILY (admitted classes)
| market_class | term | W-L | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|
| allowed_fullmatch_moneyline | 349 | 131-218 | **−61.80** | −17.71 % |
| allowed_fullmatch_spread | 57 | 13-44 | −23.85 | **−41.84 %** |
| allowed_fullmatch_total | 139 | 57-82 | **−1.26** | **−0.90 %** |

The families Contract A **retains** are its worst (spread −41.8 %, moneyline −17.7 %); totals ≈ flat.

---

## ANALYSIS 2 — BAD_BUCKET direct ablation (`CONTRACT_A_MINUS_BAD_BUCKET`)

| | FILTER_PASS_EVENTS | TERMINAL | W-L | PNL_U | ROI_PCT | MAX_DD |
|---|--:|--:|--:|--:|--:|--:|
| current Contract A | 2,301 | 545 | 201-344 | −86.91 | −15.95 % | −93.75 |
| minus BAD_BUCKET | 2,355 | 599 | 235-364 | −73.59 | −12.29 % | −87.51 |
| **Δ vs current** | +54 | **+54** | | **+13.32** | **+3.66 pp** | +6.24 |

Economics of events **rejected ONLY by BAD_BUCKET**: TERMINAL 53 · W-L 30-23 ·
**PNL_U +11.32 · ROI +21.36 %**. → BAD_BUCKET is removing a small profitable slice
(coverage 50–74 ∧ price 0.44–0.58). Diagnostic ablation, **not a proposed policy**.

---

## ANALYSIS 3 — other one-gate ablations (one at a time, never combined)

| ablation | TERMINAL | W-L | PNL_U | ROI | MAX_DD | Δ_PNL_vs_A | Δ_ROI_pp | newly-admitted-only (term / PnL / ROI) |
|---|--:|--:|--:|--:|--:|--:|--:|---|
| A) MINUS_TIER_ADMISSION | 545 | 201-344 | −86.91 | −15.95 % | −93.75 | **0** | 0 | 0 / 0 / — |
| B) MINUS_SCORE_FLOOR | 545 | 201-344 | −86.91 | −15.95 % | −93.75 | **0** | 0 | 0 / 0 / — |
| C) MINUS_EXECUTABLE_MARKET_ANCHOR **(RESEARCH_ONLY_COUNTERFACTUAL)** | 1,201 | 545-656 | **−5.00** | **−0.42 %** | −55.65 | **+81.91** | **+15.53 pp** | 630 / **+80.67** / **+12.80 %** |

- **A & B do nothing**: no Contract A candidate is gated purely by tier or by the score floor
  — the market-anchor + coverage + bad-bucket gates already remove everything they would
  (and score<50 is double-covered by the tier score floor).
- **C is the headline**: lifting the executable-market allow-list admits **630 terminal
  events worth +80.67 u at +12.8 % ROI** — classes the current money policy rejects
  (halftime / corners / props / map-round / esports / unclassified). This closes essentially
  the entire gap to break-even. It is a **RESEARCH_ONLY_COUNTERFACTUAL** — those exclusions
  carry real execution / settlement rationale — but it proves the allow-list is the single
  largest economic constraint and that the families it keeps are the wrong ones.

---

## ANALYSIS 4 — formula mix (filters unchanged)

Same as Analysis 1 "by FORMULA VERSION": `trusted-initial-formula-v1.1` −51.29 u / −21.19 %
(242) vs `shadow-firemodel1_1_research_v0` −35.62 u / −11.76 % (303). Removing either stream
only halves the loss — **no single formula_version "poisons" an otherwise-profitable
population**; the combined population is negative in both streams.

---

## ANALYSIS 5 — C0 vs Contract A physical-event overlap  ← EVENT-FILTER vs SELECTION

| set | events |
|---|--:|
| A_AND_C0 | 1,208 |
| A_ONLY | 1,093 |
| **C0_ONLY** | **4,357** |
| NEITHER | 4,041 |
| TOTAL | 10,699 |

Shared events: **SAME_SELECTED_MARKET_OUTCOME_N = 912** · **DIFFERENT = 296**.

| slice | TERMINAL | W-L | PNL_U | ROI_PCT |
|---|--:|--:|--:|--:|
| A selected on shared events | 284 | 127-157 | **−30.84** | −10.86 % |
| C0 selected on shared events | 321 | 163-158 | **−0.53** | −0.17 % |
| SAME_EVENT_SAME_IDENTITY | 218 | 104-114 | −12.81 | −5.88 % |
| SAME_EVENT_DIFFERENT_IDENTITY — A's pick | 66 | 23-43 | **−18.03** | **−27.32 %** |
| SAME_EVENT_DIFFERENT_IDENTITY — C0's pick | 103 | 59-44 | **+11.96** | **+11.61 %** |
| A_ONLY events | 261 | 74-187 | **−56.07** | −21.48 % |
| **C0_ONLY events** | **1,257** | 768-489 | **+242.14** | **+19.26 %** |

**Both problems are present:**
1. **EVENT-FILTER problem** — Contract A rejects **4,357** C0 events worth **+242 u / +19 %**
   (its entire edge), and the events it uniquely adds are its worst (−21 %).
2. **MARKET/OUTCOME SELECTION problem** — on the 296 shared events where the two models
   diverge, **Contract A's identity choice returns −27 % vs C0's +12 %**.

---

## ANALYSIS 6 — soccer / tennis same-market-family control

| SPORT / FAMILY | A: term / W-L / PnL / ROI | C0: term / W-L / PnL / ROI |
|---|---|---|
| soccer / moneyline | 113 / 34-79 / −22.54 / **−19.94 %** | 31 / 16-15 / −2.17 / −7.00 % |
| soccer / spread | 41 / 9-32 / −18.85 / **−45.96 %** | 4 / 4-0 / +3.44 / +85.93 % (N=4) |
| soccer / total | 120 / 47-73 / −3.20 / **−2.66 %** | 21 / 15-6 / +7.56 / +35.98 % |
| tennis / moneyline | 193 / 81-112 / −31.28 / **−16.21 %** | 382 / 183-199 / −17.65 / −4.62 % |
| tennis / total | 15 / 7-8 / −0.76 / −5.05 % | 40 / 21-19 / +1.79 / +4.46 % |

**Inside every shared market family, Contract A underperforms C0.** The gap is not "A admits
different families" — A's price / timing / outcome logic is worse even in identical families.

---

## RANKED FOUNDER TABLE (rank by measured Δ_PNL if the gate is removed)

| RANK | CONTRACT_A_SEMANTIC | CURRENT_RULE | EVIDENCE | CURRENT_A_PNL | ABLATION_PNL | DELTA_PNL | CURRENT_A_ROI | ABLATION_ROI | DELTA_ROI_pp | VERDICT |
|--:|---|---|---|--:|--:|--:|--:|--:|--:|---|
| 1 | EXECUTABLE_MARKET_ANCHOR | `resolveMarketAnchorDecision().allowed` — fullmatch moneyline/spread/total only | newly-admitted-only 630 term / **+80.67 u** / +12.8 % (RESEARCH_ONLY_COUNTERFACTUAL) | −86.91 | −5.00 | **+81.91** | −15.95 % | −0.42 % | **+15.53** | **LIKELY_MAJOR_DAMAGE** |
| 2 | BAD_BUCKET | reject `coverage∈[50,74] ∧ price∈[0.44,0.58]` | rejected-only-by-this 53 term / **+11.32 u** / +21.4 % | −86.91 | −73.59 | **+13.32** | −15.95 % | −12.29 % | **+3.66** | **LIKELY_DAMAGE** |
| 3 | TIER_ADMISSION | `computeTier` non-null (T1/T2/T3) | ablation Δ_PNL 0 · 0 newly admitted (double-covered by score floor + coverage gate) | −86.91 | −86.91 | 0 | −15.95 % | −15.95 % | 0 | **NEUTRAL_OR_PROTECTIVE** |
| 4 | SCORE_FLOOR | `score ≥ 50` | ablation Δ_PNL 0 · 0 newly admitted (does not bind; score is not predictive here) | −86.91 | −86.91 | 0 | −15.95 % | −15.95 % | 0 | **NEUTRAL_OR_PROTECTIVE** |

### Supplementary (not a single toggleable gate — the clearest economic signal)
**PRICE REGION** — Contract A's effective candidate/outcome price selection reaches deep
below 0.50 (302 / 545 terminal bets, −70.98 u, ROI −16 % to −42 %), whereas C0 is locked to
0.50–0.60. On shared events A's divergent (sub-0.50) picks lose at −27 % vs C0's +12 %.
This is the mechanism behind ranks 1–2 and Analysis 6. **VERDICT: LIKELY_MAJOR_DAMAGE.**

---

## REQUIRED FINAL ANSWERS

1. **Is BAD_BUCKET removing profitable C0-like price territory?**
   **YES, partially — minor.** Disabling it admits 53 terminal bets at **+21.4 % ROI / +11.32 u**
   (coverage 50–74 ∧ price 0.44–0.58, overlapping C0's lower edge). Total effect +13.32 u /
   +3.66 pp — ~15 % of the C0 gap. Real but not the main driver.

2. **Are short-lead bets a major source of Contract A loss?**
   **NO.** 0–6h lead = −18.6 u on 72 bets. The 6–24h bucket carries −68.3 u but at the **same
   ROI** (−14.4 %) as the 2–6h bucket. Short-lead is slightly worse per bet, small volume —
   not a major driver.

3. **Is one formula_version responsible for disproportionate loss?**
   **NO (not single-poison).** `trusted-initial-formula-v1.1` (−21.2 %, 242 bets) is ~1.8×
   worse per bet than `shadow-firemodel1_1_research_v0` (−11.8 %, 303 bets), but **both are
   net-negative**. Removing either only halves the loss.

4. **Does score/tier filtering improve or worsen economics?**
   **NEITHER — the gates do not bind.** Ablating tier: Δ_PNL 0. Ablating score-floor: Δ_PNL 0
   (0 rows admitted by either). And the score signal is inverted for Contract A: the **50–59
   bucket is the only positive one (+25.7 %)**, 65–71 is the worst (−37.4 %). Score is not
   acting as a quality filter.

5. **Does the executable-market allow-list improve or worsen economics?**
   **WORSEN — it is the #1 damage semantic.** Lifting it: PnL −86.91 → −5.00 (**+81.91 u /
   +15.53 pp**); 630 excluded terminal events are **+80.67 u / +12.8 % ROI**. The retained
   families are Contract A's worst (spread −41.8 %, moneyline −17.7 %; totals ≈ flat).
   *(RESEARCH_ONLY_COUNTERFACTUAL — the exclusions have execution/settlement rationale; this
   proves the allow-list is the dominant constraint and mis-scoped, not that it should be
   removed.)*

6. **On shared physical events, does Contract A choose worse market/outcome identities than C0?**
   **YES.** On the 296 shared events where the two models pick different identities:
   **Contract A −18.03 u / −27.3 % ROI vs C0 +11.96 u / +11.6 % ROI.** And inside every shared
   soccer/tennis market family, Contract A underperforms C0. This is a genuine
   **market/outcome SELECTION problem**, independent of the event filter.

7. **Highest-value ONE–TWO correction targets (do not implement):**
   - **#1 — the executable-market anchor scope + the price region it interacts with.** The
     allow-list confines Contract A to its worst families while its selection also reaches
     sub-0.50; together these are >90 % of the degradation. A bounded correction:
     (a) re-scope the admitted families toward `allowed_fullmatch_total` (≈ flat) and away
     from `allowed_fullmatch_spread`; (b) add a price floor to Contract A candidate/outcome
     selection aligned with the C0 0.50–0.60 band.
   - **#2 — BAD_BUCKET.** It clips a small profitable coverage-50–74 / price-0.44–0.58 slice
     (+11.3 u / +21 %); revisit it together with #1's price-floor change.
   - **Not worth touching:** TIER_ADMISSION and SCORE_FLOOR (inert on this population).

---

`BASELINE_REPRODUCED = YES` · `THRESHOLD_SEARCH_N = 0` · `PRODUCTION_MUTATION_N = 0` ·
`FOUNDER_INTERMEDIATE_ACTIONS = 0` ·
`NEXT_VALUE_TRANSITION = CORRECT_HIGHEST_DAMAGE_CONTRACT_A_SEMANTICS_V1`
