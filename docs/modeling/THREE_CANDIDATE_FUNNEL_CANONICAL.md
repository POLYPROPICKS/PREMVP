# Three-Candidate Executable Funnel — Canonical Spec (Phase 3E.8C)

This file is the committed, human-readable source of truth for the current
three-model observation set. It is derived from, and must stay in sync with,
the executable classifier at `modeling/model_registry/executable_funnel_classifier.json`
and the evaluator at `lib/modeling/historicalFunnelVariants.ts`. If this file
and the classifier ever disagree, the classifier (and the evaluator's actual
dispatch behavior) wins — this document is documentation, not a second source
of executable logic.

> **Provenance note on the historical attrition numbers in this document:**
> The specific row counts below (1,850 canonical rows; PRIMARY 355→327→317;
> ALT2 TS 1,110; ALT1 355→274; event-group counts; max-signals-per-event
> figures) were supplied by the operator as the result of a real run against
> the canonical corpus (expected hash
> `90ce9662c43185d7b1c4bc03ce66b46f8bf481faeac186d835dbd2638d739b72`). This
> authoring session's sandbox does not contain the row-level corpus artifact
> (`modeling/local_exports/generated_signal_pairs_export.json`) or the
> historical comparison/manifest JSON, so these specific numbers could **not**
> be independently re-derived or hash-verified in this session. They are
> persisted here as reported, not as self-verified. Before treating any
> number below as final, re-run `run-historical-funnel-comparison.ts` and
> confirm `manifest.inputSha256` matches the hash above.

## 1. Common corpus layer

```
49,400 raw resolved snapshots
  → strict dedup by (condition_id + token_id)
  → 1,850 canonical rows
```

Dedup rule: **keep the latest `created_at` that is still `<= resolved_at`** for
each `(condition_id, token_id)` key (policy name
`strict_latest_created_before_resolved`, implemented once in
`lib/modeling/generatedSignalPairsDedupPolicy.ts` and reused — never
reimplemented — by every model below).

**Dedup is infrastructure, not an individual model filter.** It runs once,
before any of the three funnels below see a row. None of PRIMARY, ALT2 TS, or
ALT1 has its own deduplication step — they all start from the same 1,850-row
canonical corpus.

## 2. Common semantic adapters

All three funnels below read fields through the same shared adapters in
`lib/modeling/historicalFunnelVariants.ts` — no model has its own copy of
this logic.

| Semantic field | Adapter | Source priority |
|---|---|---|
| score | `getScoreValue` | `signal_confidence_num` → `score` → `signal_score` → `pre_event_score_num` (first finite number; numeric strings rejected, not coerced) |
| coverage | `getCoverageValue` | `diagnostics.dataCoverage` only (0–100; dead top-level `coverage`/`coverage_score` aliases never read) |
| timing | `getHoursUntilStartValue` | `diagnostics.gameStartIso − created_at`, in hours (never wall-clock time) |
| event identity | `buildEventGroupKey` (`lib/modeling/eventGroupSelection.ts`) | `match_family_key → canonical_event_key → parent_event_key → event_slug → event_title → market_slug → condition_id` fallback chain |
| result / ROI / PnL | `roiPnlContract.ts` (`classifyResolvedOutcome`, `computeRowReturnPct`, `computeFlatStakeRoiSummary`) | `signal_result` |

## 3. PRIMARY_V1_AVOID_NBA_NHL_COV_CAP — exact ordered funnel

```
INPUT      canonical dedup rows (1,850)
CALCULATE  score := getScoreValue(row)  (alias chain above)
REQUIRE    score >= 72
EXCLUDE    league matches NBA/NHL (regex over market_slug + event_slug)
EXCLUDE    coverage in [50,74] AND entry_price in [0.44,0.58]  (bad bucket)
EXCLUDE    hours_until_start in [6,24)
GROUP      canonical event (buildEventGroupKey)
ORDER      score desc, then coverage desc, then smart-money, then price-band, then -createdAt, then stable id
KEEP       first row per event group
STAKE      historical $10 metadata (diagnostic only — see §6)
OUTPUT     selected rows
```

**Reported historical attrition on the canonical corpus:**

```
1,850  (INPUT)
  → 355   (after REQUIRE score >= 72)
  → 355   (after EXCLUDE NBA/NHL — 0 rows removed on this corpus)
  → 327   (after EXCLUDE coverage/price bad bucket)
  → 317   (after EXCLUDE timing 6–24h)
  → 317   (after GROUP/ORDER/KEEP — 0 rows removed by the final keep on this corpus)
```

- **317 signals**, **245 event groups**, **58 events with >1 selected signal**, **max 5 signals per event** (pre-KEEP; KEEP itself removed 0 rows, meaning at most one signal survived per group on this corpus after the upstream filters — see the provenance note above).
- **`score >= 72` is the dominant historical contributor** (1,850 → 355 is by far the largest single reduction in the funnel).
- **NBA/NHL exclusion removed 0 rows** on this corpus.
- **Final KEEP removed 0 rows** on this corpus.
- This is a **descriptive** finding about this specific corpus snapshot, not a claim about the rule's general importance or a causal/statistical-significance claim.

## 4. ALT2_TS_SCORE_GE_65 — exact ordered funnel

```
INPUT    canonical dedup rows (1,850)
REQUIRE  score >= 65
KEEP     all eligible (no reduction — every row passing REQUIRE survives)
OUTPUT   selected rows
```

**Reported historical attrition:**

```
1,850 → 1,110  (after REQUIRE score >= 65)
```

- **1,110 signals**, **788 event groups**, **214 events with >1 selected signal**, **max 6 signals per event**.

> **ALT2_TS_SCORE_GE_65 is NOT the Python smart-money variant.** It has no
> smart-money guard of any kind — no `smart_money_score_num` field is ever
> read by this funnel. It is the permanent **`MANDATORY_CORE_COMPARATOR`** and
> must remain in every future observational report; it is never removed,
> merged with `ALT2_PY_SCORE_GE_65_SM_LT_85`, or demoted.

## 5. ALT1_CANONICAL_EVENT_GROUPING — exact ordered funnel

```
INPUT    canonical dedup rows (1,850)
REQUIRE  score >= 72
GROUP    canonical event (buildEventGroupKey)
SORT     coverage desc
SORT     score desc
SORT     deterministic tie-break (smart-money, price band, -createdAt, stable id)
KEEP     first row per event group
STAKE    historical $10 metadata (diagnostic only — see §6)
OUTPUT   selected rows
```

**Reported historical attrition:**

```
1,850 → 355   (after REQUIRE score >= 72)
  → 274   (after GROUP/SORT/KEEP — one row per event group)
```

- **Max 1 signal per event after KEEP** (by construction — KEEP always selects exactly one row per event group).
- **Identity confidence: MEDIUM** (the canonical fallback chain resolves at the `event_slug` tier on this corpus, not the STRONG `match_family_key`/`canonical_event_key`/`parent_event_key` tiers).
- **Exploratory only** — not sufficient for production promotion (per the classifier's own `READY_EXPLORATORY_WITH_IDENTITY_LIMITATION` status).

## 6. Side-by-side matrix

| Rule | PRIMARY | ALT2 TS | ALT1 |
|---|---|---|---|
| score ≥ 65 | NO | YES | NO |
| score ≥ 72 | YES | NO | YES |
| NBA/NHL exclusion | YES | NO | NO |
| coverage/price exclusion | YES | NO | NO |
| timing exclusion | YES | NO | NO |
| canonical event grouping | YES | NO | YES |
| one-per-event KEEP | YES | NO | YES |
| smart-money filter | NO | NO | NO |

## 7. Model levels (current, exact)

| Model | Display role | Run status |
|---|---|---|
| PRIMARY_V1_AVOID_NBA_NHL_COV_CAP | `SELECTIVE_RESEARCH_CANDIDATE` | `RUNNABLE_APPROX_ONLY` |
| ALT2_TS_SCORE_GE_65 | `MANDATORY_CORE_COMPARATOR` | `VERIFIED_EXECUTABLE` |
| ALT1_CANONICAL_EVENT_GROUPING | `STRONG_WATCH_EVENT_GROUPING_CANDIDATE` | `READY_EXPLORATORY_WITH_IDENTITY_LIMITATION` |

## 8. Limitations

- None of these three funnels has a `metric_formula_version` eligibility gate (only `ALT_SM_GUARD_ON_PRIMARY`/`MODEL_A` has one in the current classifier).
- Smart-money field coverage is 0% on the current canonical export (`smart_money_score_num` is dropped by the exporter normalizer) — smart-money ordering tie-breaks and any smart-money-dependent variant remain unvalidated.
- No model in this document is a production-readiness claim.
- ALT1's event identity confidence is MEDIUM (exploratory only).
- PRIMARY is an approximate reconstruction (source self-labelled `APPROX / NEEDS_EXACT_RECON`).
- ALT2 TS's weekly PnL concentration (see Phase 3E.7 robustness audit) requires continued forward observation before any promotion decision.
