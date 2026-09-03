# ROLLING_RESEARCH_CORPUS_30D_BACKFILL_CHUNK_A_V1 — FINDINGS

Authority: live `origin/main` = `49fed489f389d56530c411f59f083ad8a1e5ea2f` (PR #237, canonical REAL 14D present).
Executor worktree: `.worktrees/rolling-30d-chunk-a-v1` (dedicated, clean at start).
Clone: `nppznoujvnyjargjkmnv` (RESEARCH_CLONE) — fail-closed guard passed on every run; production primary never read.

## What was materialized

Eight NEW immutable D-1 partitions for exactly **2026-08-04 … 2026-08-11**, via the already-canonical
clone-only Score-LEVEL-capable path:
`live-d1-research-corpus.ts --d1 <D>` → `freeze-d1-research-corpus.ts --d1 <D>`.

All eight: `RELEASE_STATUS=ACCEPTED_IMMUTABLE`, `PIT_FUTURE_LEAK_N=0`, `NO_MATCH_N=0`,
recomputed `CANONICAL_CONTENT_SHA256` == MANIFEST == SHA256SUMS.

| D-1 | INPUT_RAW | OBS | OUT_COMPACT | SETTLED | OPEN | CANONICAL_CONTENT_SHA256 |
|---|---|---|---|---|---|---|
| 2026-08-04 | 1026 | 2695 | 627  | 402 | 225 | 8548378e3eb2d9a9e95098c8e3e2664498ca453d24e8843bc62579607223fda1 |
| 2026-08-05 | 1331 | 2246 | 1014 | 549 | 465 | 2aba9363192f51b94f14bbf5b445659666af5454ffc003038c25ff879dace033 |
| 2026-08-06 | 1132 | 2111 | 1122 | 838 | 284 | 9bbefd28ede4b80642524eab5d04f97812f231c2c6b9839d669a39ae9ec395bf |
| 2026-08-07 | 1007 | 2689 | 744  | 447 | 297 | b7ab559e65ea47c0a8a9ce2795a44390f75fa80df94a64b86ecb57e38630e814 |
| 2026-08-08 | 1004 | 3256 | 901  | 485 | 416 | 52ff5d624c28705550082ac746bbed3699d22bfda7d15a3f131074f6a3899857 |
| 2026-08-09 | 1007 | 505  | 986  | 516 | 470 | be32d2215c0d1174e442327de79b743cc23df0907878a4f722568989ab44eb4b |
| 2026-08-10 | 1008 | 591  | 977  | 537 | 440 | 1a9e644d9ec5471173e7d020b5fcef06d442b25a9accf6fe63ba8abb07bee8f9 |
| 2026-08-11 | 1263 | 1718 | 1176 | 632 | 544 | 9ed792d412db7e4b68fba1396adadcf2de90989f4972669341c5a1c91f7cf4dc |

UNIT of INPUT_RAW = `generated_signal_pairs` decision rows (repeated emissions included),
SOURCE_STAGE INPUT_RAW. OUT_COMPACT = one first-eligible compact row per canonical identity,
SOURCE_STAGE OUTPUT_COMPACT. SETTLED/OPEN SOURCE_STAGE OUTPUT_COMPACT_LABEL (Gamma/CLOB
terminal authority, AS-OF each run). OPEN counts reflect month-old markets whose Gamma lookup
returned no terminal state as-of run time — this is the immutable AS-OF label model, not a defect.

### Per-population (never pooled), per new partition

Each partition manifest `POPULATIONS[]` carries `COMPACT_ROW_N`, `COMPACT_PHYSICAL_EVENT_N`
(distinct `provider_event_id`), `LABEL_COUNTS`. Populations present: `SEP_PUBLIC_RICH_V1`,
`SEP_SHADOW_STRATEGIC_V1`. Counts are per `population_id` and never summed.

## Score LEVEL

- `SEP_PUBLIC_RICH_V1`: `scoreLevel` present on 100% of rows across all 8 new days, carried
  verbatim from `generated_signal_pairs.pre_event_score_num` with `scoreLevelSource` tag.
  30d-window LEVEL range 53..81 (SCORE_LEVEL_COVERAGE_PCT=100, INPUT_DENOMINATOR=4430).
- `SEP_SHADOW_STRATEGIC_V1`: structural null — `scoreLevel=null` on 100% of rows, never
  synthesized (SCORE_LEVEL_COVERAGE_PCT=0).
- Score LEVEL and Score SERIES stay distinct: `scoreLevel`/`scoreLevelSource` vs `score`
  (series). Confirmed by `tests/modeling/forward-rich/scoreLevel.test.ts`.

## Regenerated 30d rolling manifest

`ROLLING_MANIFEST_30d_2026-09-02.json` — `rolling-research-corpus.ts --window 30` report-only
(NO `--materialize-missing`; 2026-08-12..2026-08-19 deliberately untouched):

- WINDOW_START=2026-08-04, WINDOW_END=2026-09-02, WINDOW_COMPLETE=false
- AVAILABLE_PARTITION_N=22, MISSING_PARTITION_N=8
- MISSING_DAYS = 2026-08-12, -13, -14, -15, -16, -17, -18, -19 (exactly)
- PARTITION_HASH_REFERENCES_ONLY=true, PRODUCTION_PRIMARY_READS=0
- PIT_FUTURE_LEAK_N (WINDOW_UNIQUE_SELECTION) = 0
- read-proof: DB_READS=0, BROAD_SCANS=0, PARTITIONS_STREAMED=22, ROWS_STREAMED=22128,
  MATCHES_MANIFEST_PRE_COLLAPSE=true

### 30d window per-population (from regenerated manifest; never pooled)

| population_id | INPUT_ROWS | UNIQUE_SELECTION_N | UNIQUE_PHYSICAL_EVENT_SELECTION_N | Score LEVEL cov | Score SERIES cov | Volume cov | price-path cov | lead-time cov | LABEL_COUNTS_FROZEN |
|---|---|---|---|---|---|---|---|---|---|
| SEP_PUBLIC_RICH_V1     | 4507  | 4430  | 1937 | 100% (53–81) | 0% | 0%     | 88.2%  | 100%  | WIN 1530 / LOSS 1537 / OPEN 1363 |
| SEP_SHADOW_STRATEGIC_V1 | 17621 | 11263 | 845  | 0% (null)    | 0% | 38.9%  | 3.3%   | 50.2% | WIN 2921 / LOSS 3045 / OPEN 5297 |

## Immutability / boundaries

- All 14 existing accepted partitions 2026-08-20..2026-09-02: byte-identical, zero git changes,
  recomputed canonical hashes == baseline captured before any write.
- No production DB read/write/fallback. No schema/migration/settlement/PIT/identity redesign.
- No PnL/ROI/scorecard/threshold/candidate evaluation.
- 2026-08-12..2026-08-19 NOT materialized.
- No new helper script; no full build; no adjacent architecture inspection.
- Focused tests: `tests/modeling/forward-rich/{compactCorpus,rollingCorpus,scoreLevel,derivePopulationId}.test.ts` → 26/26 PASS.

## Not committed

Per mission item 12 + CLAUDE.md §5, no commit/push/PR performed. Artifacts persist in the
dedicated worktree branch `claude/rolling-research-corpus-30d-backfill-chunk-a-v1` pending one
Founder approval to land via FEATURE_BRANCH → PR → MERGE.
