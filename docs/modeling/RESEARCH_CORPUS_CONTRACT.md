# RESEARCH_CORPUS_CONTRACT.md — PolyProPicks PREMVP Research Corpus Contract

Status: **CONTRACT FROZEN** (bounded architecture freeze, not implementation).
Authority: this file is a modeling contract only. It does **not** edit or override
`CURRENT_STATE.yaml`, and it changes no application code, schema, migration, cron,
Supabase, or Railway configuration.
Next semantic transition: **COMPACT_RESEARCH_MATERIALIZER_V1**.

## 0. Purpose and non-goals

The next implementation mission extends the **existing** forward-rich materializer
(`lib/modeling/forward-rich/`) into a compact, fast, population-aware **daily
modeling corpus**. This contract freezes only the minimum needed to do that
without reopening architecture.

Single optimization objective: **rapidly compare models by positive PnL units,
ROI, MaxDD, number of bets / unique events, and week-by-week stability as the
forward dataset grows daily.**

Explicit non-goals (HARD BOUNDARIES):
- No new feature store / warehouse / orchestration / OLAP platform. (`R33`, `R34`)
- No new model thresholds, no hypothesis mining, no taxonomy.
- No redefinition of Contract A as offline-replayable (see §5.4).
- Score *movement* is **not** a near-term requirement where numeric Score
  observations do not exist (see §4).
- Not optimized for theoretical ML completeness — optimized for PnL/ROI iteration.

## 1. Populations

`population_id` is **mandatory** on every corpus row, every manifest, and every
scoreboard row. **No pooled August + September performance claim** may be made
across these producer populations — they have incompatible producers and
eligibility rules.

| population_id | Producer / predicate | Nature | Immutability |
|---|---|---|---|
| `AUG_SHADOW_C4_V1` | Historical August shadow benchmark. Selector `model=C4`, decision period `2026-08-05..2026-08-25`. Frozen numbers: N=4,117, PnL +474.56u, ROI 11.5269%, MaxDD −16.41u (`lib/modeling/forward-rich/augustFrozenResearchContext.ts`). | Historical, fixed window | **IMMUTABLE** — never recomputed, never extended, never pooled forward |
| `SEP_SHADOW_STRATEGIC_V1` | September forward shadow-strategic population. Predicate `generated_signal_pairs.formula_version = 'shadow-strategic-sports-v1'` — the disjoint **unscored** strategic population. | Forward, grows daily | Append-only; frozen daily partitions |
| `SEP_PUBLIC_RICH_V1` | September forward public / rich scorer population. Scored path (`signal_confidence_num >= 50`), producer lineage one of `PUBLIC_PATH_ENRICHMENT` \| `S2_WIDE_SCORER` \| `S2_DIRECT_UNSCORED` as recorded in `diagnostics.scoreObservation`. | Forward, grows daily | Append-only; frozen daily partitions |

Rules:
- August is a benchmark reference only. A model's forward record is stated
  against exactly one September `population_id`.
- The three frozen August diagnostic hypotheses (`soccer_first_to_score`,
  `soccer_exact_score`, `uwcl`) remain `FROZEN_DIAGNOSTIC_HYPOTHESIS /
  NOT_FORWARD_VALIDATED / NO_PRODUCTION_MODEL_CHANGE`. They are evaluation keys
  for forward rows, not thresholds.
- A cross-population comparison is only ever presented side-by-side with distinct
  `population_id` labels, never summed.

## 2. Canonical identity (repository-supported, frozen)

Reuse the exact identity the repository already enforces — no fuzzy or
re-derived identity (`R23`).

| Concept | Canonical field(s) | Source of authority |
|---|---|---|
| Physical / provider event | `provider_event_id` — equal to Gamma `event.id` (PROVEN 20/20 exact) | `generated_signal_pairs` / GSRS `event_id`; Gamma events API |
| Market / condition | `condition_id` (0x… hex) | `generated_signal_pairs.condition_id`; GSRS `condition_id` |
| Selected token / side | `selected_token_id` (current canonical; historical exporter alias `token_id`) — scalar only; array/object fails closed as `AMBIGUOUS` | `lib/modeling/generatedSignalPairsExportContract.ts` token precedence |
| Strict dedup key | `condition_id` + `selected_token_id` | Producer dedup + export contract |
| Decision timestamp (`DECISION_AT`) | `generated_signal_pairs` decision/source timestamp (row `created_at` for the immutable corpus) | `generated_signal_pairs` |
| Historical lineage key | `generated_signal_pairs.id` (UUID) — never reused as a serving/corpus primary key | `generated_signal_pairs` |

The corpus row identity is `(population_id, condition_id, selected_token_id,
DECISION_AT)`. Rows missing `condition_id` or `selected_token_id` are `NO_MATCH`
(see §5) and excluded from any PnL/ROI aggregate.

## 3. Feature grain — compact decision-time PIT grain

One immutable point-in-time feature row per corpus identity (§2), carrying the
four instants **kept distinct** (never conflated):

- `DECISION_AT` — signal decision timestamp (`generated_signal_pairs`)
- `FEATURE_OBSERVED_AT` — GSRS `snapshot_at` a value was observed
- `SOURCE_CREATED_AT` — immutable source row creation instant
- `MATERIALIZED_AT` — when the materializer produced the row

Point-in-time rule (unchanged from `FORWARD_RICH_CAPTURE_V1`): only observations
with `FEATURE_OBSERVED_AT <= DECISION_AT` may become features. No post-decision
leakage, no current-value backfill.

**"First eligible row" semantics are preserved without retaining every repeated
GSP / GSRS emission.** The existing `DerivedSeries` shape is the frozen
compression: for each series (score, selected price) retain only
`{ firstEligibleValue, firstEligibleObservedAt, lastEligibleValue,
lastEligibleObservedAt, observationCount, delta }`. This is change-point / endpoint
compression — sufficient to reproduce the first-eligible decision-time value and a
single move magnitude, without storing the full emission stream. If a later
mission shows endpoint compression loses a needed signal, it adds interior
change-points to `DerivedSeries` — it does **not** revert to full emission storage.

Frozen BASE fields per row: `entryPrice`, `eventStart`, `leadTimeHours`, `sport`
(`provider_sport_code` \| `provider_sport_family`), `formulaVersion`,
`marketTypeRaw`, `marketFamily`, `dataCoverage`. All reused verbatim from the
immutable signal-side classification — never re-derived.

## 4. Observation grain — smallest long-form layer

The only long-form (multi-row-per-identity) layer permitted is the **already
immutable** `generated_signal_research_snapshots` (GSRS) ledger. The corpus does
not create its own observation table.

Observation coverage, in priority order:
1. **Price path** — GSRS `selected_price_num` / `opposing_price_num` per
   `snapshot_at`. Available and used.
2. **Volume** — `generated_signal_pairs.diagnostics.volumeUsd` verbatim, tagged
   `volumeSemantic = "generated_signal_pairs.diagnostics.volumeUsd"`, carrying
   `volumeSourceCreatedAt`. **Never merged** with rolling inventory volume.
3. **Score where numeric Score actually exists** — GSRS
   `diagnostics.scoreObservation.scoreValue` with its `metricFormulaVersion`.
   Where no numeric Score observation exists for an identity, the score
   `DerivedSeries` is null-valued (`observationCount = 0`) and **Score movement is
   not a feature for that row** — this is not a defect and is not backfilled.

**Do not create fixed-anchor (T-24 / T-6 / T-1) storage.** Lead-time slices, if
ever needed, are derived at query time from `(FEATURE_OBSERVED_AT, eventStart)`
against the endpoint-compressed series — not persisted as anchor columns.

## 5. Labels — separate from immutable PIT features

### 5.1 Separation
Labels live in a **distinct** label layer keyed by corpus identity (§2). They are
never written into the immutable §3 feature row. A feature row is frozen at
materialization; its label is attached and later updated as settlement resolves.

### 5.2 Settlement authority
**Gamma terminal event state is the settlement authority.** `provider_event_id =
Gamma event.id` gives the terminal label via the public Gamma events API
(PROVEN at ≥200k-window scale).

The research-clone `signal_result` column is **not** research settlement
authority — evidence `RECENT_RESERVATION_GAMMA_SETTLED_V1` shows 30/30 recent
Gamma-settled reservations are `NULL` in `generated_signal_pairs.signal_result`
(a writer coverage gap, not an absence of settlement). Clone `signal_result` may
be recorded as a secondary cross-check field only, never as the label source.

### 5.3 Label semantics
| Label | Meaning |
|---|---|
| `WIN` | Gamma terminal outcome resolves the `selected_token_id` side as the winning outcome. |
| `LOSS` | Gamma terminal outcome resolves the `selected_token_id` side as losing. |
| `VOID` | Gamma terminal state is cancelled / refunded / 50-50 / no-contest — bet returns stake; excluded from ROI numerator, included in `settled N` with 0 PnL. |
| `OPEN` | Event not yet terminal in Gamma. Excluded from PnL/ROI; counted in corpus N and model-eligible N. |
| `NO_MATCH` | Identity cannot be resolved to a Gamma event/outcome (missing/blank `condition_id` or `selected_token_id`, or no Gamma event for `provider_event_id`). Excluded from every aggregate. |
| `AMBIGUOUS` | Gamma event found but outcome→token mapping is not 1:1, or token identity is array/object. Quarantined; excluded from PnL/ROI; surfaced in DATA QUALITY. |

### 5.4 Contract A replay constraint
Contract A is **not** offline-replayable and this contract does not treat it as
such. Live evidence `CONTRACT_A_VS_C4_PREDICATE_DIFFERENCE_V1` (verdict D,
`COMMON_UNIVERSE_INSUFFICIENT`): replaying the proven predicate over the only
reconstructable candidate pool reproduced **3 of 330** actual selections. Model
comparison in this corpus is done on **materialized decision rows that were
actually emitted**, not on a reconstructed planning universe. Any future
offline-replay claim requires new live repository evidence that disproves the
3/330 finding.

## 6. AS-OF dataset — lightweight daily manifest

Each daily run emits one manifest (JSON) — the reproducible unit of the corpus:

```
{
  "manifest_version": "research-corpus-contract-v1",
  "population_id": "SEP_PUBLIC_RICH_V1",
  "as_of_date_minsk": "2026-09-03",
  "decision_date_range": { "from_inclusive": "...", "to_inclusive": "..." },
  "immutable_historical_artifacts": [
    { "id": "AUGUST_C4_BASELINE", "sha256": "...", "path": "..." }
  ],
  "frozen_daily_partitions": [
    { "partition_date": "2026-09-02", "rows": N, "sha256": "...", "sealed": true }
  ],
  "counts": { "rows": N, "unique_events": N, "bets": N, "settled": N, "open": N,
              "void": N, "no_match": N, "ambiguous": N },
  "feature_coverage": { "score_numeric_pct": 0.0, "price_path_pct": 0.0,
                        "volume_usd_pct": 0.0, "lead_time_pct": 0.0 },
  "versions": {
    "materializer_git_sha": "...",
    "formula_versions_present": ["shadow-strategic-sports-v1", "..."],
    "score_metric_formula_versions_present": ["..."],
    "clone_sync_version": "research-clone-daily-sync-v1",
    "since_cutoff": "<ISO>"
  }
}
```

Rules:
- Daily partitions are **frozen once sealed**; a later run appends new partitions
  and updates only labels (§5.1) — it never rewrites a sealed partition's
  features.
- Immutable historical artifacts are referenced by `sha256`, never regenerated.
- Deterministic reproduction = same `materializer_git_sha` + same
  `since_cutoff` + same immutable clone inputs ⇒ byte-identical feature rows
  (the materializer core is already pure / clock-free / order-stable).

## 7. Raw retention — bounded clone policy

Starting point: the accepted independent review recommendation, `NEW_CONTOUR_9`
risk register class **E (offline / non-blocking)**, rows `R31` / `R32`.

Frozen policy (small and reversible):
- The research clone (`nppznoujvnyjargjkmnv`) is the raw source of record for the
  three synced tables: `generated_signal_pairs` (keyset `created_at,id`),
  `generated_signal_research_snapshots` (`snapshot_at,id`),
  `night_event_reservations` (`plan_date_minsk,id`). Append + bounded 72h
  reconciliation sweep, per `lib/research-clone/dailySync.ts`.
- **Retain the full clone of all three tables** for the PREMVP period — it is the
  only rematerialization/recovery substrate and is cheap at ~10k signal
  observations/day. No pruning of the clone.
- Each daily corpus run additionally writes a **validated raw export snapshot**
  (row counts + `sha256` per table, recorded in the manifest §6). Every export is
  validated on write; a failed checksum ⇒ re-export from the clone (`R32`
  recovery). No Parquet/DuckDB lake is required for PREMVP — a compressed
  JSON/JSONL export plus checksums is sufficient and is the reversible default.
- Analytics never touch the production primary — clone only (`R07` / `R31`).
- Retention is revisited (not automatically extended) only when a measured
  storage or cost boundary is hit; size alone is not a trigger.

## 8. Founder model scoreboard — required output shape

Every model run emits exactly this shape (one block per `(Model, population_id,
Period)`):

### PRIMARY
| Field | Definition |
|---|---|
| Model | model id (e.g. `C4`, or a named challenger) |
| Population | `population_id` (§1) — never blank, never pooled |
| Period | decision-date range (inclusive) |
| Unique eligible events | distinct `provider_event_id` among model-eligible settled rows |
| Bets | count of model-eligible rows with a terminal label (`WIN`/`LOSS`/`VOID`) |
| PnL units | Σ realized units (stake-normalized); `VOID` = 0 |
| ROI | PnL units ÷ total staked units on `Bets` |
| MaxDD | maximum peak-to-trough drawdown of cumulative PnL over the ordered bet sequence (units) |

### STABILITY (ISO-week buckets over Period)
| Field | Definition |
|---|---|
| weekly Bets | bets settled in the week |
| weekly PnL | realized units in the week |
| weekly ROI | weekly PnL ÷ weekly staked units |
| cumulative PnL | running Σ PnL through end of week |
| positive weeks / total weeks | count of weeks with PnL > 0 over weeks with ≥1 bet |

### VELOCITY
| Field | Definition |
|---|---|
| PnL per 100 bets | PnL units ÷ Bets × 100 |
| units per week | PnL units ÷ number of weeks with ≥1 bet |

### DATA QUALITY
| Field | Definition |
|---|---|
| total corpus N | all rows for the population in Period |
| model-eligible N | rows passing the model predicate |
| settled N | model-eligible rows with a terminal label |
| feature coverage | `{ score_numeric_pct, price_path_pct, volume_usd_pct, lead_time_pct }` over model-eligible N; also report `open / void / no_match / ambiguous` counts |

Ordering of the bet sequence for MaxDD and cumulative PnL is by `DECISION_AT`
then strict dedup key (matches the materializer's deterministic row order).

## 9. Implementation handoff — narrow delta for the next mission

**Extend the existing forward-rich materializer. Do not build a new modeling
platform.**

Concrete delta for `COMPACT_RESEARCH_MATERIALIZER_V1`:
1. Add a mandatory `population_id` input + output field to
   `lib/modeling/forward-rich/types.ts` and
   `materializeForwardRichResearch.ts`; partition the run by the §1 predicates
   (August benchmark stays read-only from `augustFrozenResearchContext.ts`).
2. Add a **label layer** (§5) — a separate structure keyed by corpus identity,
   populated from Gamma terminal state; never written into the frozen feature
   row. Record clone `signal_result` only as a secondary cross-check.
3. Emit the **daily manifest** (§6) and the **validated raw export snapshot**
   (§7) from `scripts/modeling/forward-rich-materialize.ts` (currently dry-run by
   default; keep `--write` a no-op unless a target exists).
4. Add a **scoreboard reducer** (§8) — pure function over sealed partitions +
   label layer producing the PRIMARY / STABILITY / VELOCITY / DATA QUALITY block.
5. Keep the pure core clock-free, I/O-free, and order-stable. No schema, no
   migration, no cron, no production write.

Everything else in `lib/modeling/forward-rich/` (four-instant time contract,
point-in-time rule, `DerivedSeries` compression, verbatim volume semantic,
append/cutoff) is **reused unchanged**.

---

## Freeze evidence (inspected origin/main = `67aec34`)

- Forward-rich materializer: `lib/modeling/forward-rich/materializeForwardRichResearch.ts`,
  `types.ts`, `index.ts`, `augustFrozenResearchContext.ts`;
  `docs/ai-context/FORWARD_RICH_RESEARCH_CONTEXT.md` (`FORWARD_RICH_CAPTURE_V1`, merge `9468f6f`).
- Clone sync: `lib/research-clone/dailySync.ts`, `scripts/research-clone-daily-sync.ts`
  (three tables, keyset fields, 72h reconcile; merges `a4bc602`, `150a57e`).
- Identity: `lib/modeling/generatedSignalPairsExportContract.ts` (strict dedup key,
  token precedence, ambiguous-fails-closed).
- Populations / August frozen numbers: `lib/modeling/forward-rich/augustFrozenResearchContext.ts`;
  shadow-strategic predicate from memory `expanded-strategic-corpus-population-mismatch`.
- Settlement authority: memory `polymarket-event-label-path-proven`; branch evidence
  `RECENT_RESERVATION_GAMMA_SETTLED_V1` (`dc30374`) — 30/30 Gamma-settled, `signal_result` NULL.
- Contract A replay: branch evidence `CONTRACT_A_VS_C4_PREDICATE_DIFFERENCE_V1` (`c680d05`) — 3/330.
- Raw retention: `docs/ai-context/control-plane/NEW_CONTOUR_9.md` +
  `NEW_CONTOUR_9_RISK_REGISTER.md` rows `R07`, `R31`, `R32` (class E).

No material contradiction with the accepted review premises was found on live
origin/main. Outcome: contract frozen (`PASS`), not `CORRECTION_REQUIRED`.

---

## V1 implementation status — `COMPACT_RESEARCH_MATERIALIZER_V1`

Landed alongside this contract (not released):

- `lib/modeling/forward-rich/types.ts` — `PopulationId`, `GammaTerminalState`,
  `CorpusLabel`; `populationId` (mandatory) + label layer + `rawEmissionsCollapsed`
  on `ForwardRichResearchRow`.
- `lib/modeling/forward-rich/materializeForwardRichResearch.ts` —
  `derivePopulationId` (§1 predicate) + Gamma-only `deriveLabel` (§5); new fields
  emitted. Pure core otherwise unchanged.
- `lib/modeling/forward-rich/compactCorpus.ts` — `collapseRepeatedEmissions`
  (repeated GSP emissions → first eligible row, §3), `buildCompactCorpus`
  (compact rows + compression funnel, populations kept separate),
  `toResearchEngineInputs` + `runCompactC4Scorecard` (frozen C4 runs unchanged
  on the compact output, §8 V1 subset).
- `scripts/modeling/build-compact-d1-fixture.ts` +
  `scripts/modeling/compact-research-materialize.ts` (`npm run modeling:compact-research`).
- Tests: `tests/modeling/forward-rich/compactCorpus.test.ts` (+ existing suite).
- Proof: `modeling/evidence/compact-research-materializer-v1/`.

D-1 slice input is a **deterministic fixture** — this environment has no
research-clone-scoped read credential and §7 forbids modelling reads against the
production primary. Swapping the fixture loader for a live clone read is a
wiring-only follow-up (`RESEARCH_CLONE_RUNTIME_ACTIVATE_VERIFY_V1`); the compact
materializer and C4 proof are identical either way.

Next semantic transition: **COMPACT_CORPUS_FORWARD_MODEL_SCOREBOARD_V1**.
