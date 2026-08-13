# 07 — Reviewer Decision Packet

Self-contained. If you have only budget to read one file besides the executive brief (file 00), read this one plus file 06.

## The choice

**A. KEEP_CURRENT_DESIGN_AND_ADD_SUPPORTING_INDEX** — apply the proposed ordered partial index on `generated_signal_pairs`, change nothing else.

**B. QUERY_SHAPE_CORRECTION** — keep the serving-table architecture and `refresh_current_signal_pair_serving`'s existence, but change how/when it's invoked (e.g. online writer compares directly against `current_signal_pair_serving` instead of re-deriving from history; see file 06 Q1/Q2) and/or change the batch-oriented backfill to a single set-based pass (file 06 Q7).

**C. SERVING_MAINTENANCE_DESIGN_CORRECTION** — the shared single-function design for bootstrap and steady-state maintenance is itself wrong; replace with two purpose-built paths.

**D. OTHER**.

## Comparison matrix

| Dimension | A (index only) | B (query shape) | C (maintenance redesign) |
|---|---|---|---|
| SEMANTIC_CORRECTNESS | unchanged — same query, same result | requires proving the direct-compare path preserves exact winner semantics for intra-batch multi-row-per-identity cases (file 06 Q2 caveat) | requires proving a new algorithm's correctness from scratch |
| TIME_TO_LIVE_CONTOUR | fastest — no code change, only DDL, if the DDL can actually be applied (item F4/production gateway limit already blocked it once) | moderate — bounded TS/SQL change, testable against existing test suite shape (`tests/feed/currentSignalPairServing.test.ts`, `tests/operations/currentServingBackfillRunner.test.ts`) | slowest — new schema/function surface, new tests, new production rollout |
| BOOTSTRAP_COST | reduced per-call cost (file 06 Q8), but repeated-recomputation pattern (Q5/Q6) unchanged | can eliminate repeated recomputation if batch backfill is redesigned per Q7 | can eliminate it by design if the redesign targets this directly |
| STEADY_STATE_WRITER_COST | reduced but still pays a historical JOIN on every insert (Q1 unresolved) | can drop to a single PK compare per insert (Q2) — real win in the hot generation path | depends on redesign shape |
| STEADY_STATE_PLANNING_COST | unaffected either way — Planning already reads only the bounded serving table (queries F/G, unconditionally history-free) | unaffected | unaffected |
| DATABASE_WRITE_AMPLIFICATION | unchanged | unchanged (same upsert) | possibly reduced if fewer redundant recomputation passes touch WAL/index maintenance |
| DATABASE_READ_AMPLIFICATION | reduced per query C call (index scan vs. seq-scan+sort) | reduced further by removing redundant calls entirely for the single-identity writer case | most reduced, if redesigned correctly |
| INDEX_STORAGE/WRITE_COST | new partial index adds write overhead on every `generated_signal_pairs` insert (a table already carrying continuous write traffic per `idx_gsp_shadow_dedup`'s own migration comment) — not free | none beyond what already exists, unless B also changes indexing | depends on redesign |
| RECOVERY_COMPLEXITY | unchanged; still no reconciler for `SERVING_PROJECTION_PENDING` (file 06 F-notes) | unchanged unless explicitly addressed | opportunity to add a reconciler as part of the redesign |
| IMPLEMENTATION_COMPLEXITY | lowest | moderate | highest |
| REGRESSION_RISK | lowest (no behavior change) | moderate — touches a function used by both writer and backfill; must not regress backfill's multi-row-per-identity correctness | highest — new code path entirely |
| MIGRATION_RISK | index build on a continuously-written, large table; existing sibling indexes in this repo were built `CONCURRENTLY` for exactly this reason (see `idx_gsp_shadow_dedup`, `idx_gsp_provider_event_context` migration comments) — the proposed index's DDL (unverified, file 04 F4) should be checked for the same `CONCURRENTLY` treatment before trusting the ~100s gateway-timeout DDL attempt as representative | low — application-code deploy, no DDL | moderate-high — new schema objects |
| OPERABILITY | still one function serving two very different call shapes — harder to reason about failure modes in isolation | two distinguishable code paths, each independently debuggable | fully separated concerns, most operable long-term but most to build |

## Direct questions the reviewer must answer

**1. Would you approve the proposed ordered partial `generated_signal_pairs` index?**
Before answering: its exact DDL was not locatable by this review (file 04, `idx_gsp_current_serving_backfill_order` and the proposed `idx_gsp_current_serving_latest_unresolved` are both absent from all reachable source — treat the column list/predicate in file 04 as an unverified claim reproduced from the mission brief, and confirm `CREATE INDEX CONCURRENTLY` is used given this table's continuous write traffic, per this repo's own established pattern).

**2. If yes, is it the correct permanent architecture, or only the fastest safe bootstrap correction?**
File 06 Q8 supports "constant-factor / per-call fix, not a fix to the repeated-recomputation pattern (Q5/Q6) or the online-writer redundant-JOIN pattern (Q1)."

**3. Should normal writer-side serving maintenance ever scan historical `generated_signal_pairs`?**
File 06 Q1/Q2: current source does, unconditionally, for every insert; a direct-compare alternative is structurally plausible for the single-fresh-row case, with one unresolved caveat (`writeGeneratedSignalPairs`'s intra-batch same-identity dedup guarantee is `UNKNOWN` — verify before trusting a direct-compare-only design change for that writer).

**4. Should bootstrap and steady-state maintenance use the same algorithm?**
Currently: yes, verified, by design (migration comment explicitly states "Reconciles either a supplied source batch (writer path) or the complete current corpus (deterministic backfill)"). File 06 Q3/Q4 shows this shared design is justified for bootstrap but not required for steady-state.

**5. Is current `refresh_current_signal_pair_serving(uuid[])` the right abstraction?**
It is a correct-but-conflated abstraction: it always does "recompute winner from history for these identities," which is necessary for bootstrap/backfill/reconciliation but overkill for a single freshly-inserted row from a writer that already knows its own recency.

**6. What is the smallest correction that can realistically close Phase 1 now without creating another multi-hour optimization branch?**
Not this review's call — see "REQUIRE FINAL OUTPUT" below.

## Required final reviewer output

```
RECOMMENDED_CLASS:
CONFIDENCE:
SMALLEST_DEFENSIBLE_CORRECTION:
WHY:
EXACT_COMPONENTS_TO_CHANGE:
COMPONENTS_NOT_TO_CHANGE:
INDEX_DECISION:
BACKFILL_DESIGN_DECISION:
STEADY_STATE_MAINTENANCE_DECISION:
EXPECTED_COST_MODEL:
PRODUCTION_PROOF_REQUIRED:
ROLLBACK_BOUNDARY:
ESTIMATED_IMPLEMENTATION_SCOPE:
```

## Explicit non-goals of this package

This package does not recommend A, B, C, or D. It does not assert the Codex diagnosis (644 rows / 6 identities / incremental sort / ~640ms) is correct — those specific numbers are unverified (file 05 item 9). It does not assert the proposed index is safe to apply as-is — its DDL was not locatable (file 04). It does not resolve the `postgres`-dependency claim beyond what current source shows (file 06 F2). It does not recommend fixing `CURRENT_STATE.yaml`'s staleness (file 06 F1) or building a `SERVING_PROJECTION_PENDING` reconciler (file 03, Query H) — both are flagged as open items for whichever class of correction the reviewer selects.
