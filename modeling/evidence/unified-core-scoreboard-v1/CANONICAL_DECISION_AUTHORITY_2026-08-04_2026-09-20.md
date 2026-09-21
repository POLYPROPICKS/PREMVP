# Canonical Decision Authority — Aug04→Sep20 Modeling Recovery

## Provenance

- **Canonical command:**
  ```
  npm run research-clone:scoreboard -- --start=2026-08-04 --end=2026-09-20
  ```
- **Canonical runner:** `scripts/modeling/unified-core-scoreboard.ts` (reuses `lib/modeling/research-engine` settlement/metrics and `scripts/modeling/factor-atlas.ts` normalizers verbatim — no economics reimplemented in SQL, no ad-hoc SQL is part of this authority)
- **PR:** POLYPROPICKS/PREMVP#363
- **Commit SHA (this artifact's data):** `fae7207bef725de526b8aa8df68330ae2f8e9d8b`
- **Source DB:** PREMVP research clone only. Production writes = 0.
- **This document contains no raw model-ready rows** — aggregate figures only, matching the runner's own JSON artifact (`modeling/evidence/unified-core-scoreboard-v1/SCOREBOARD_2026-08-04_2026-09-20.json`, generated per run, not committed — see that script's header comment for why).

## Dataset

| | |
|---|---|
| Range | 2026-08-04 → 2026-09-20 |
| Closed MODEL_READY days | 48 |
| Source model-ready rows | 68,949 |
| Processed physical events | **7,985** |
| Excluded | 2026-09-21 (partial/current day) |

---

## Founder model table

| STATUS | MODEL | DATASET | PROCESSED → BET | SPORTS IN BETS | ROI% | P&L (u) | MAX DD (u) | MAIN RULES |
|---|---|---|---|---|---|---|---|---|
| **LIVE** (reference to current production policy — not newly promoted here) | PORTFOLIO_BROAD | Aug04–Sep20 | 3229/7985 (40.4%) | tennis 42.7%, soccer 24.8% | 18.74 | +605.23 | −37.32 | tiered: (tennis\|score63‑64)@0.50‑52 > 0.50‑52 > 0.52‑54 |
| RESEARCH | P50_54 | Aug04–Sep20 | 3229/7985 (40.4%) | tennis 42.7%, soccer 24.7% | 18.90 | +610.13 | −38.31 | 0.50≤price<0.54 |
| RESEARCH | C5 | Aug04–Sep20 | 3653/7985 (45.8%) | tennis 38.6%, soccer 28.7% | 16.55 | +604.52 | −38.96 | 0.50≤price<0.60 AND sport≠table-tennis |
| RESEARCH | C0 | Aug04–Sep20 | 3713/7985 (46.5%) | tennis 38%, soccer 28.3% | 16.23 | +602.52 | −42.96 | 0.50≤price<0.60 (price-anchor reference) |
| RESEARCH | P50_52 | Aug04–Sep20 | 2983/7985 (37.4%) | tennis 45.8%, soccer 22.2% | 19.06 | +568.57 | −31.04 | 0.50≤price<0.52 |
| RESEARCH / satellite (not a standalone production policy) | TENNIS_P50_52 | Aug04–Sep20 | 1365/7985 (17.1%) | tennis 100% | 35.07 | +478.77 | −16.00 | 0.50≤price<0.52 AND tennis |
| RESEARCH | C0_ONLY_NOT_C1 | Aug04–Sep20 | 2664/7985 (33.4%) | tennis 53%, esports 14.2% | 17.00 | +452.82 | −44.27 | C0 AND sport≠soccer |
| RESEARCH | SCORE63_64 overlay | Aug04–Sep20 | 2230/7985 (27.9%) | tennis 55.3%, soccer 26.1% | 18.38 | +409.78 | −24.33 | 0.50≤price<0.60 AND score∈[63,65) |
| RESEARCH | C1 | Aug04–Sep20 | 1053/7985 (13.2%) | soccer 100% | 14.39 | +151.55 | −27.65 | 0.50≤price<0.60 AND soccer |
| RESEARCH | C4 (current) | Aug04–Sep20 | 1255/7985 (15.7%) | soccer 83.6%, esports 9.9% | 9.63 | +120.81 | −32.88 | 0.50≤price<0.60 AND (soccer OR lead≥24h) |
| SMALL_SAMPLE | TENNIS_LEAD18‑24 diagnostic | Aug04–Sep20 | 245/7985 (3.1%) | tennis 100% | 58.03 | +142.17 | −5.23 | diagnostic only, not a decision leader |
| REFERENCE (isolated) | LEGACY_C4_HISTORICAL | Jun–Aug (separate, NOT in Aug04–Sep20 denominator) | N=4142 (2398W/1744L) | — | 11.85 | +490.71 | −15.84 | frozen golden-contract reference |

---

## Gate economics

### Score gate: 50–64 vs ≥65

| SLICE | N | P&L | ROI% | MaxDD | Aug | Sep | STATUS |
|---|---|---|---|---|---|---|---|
| 50–64 | 2558 | +451.36 | 17.64 | −20.77 | 134 / −15.96 | 2424 / +467.32 | RESEARCH |
| **≥65** | 485 | +112.35 | 23.16 | −24.80 | 3 / +1.00 | 482 / +111.35 | **NO_GO as a required gate** — thin volume (485 of 7985), August N=3 uninterpretable; a hard ≥65 floor is not adopted |

### Sub-0.50 entry price

**NO_GO** — based on existing accepted evidence; not reopened in this or the prior passes of this mission (per explicit boundary: "Do NOT reopen sub-0.50 exploration").

### Legacy BAD_BUCKET_COV_PRICE hard-reject counterfactual — **NO_GO as a hard reject**

`coverage` is not persisted on `canonical_row`; reconstructed via the same proven bounded evidence read the materializer itself uses (`readResearchEvidencePageRows`), joined on `condition_id+selected_token_id+decision_at`.

| SCOPE | REMOVED N | REMOVED P&L | REMOVED ROI% | REMOVED MaxDD | RETAINED N | RETAINED P&L | RETAINED ROI% | RETAINED MaxDD |
|---|---|---|---|---|---|---|---|---|
| Within C0 (0.50–0.60) | 292 | +90.15 | 30.87 | −15.22 | 3585 | +537.11 | 14.98 | −42.96 |
| Within Broad (0.50–0.54) | 222 | +87.98 | 39.63 | −10.61 | 3102 | +540.24 | 17.42 | −38.31 |

**August attribution caveat:** removed events are 100% in September (0 in August) in both cuts. This may partly reflect thinner August join-completeness in the coverage evidence source rather than zero true August bad-bucket events — flagged, not resolved. **Factual status: NO_GO** — re-imposing this legacy hard reject would remove population that is, under this reconstruction, net-profitable at higher-than-retained ROI; it is not adopted as a live policy, and is recorded as a hard-reject research finding, not a recommendation to reinstate it.

### C4 lead-time decomposition — **NO_GO as a value-add hypothesis**

| COMPONENT | N | P&L | ROI% | MaxDD |
|---|---|---|---|---|
| C4 combined (current) | 1255 | +120.81 | 9.63 | −32.88 |
| Soccer component | 1053 | +151.55 | 14.39 | −27.65 |
| **Non-Soccer lead≥24h component** | 206 | **−28.89** | **−14.02** | −33.36 |

Non-Soccer lead≥24h is a net drag on C4 (almost entirely an August cohort, 202/206 events, esports/unknown sport mix). **NO_GO** as a value-add component on this common dataset. Soccer alone outperforms combined C4 on every axis.

---

## Market-type economics (RESEARCH unless noted)

`marketTypeRaw` is read directly off `canonical_row` (present at runtime via the direct materializer's row construction — not reconstructed through a secondary evidence join). Attribution coverage: **2,193 / 7,985** physical events carry a resolvable `marketTypeRaw` — **ATTRIBUTION_LIMITED**, does not explain the full processed population.

| MARKET TYPE | STATUS | N | P&L | ROI% | MaxDD | Aug N/P&L | Sep N/P&L |
|---|---|---|---|---|---|---|---|
| moneyline | RESEARCH | 1341 | −18.97 | −1.41 | −41.05 | 747 / −22.93 | 594 / +3.96 |
| totals | RESEARCH | 565 | −6.72 | −1.19 | −47.11 | 185 / +19.57 | 380 / −26.30 |
| spreads | RESEARCH | 368 | −59.66 | −16.21 | −74.90 | 34 / −3.50 | 334 / −56.16 |
| child_moneyline | RESEARCH | 302 | −26.18 | −8.67 | −26.25 | 294 / −20.31 | 8 / −5.87 |
| tennis_completed_match | RESEARCH | 202 | +42.08 | 20.83 | −7.00 | 121 / +7.04 | 81 / +35.04 |
| total_corners | RESEARCH | 120 | +11.99 | 9.99 | −10.18 | 13 / −1.63 | 107 / +13.62 |

**SMALL_SAMPLE diagnostics (not promoted):** soccer_exact_score N=32 (+44.64u); soccer_first_to_score N=26 (+13.35u).

**UWCL: unavailable** — league identity is weak/absent in this common layer; not reconstructed, per boundary.

---

## Selected-price-movement economics (RESEARCH; N<100 = SMALL_SAMPLE_DIAGNOSTIC)

Reuses the existing `selectedPrice` DerivedSeries carried on the model-ready row — no new feature. Usable series within C0: 753.

| BUCKET | STATUS | N | P&L | ROI% | MaxDD |
|---|---|---|---|---|---|
| PRICE_DELTA_NEG | SMALL_SAMPLE_DIAGNOSTIC | 71 | +0.09 | 0.12 | −10.41 |
| PRICE_DELTA_ZERO | RESEARCH | 570 | +273.29 | 47.95 | −11.00 |
| PRICE_DELTA_POS | RESEARCH | 137 | −3.58 | −2.61 | −11.46 |

No entry-timing rule is promoted from this data.

---

## Limitations

- Market-type and Exact-Score/First-to-score attribution is partial (2,193/7,985) — never claimed to explain the full population.
- BAD_BUCKET counterfactual's August null result is a flagged, unresolved attribution-completeness question, not a proven absence.
- UWCL is not reconstructable from current league identity and is not fabricated here.
- No new score/lead-time/price thresholds are promoted anywhere in this document.

## Modeling recovery status

**MODELING RECOVERY = CLOSED** for the Aug04→Sep20 common-dataset comparison. This artifact is the canonical, reproducible decision authority superseding ad-hoc chat-derived numbers. Re-running the canonical command against the same clone data reproduces every figure above byte-for-byte.

**Next natural transition:** live Broad → Planning → Reservation → Queue (no live-execution work performed in this mission).
