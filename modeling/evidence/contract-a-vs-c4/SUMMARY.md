# CONTRACT_A_VS_C4_PREDICATE_DIFFERENCE_V1

Diagnosis only. No model created, promoted, or changed.

## 1. Exact CONTRACT_A predicate (resolved from canonical production code)

Contract A is **not one predicate in one file**. It is a three-stage pipeline; the
`CONTRACT_A_PLANNING_V1` decision itself is an *identity/eligibility gate only* and contains
no price, sport or lead-time rule. The economically selective rules live upstream in the
candidate builder and downstream in the allocation policy.

Sources: [lib/executor/contractADecisions.ts](lib/executor/contractADecisions.ts),
[lib/executor/buildFireModelCandidates.ts](lib/executor/buildFireModelCandidates.ts),
[lib/executor/liveReservationAllocationPolicy.ts](lib/executor/liveReservationAllocationPolicy.ts).

| rule | exact production definition |
|---|---|
| **PRICE RULE** | No floor and no ceiling. One carve-out only — `BAD_BUCKET_COV_PRICE`: **reject if `coverage ∈ [50,74]` AND `entry_price ∈ [0.44, 0.58]`** ([buildFireModelCandidates.ts:1959](lib/executor/buildFireModelCandidates.ts:1959)). `max_entry_price` = `min(entry_price + 0.04, 0.99)` is an execution slippage cap, not a selection gate. |
| **SPORT RULE** | No hard sport filter. Sport enters only as a **ranking tiebreak**: `preferredStrategicScopes = ["SOCCER","TENNIS"]`. Esports are separately market-class-tagged `esports_non_policy`. |
| **LEAD-TIME RULE** | `hoursToStart ≥ 0` and **`hoursToStart ≤ 6.0`** for live eligibility ([buildFireModelCandidates.ts:1199](lib/executor/buildFireModelCandidates.ts:1199)); `> 6.0` → `QUEUE_LATER_NOT_LIVE_ELIGIBLE`. Allocation adds `minStartLeadMinutes = 30`. Event start must fall inside the plan-run window (`window_start_iso` → `window_end_iso`, 14:00Z → 05:00Z next day). |
| **MARKET RULE** | `candidate.diagnostics.market_policy.allowed !== false`, else `MARKET_POLICY_REJECTED` ([contractADecisions.ts:437](lib/executor/contractADecisions.ts:437)). Also fail-closed identity gates: exact provider event identity, exact event-start match, non-weak match-family key, non-weak identity quality. |
| **SCORE / RANKING RULE** | Tier gate `TIER1_CORE_STRICT_72_COV50` = **`score ≥ 72` AND `coverage ≥ 50`** ([buildFireModelCandidates.ts:1119](lib/executor/buildFireModelCandidates.ts:1119)); anything below tier 1 → `BELOW_LIVE_FALLBACK_POOL`. Ranking: `SIGNAL_SCORE_DESC` → `SPORT_PREFERENCE` → `PROVIDER_MARKET_VOLUME_DESC` → `PHYSICAL_EVENT_ID_ASC`. |
| **EVENT-LEVEL LIMIT** | `targetReservationSlots = 15` per plan run; one reservation per physical event (`match_family_key` dedup), `selection_reason = RESERVED_EVENT_MAX_SIGNAL_SCORE_V1`. |
| **OTHER MATERIAL ELIGIBILITY** | `entry_price` non-null; `stake > 0` (`ZERO_STAKE` reject); game not started (`GAME_STARTED_OR_INVALID`). |

## 2. Fixed C4 (unchanged)

```
0.50 <= entry_price < 0.60
AND ( sport_family = soccer OR lead_time_hours >= 24 )
```

## 3. THE STRUCTURAL FINDING — the two selectors are near-disjoint by construction

This is provable from the code alone, before any data:

1. **The C4 lead-time arm is unreachable under Contract A.** Contract A hard-caps
   `hoursToStart ≤ 6.0h`. C4's second arm requires `lead_time_hours ≥ 24`. The intersection
   is **empty by construction**. Empirically confirmed: across all 330 settled Contract A
   rows, `lead_time_hours ≥ 24` count = **0**, max observed lead = **17.98h**.
   → C4 reduces, under Contract A, to `0.50 ≤ ep < 0.60 AND soccer AND lead ≤ 6h`.
2. **The C4 price band collides head-on with Contract A's bad-bucket.** C4 wants
   `[0.50, 0.60)`; Contract A rejects `[0.44, 0.58]` whenever `coverage ∈ [50,74]`. The only
   C4 prices Contract A can accept are `(0.58, 0.60)`, or `[0.50, 0.58]` when `coverage ≥ 75`.

C4 is therefore **not a filter over Contract A and Contract A is not a funnel stage of C4**.
They are two different selectors that mostly cannot select the same bet.

## 4. Common comparison universe — and its explicit limit

| | |
|---|---|
| UNIT | Contract A reservation row (one per physical event per plan run) |
| SOURCE_STAGE | `night_event_reservations`, current lineage (`selector_id` AND `contract_a_version` both `CONTRACT_A_PLANNING_V1`), 2026-08-05 → 2026-09-01 |
| COMMON_INPUT_N | 381 |
| GAMMA_SETTLED_N | **330** |

**Limitation, stated plainly: this universe is Contract-A-accepted output, so `C4_ONLY` is
structurally unobservable on it (=0 by construction, not by measurement).**

An attempt was made to build a true pre-selection common universe from the
`generated_signal_pairs` pool inside each plan-run window (128,001 rows fetched). It was
**rejected as unfaithful**: only 7,310 of 128,001 rows (5.7%) carry both
`diagnostics.formulaAudit.finalSignalV2` and `diagnostics.dataCoverage`, and replaying the
proven Contract A predicate over them reproduced only **3** selections against the **330**
Contract A actually made. Production planning mode reads `planningSources`, not the raw GSP
diagnostics available here. Reporting partition economics off a reconstruction with a ~1%
reproduction rate would be fabrication, so it was discarded rather than reported.

## 5. Partition on the common settled population (denominator = 330)

| group | N | W | L | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|---|---|
| **BOTH_PASS** | 14 | 10 | 4 | **+5.3695** | **38.35%** | -2.0000 |
| **CONTRACT_A_ONLY** | 316 | 146 | 170 | **+6.1218** | **1.94%** | **-30.8174** |
| **C4_ONLY** | — | — | — | — | — | *not observable on this universe (see §4)* |
| **NEITHER** | — | — | — | — | — | *not observable on this universe* |

Denominators explicit: 14 + 316 = 330 settled. The two unobservable cells are why the verdict
below is D and not a stronger claim.

## 6. Predicate difference counts (CONTRACT_A_ONLY, N=316)

Not presented as a sequential funnel — Contract A's real evaluation order does not evaluate
C4's rules at all, so these are independent reasons a Contract A row fails C4:

| reason | INPUT_N | REJECTED_N | remaining |
|---|---|---|---|
| ENTRY_PRICE outside `[0.50, 0.60)` | 316 | **231** | 85 |
| price OK but fails **both** C4 arms (not soccer AND lead < 24h) | 85 | **85** | 0 |
| LEAD_TIME arm `≥24h` alone | 330 | **330** (all) | 0 |
| MARKET_CLASS / MARKET_ELIGIBILITY | — | n/a — C4 has no market rule | — |
| SCORE / RANKING | — | n/a — C4 has no score rule | — |
| EVENT_MAX / RESERVATION LIMIT | — | n/a — C4 has no event limit | — |

The dominant difference is **price (231/316 = 73.1%)**, and it is dominant in the direction
Contract A's bad-bucket predicts: Contract A concentrates *below* C4's floor.

## 7. Economic contribution

- **What Contract A adds relative to C4 (`CONTRACT_A_ONLY`): N=316, +6.1218u, 1.94% ROI,
  -30.8174u MaxDD.** 316 extra bets bought +6.12u of PnL and cost -30.82u of drawdown. This
  is the whole of Contract A's weakness: it is 95.8% of the volume and 53.3% of the PnL, at
  15x the drawdown of the overlap.
- **What the overlap earns (`BOTH_PASS`): N=14, +5.3695u, 38.35% ROI, -2.0000u MaxDD.** 4.2%
  of the rows produce 46.7% of the total PnL with essentially no drawdown.
- **What Contract A loses relative to C4:** not measurable here — see §4. It cannot be
  quantified without a faithful pre-selection universe.

## 8. Sport diagnostic (descriptive, no filter created)

| sport family | N | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|
| SOCCER | 166 | **+22.7332** | 13.69% | -11.7721 |
| TENNIS | 105 | +0.0966 | 0.09% | -12.8501 |
| ESPORT | 38 | **-8.3805** | -22.05% | -9.9798 |
| MLB | 17 | **-5.6717** | -33.36% | -9.8293 |
| OTHER (BASKETBALL 2, MMA 2) | 4 | +2.7136 | 67.84% | -1.0000 |

**Dominating CONTRACT_A_ONLY gains: SOCCER.** **Dominating losses: ESPORT (-8.38u) and MLB
(-5.67u), jointly -14.05u** — they are 55 of 330 rows (16.7%) and destroy more PnL than the
entire cohort nets. TENNIS (N=105, 31.8% of rows) is economically inert: +0.0966u.

## 9. Price / lead-time bands (fixed, descriptive — no threshold selected)

| entry_price band | N | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|
| <0.40 | 42 | -6.6841 | -15.91% | -12.6260 |
| 0.40–<0.45 | 93 | **+19.1096** | 20.55% | -6.2074 |
| 0.45–<0.50 | 96 | +1.1221 | 1.17% | -13.2391 |
| 0.50–<0.60 | 99 | -2.0564 | -2.08% | -9.7093 |
| ≥0.60 | 0 | 0 | n/a | 0 |

| lead_time band | N | PNL_U | ROI_PCT | MAX_DD_U |
|---|---|---|---|---|
| <6h | 248 | +12.8277 | 5.17% | -14.4340 |
| 6–<12h | 69 | +0.4482 | 0.65% | -15.0037 |
| 12–<24h | 13 | -1.7847 | -13.73% | -5.0000 |
| ≥24h | **0** | 0 | n/a | 0 |

Note the 6–12h and 12–24h rows exist despite the documented `hoursToStart ≤ 6.0` live gate —
lead here is measured from `reserved_at` to `game_start_iso`, while the code gate is applied
at candidate-build time earlier in the run. This is a measurement-basis difference, not a
policy violation, and it does not affect the `≥24h = 0` conclusion.

## 10. Time effect — composition change across quartiles

| Q | N | PNL_U | ROI_PCT | MAX_DD_U | sport mix | med EP | med lead | market class |
|---|---|---|---|---|---|---|---|---|
| Q1 | 83 | -19.1378 | -23.06% | -21.4809 | **ESPORT 37**, TENNIS 23, SOCCER 19, MLB 4 | 0.455 | 4.70 | unknown 48, **esports_non_policy 34**, spread 1 |
| Q2 | 83 | -2.8742 | -3.46% | -14.6963 | SOCCER 47, TENNIS 33, MLB 3, **ESPORT 0** | 0.475 | 2.19 | unknown 80, spread 2, moneyline 1 |
| Q3 | 83 | +10.4436 | 12.58% | -13.1400 | SOCCER 43, TENNIS 36, MLB 3, ESPORT 1 | 0.475 | 4.41 | unknown 81, esports 1, spread 1 |
| Q4 | 81 | +23.0597 | 28.47% | -7.0000 | **SOCCER 57**, TENNIS 13, MLB 7, BASK 2, MMA 2 | 0.445 | 4.71 | unknown 39, **total 34**, spread 7, props 1 |

**Composition change aligns with the PnL change, so a causal reading is warranted here:**
esports go 37 → 0 → 1 → 0 exactly as PnL goes -19.14u → -2.87u → +10.44u → +23.06u, and
soccer share rises 22.9% → 56.6% → 51.8% → 70.4% over the same span. Price and lead medians
are essentially flat across all four quartiles (EP 0.445–0.475, lead 2.19–4.71h), so **price
and lead-time drift do not explain the improvement — sport mix does.** A secondary change is
market-class instrumentation: `allowed_fullmatch_total` appears only in Q4 (34 rows), so part
of the Q4 shift is also better market classification.

## 11. Ranked explanation

- **TOP_PNL_POSITIVE_DIFFERENCE** — SOCCER selections (N=166, +22.73u). Everything positive in
  Contract A is soccer; the entire cohort nets +11.49u, so soccer alone is ~2x the whole book.
- **TOP_PNL_NEGATIVE_DIFFERENCE** — ESPORT + MLB (N=55, -14.05u combined). 16.7% of rows,
  destroying more than the book nets.
- **TOP_DRAWDOWN_DRIVER** — `CONTRACT_A_ONLY` at -30.8174u, concentrated in Q1 (-21.48u), which
  is the esports-heavy quartile (37/83 rows esports).
- **MOST_MATERIAL_PREDICATE_DIFFERENCE** — the **lead-time gate**. Contract A's hard
  `hoursToStart ≤ 6.0` makes C4's `≥24h` arm unreachable (0/330 observed), which is what makes
  these two selectors structurally different populations rather than nested filters. Price is
  the larger *count* difference (231/316) but lead-time is the larger *structural* one, because
  price only shifts the overlap while lead-time eliminates an entire C4 arm.

### WHY_CONTRACT_A_RECENT_LOOKS_BETTER_THAN_FULL_HISTORY

**Composition change, specifically the disappearance of esports — evidence only.** Q1 carried
37 esports rows (44.6% of the quartile) returning -22.05% ROI as a family; Q2–Q4 carry 0, 1
and 0. Over the same quartiles PnL runs -19.14u → -2.87u → +10.44u → +23.06u and soccer share
runs 22.9% → 56.6% → 51.8% → 70.4%. Entry-price median (0.455/0.475/0.475/0.445) and lead
median (4.70/2.19/4.41/4.71h) are flat, so the improvement is not a price or timing drift. The
recent 14-day sample that read at 17.90% ROI is simply the esports-free, soccer-heavy tail of
this composition shift. Whether that shift is a durable policy/data change or a transient
scheduling artifact cannot be determined from this evidence.

## FINAL VERDICT

**D. COMMON_UNIVERSE_INSUFFICIENT**

The mission's primary deliverable — `BOTH_PASS` / `CONTRACT_A_ONLY` / `C4_ONLY` / `NEITHER`
economics on one common settled population — is **not fully computable with the evidence
available**. `C4_ONLY` and `NEITHER` require a faithful pre-selection decision universe, and
the only reconstructable candidate pool reproduced Contract A at ~1% fidelity (3 of 330). Two
of the four required cells are therefore unobservable, and the mission's acceptance bar is not
met.

What *was* proven and stands on its own: the exact Contract A predicate; that C4 and Contract A
are near-disjoint by construction (C4's ≥24h arm is unreachable — 0/330, max lead 17.98h); the
partition economics for the two observable cells; and that Contract A's recent improvement is
driven by esports leaving the mix, not by price or timing drift.

**No challenger is named.** Verdict D does not authorize one, and naming a candidate off a
universe I have just declared insufficient would be exactly the post-hoc filter this mission
forbids. The soccer-only observation (N=166, +22.73u, 13.69% ROI, -11.77u MaxDD) is recorded in
§8 as a diagnostic for whoever owns the next mission — not promoted, not threshold-tuned, and
not selected as a challenger here.

**To make the next mission answerable**, the blocking need is a faithful replay of the
Contract A planning universe — i.e. access to `planningSources` as production reads it, or a
persisted per-run candidate pool — so that `C4_ONLY` and `NEITHER` become observable.

## Artifact

Diagnosis is fully contained in this document. No new dataset was built; all economics derive
from the already-durable `modeling/evidence/contract-a-validation/CONTRACT_A_LARGE_INTERVAL_V1.jsonl.gz`
(sha `94086f2d6fbc5715ae18646a2a3d7f9480ea66ab1e1fafffcc1567e32c2da1e1`), which is unmodified.
