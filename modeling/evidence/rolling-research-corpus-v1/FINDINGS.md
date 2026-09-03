# ROLLING_RESEARCH_CORPUS_7D14D30D — status: REAL 7D CORPUS OPERATIONAL

Authority SHA (origin/main): `7c22bea4f252895fbc3e6ce0cff5074a01b2788d` (PR #234).

## Mission chain

1. `ROLLING_RESEARCH_CORPUS_7D14D30D_V1` — built the rolling interface (pure
   manifest/index + CLI + tests). Halted before backfill on a canonical
   population-classifier defect.
2. `RESEARCH_CORPUS_POPULATION_CLASSIFIER_CORRECTION_V1` — removed the
   `decisionAt month == 2026-08` shortcut in `derivePopulationId`
   (`lib/modeling/forward-rich/materializeForwardRichResearch.ts`). Now
   producer/predicate driven only; `AUG_SHADOW_C4_V1` reachable ONLY via explicit
   `pair.populationId`. Regression suite `derivePopulationId.test.ts` (8 tests).
3. `ROLLING_RESEARCH_CORPUS_7D14D30D_RESUME_V1` — this file. Real 7d backfill +
   proof.

## 7d rolling corpus — REAL, COMPLETE

`WINDOW = 2026-08-27 … 2026-09-02`, `PARTITION_N = 7`, `WINDOW_COMPLETE = true`.

Seven immutable D-1 partitions, each `RELEASE_STATUS = ACCEPTED_IMMUTABLE`,
canonical-content hash == manifest == `SHA256SUMS_<date>.txt`, populations
`[SEP_PUBLIC_RICH_V1, SEP_SHADOW_STRATEGIC_V1]` only:

| date | rows | canonical hash (16) | LABEL_EVIDENCE_AS_OF |
|---|---|---|---|
| 2026-08-27 | 1084 | b8d69fbfe3ae1334 | 2026-09-03T13:50:51.239Z |
| 2026-08-28 | 1105 | 3bd8e76e21a0a966 | 2026-09-03T13:51:29.825Z |
| 2026-08-29 |  850 | 66889b4bf0d0d627 | 2026-09-03T13:52:09.716Z |
| 2026-08-30 | 1056 | d73f547d2494a4c0 | 2026-09-03T13:52:43.749Z |
| 2026-08-31 |  920 | c46668b3f570da8c | 2026-09-03T13:53:24.688Z |
| 2026-09-01 | 1128 | 9681b7acccd2f692 | 2026-09-03T13:54:02.591Z |
| 2026-09-02 | 1137 | 0e06fd869462118b | 2026-09-03T12:22:51.565Z (unchanged, accepted) |

`2026-09-02` `CANONICAL_CONTENT_SHA256` re-verified on disk:
`0e06fd869462118b79138cf6741c188f2d58c551f3f8023eadbc6b18eb2d7287` — untouched.
6 missing days were materialized once each, clone-only, bounded keyset reads,
`PRODUCTION_PRIMARY_READS: 0` / `PRODUCTION_WRITES: 0`; no accepted partition
overwritten.

### Cross-day identity (distinct counts, never a single funnel)

| count | value | UNIT | SOURCE_STAGE |
|---|---|---|---|
| WINDOW_PRE_COLLAPSE_ROW_N | 7280 | Σ frozen compact rows over the 7 partitions | WINDOW_PRE_COLLAPSE |
| WINDOW_UNIQUE_SELECTION_N | 4557 | distinct (population_id, condition_id, selected_token_id) | WINDOW_UNIQUE_SELECTION |
| WINDOW_UNIQUE_PHYSICAL_EVENT_SELECTION_N | 1686 | distinct (population_id, provider_event_id) among unique selections | WINDOW_UNIQUE_PHYSICAL_EVENT |

Collapse rule: a selection identity present in >1 partition → its earliest-DECISION_AT
frozen row (first decision). INPUT_DENOMINATOR 7280 → OUTPUT_DENOMINATOR 4557 for the
pre-collapse → unique-selection reduction only.

### Required 7d output (per population, frozen labels)

| | SEP_PUBLIC_RICH_V1 | SEP_SHADOW_STRATEGIC_V1 |
|---|---|---|
| WINDOW_DAYS | 7 | 7 |
| PARTITION_N | 7 | 7 |
| INPUT_ROWS (pre-collapse) | 1732 | 5548 |
| UNIQUE_SELECTION_N | 1700 | 2857 |
| SETTLED_N | 1413 | 1405 |
| OPEN_N | 287 | 1452 |
| NO_MATCH_N | 0 | 0 |
| SCORE_NUMERIC_COVERAGE | 0.0% (0) | 0.0% (0) |
| VOLUME_USD_COVERAGE | 0.0% (0) | 77.49% (2214) |
| PRICE_PATH_COVERAGE | 82.47% (1402) | 5.32% (152) |
| LEAD_TIME_COVERAGE | 100% (1700) | 5.32% (152) |
| PIT_FUTURE_LEAK_N | 0 | 0 |

`PIT_FUTURE_LEAK_N = 0` across the full window (recomputed from frozen rows).
Populations reported separately — `POPULATION_POOLING: FORBIDDEN`, never summed.
No `AUG_SHADOW_C4_V1` row in any of the 7,280 rows.
`LABEL_AS_OF_OVERLAY` preserved (separate fresher-settlement view; never written
back into a frozen artifact; Gamma remains authority).

### Local consumption proof

`--read-proof`: `DB_READS: 0`, `BROAD_SCANS: 0`, 7 partitions streamed, 7,280
rows / 679,433 compressed bytes, `MATCHES_MANIFEST_PRE_COLLAPSE: true`. The
rolling manifest references partition `CANONICAL_CONTENT_SHA256` values —
`PARTITION_HASH_REFERENCES_ONLY: true`, no duplicated 7d payload.

## 14d / 30d — same interface, accumulating

No separate implementation — one `buildRollingManifest` / one CLI, `--window
7|14|30`. Built now over the 7 available partitions:

| window | WINDOW_START | AVAILABLE_PARTITION_N | MISSING_PARTITION_N | MISSING_DAYS |
|---|---|---|---|---|
| 14d | 2026-08-20 | 7 | 7 | 2026-08-20 … 2026-08-26 |
| 30d | 2026-08-04 | 7 | 23 | 2026-08-04 … 2026-08-26 |

Both: `PIT 0`, `DB_READS 0`, `BROAD_SCANS 0`, `MATCHES_MANIFEST_PRE_COLLAPSE true`,
`WINDOW_COMPLETE false`. They auto-complete with no code change as each missing
D-1 partition is materialized (proven: the CLI recomputes AVAILABLE/MISSING and
rebuilds from whatever partitions are on disk). Not materialized here — mission
budget; primary business result (real 7d) is met.

## Tests

`npm run test:modeling:forward-rich` → **31/31 PASS**
(16 pre-existing forward-rich untouched + 8 classifier-correction + 7 rolling).

## Boundaries honoured

No new population semantics, no D-1 identity/PIT/settlement change, no accepted
artifact overwrite, no Score/Volume/Exact-Score/C4/Contract-A work, no production
scan/write, no schema/migration, no clone-sync change, no Ireland. Work isolated
in worktree `.worktrees/rolling-research-corpus-v1` on branch
`claude/rolling-research-corpus-7d14d30d-v1`; founder root untouched; uncommitted.

Next transition: `ROLLING_RESEARCH_CORPUS_CANONICAL_RELEASE_V1`.
