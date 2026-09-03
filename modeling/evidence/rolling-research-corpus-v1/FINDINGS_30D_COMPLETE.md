# ROLLING_RESEARCH_CORPUS_30D — COMPLETE (Chunk A + Chunk B)

Authority: live `origin/main` = `49fed489f389d56530c411f59f083ad8a1e5ea2f` (PR #237, REAL 14D canonical).
Executor branch/worktree: `claude/rolling-research-corpus-30d-backfill-chunk-a-v1` (Chunk A continued, not re-created).
Clone: `nppznoujvnyjargjkmnv` (RESEARCH_CLONE) — runtime fail-closed guard passed on every run; production primary never read.
Nothing committed / pushed / released — canonical release is the next transition (`CANONICALIZE_REAL_30D_RESULT_V1`).

## Chunk B — 8 final partitions 2026-08-12 … 2026-08-19

`live-d1-research-corpus.ts --d1 <D>` → `freeze-d1-research-corpus.ts --d1 <D>`, one date at a time.
All: `RELEASE_STATUS=ACCEPTED_IMMUTABLE`, `PIT_FUTURE_LEAK_N=0`, `NO_MATCH_N=0`, recomputed
`CANONICAL_CONTENT_SHA256` == MANIFEST == SHA256SUMS.

| D-1 | INPUT_RAW | OBS | OUT_COMPACT | SETTLED | OPEN | CANONICAL_CONTENT_SHA256 |
|---|---|---|---|---|---|---|
| 2026-08-12 | 1019 | 1520 | 1013 | 462 | 551 | a1b79ebebe19a8bafffbddc588245258e06e6f902b9b30a2543b2028e85c5e56 |
| 2026-08-13 | 1227 | 856  | 1137 | 599 | 538 | 22be899a7450d53aa7e90847501c3e2801ff3e25d216acc98c2c9e3c5993267d |
| 2026-08-14 | 1201 | 1666 | 1133 | 673 | 460 | 1205ed2f796b6d667c65226f23cd4c85ee0d93bb0e49fd088a48102db921cbb4 |
| 2026-08-15 | 1210 | 1597 | 1126 | 606 | 520 | 456340b55b9e207e11d8e9a3e79ac632b23eb5346f5a799a32e9a6882e435f7f |
| 2026-08-16 | 1186 | 1493 | 1106 | 631 | 475 | 685c55d196677d09f51bd4b67b6560f84d7eeabae76bf6f13f5d64fabd3caff9 |
| 2026-08-17 | 1444 | 1081 | 1113 | 562 | 551 | 2a237eb6f21be3c9bde46106a36fa820cf14a43df37e524cf7ea73479746c817 |
| 2026-08-18 | 1004 | 1585 | 943  | 480 | 463 | 83ebd492ee20bee121cf4eb6cb203499f0810cf66adca7232d0ef5794673ac5f |
| 2026-08-19 | 1001 | 2373 | 997  | 573 | 424 | 9b66d2a932bc8c968f65ebdb72cb56b5d7b936c59fc4ad70b25876182717f793 |

UNIT: INPUT_RAW = `generated_signal_pairs` decision rows (repeated emissions incl.), SOURCE_STAGE INPUT_RAW.
OBS = `generated_signal_research_snapshots` rows, SOURCE_STAGE INPUT_RAW_OBSERVATION.
OUT_COMPACT = one first-eligible compact row per canonical identity, SOURCE_STAGE OUTPUT_COMPACT.
SETTLED/OPEN SOURCE_STAGE OUTPUT_COMPACT_LABEL (Gamma/CLOB terminal authority, immutable AS-OF each run).

Per-partition per-population `LABEL_COUNTS` / `COMPACT_PHYSICAL_EVENT_N` in each `MANIFEST_<D>.json` `POPULATIONS[]`.

## Chunk A integrity re-check (pre-Chunk-B gate)

All 8 Chunk-A partitions 2026-08-04..2026-08-11 re-verified against the previously-proven hashes —
byte-identical, `RELEASE_STATUS=ACCEPTED_IMMUTABLE`, recomputed canonical == MANIFEST == SHA256SUMS.
Not re-materialized.

| D-1 | CANONICAL_CONTENT_SHA256 |
|---|---|
| 2026-08-04 | 8548378e3eb2d9a9e95098c8e3e2664498ca453d24e8843bc62579607223fda1 |
| 2026-08-05 | 2aba9363192f51b94f14bbf5b445659666af5454ffc003038c25ff879dace033 |
| 2026-08-06 | 9bbefd28ede4b80642524eab5d04f97812f231c2c6b9839d669a39ae9ec395bf |
| 2026-08-07 | b7ab559e65ea47c0a8a9ce2795a44390f75fa80df94a64b86ecb57e38630e814 |
| 2026-08-08 | 52ff5d624c28705550082ac746bbed3699d22bfda7d15a3f131074f6a3899857 |
| 2026-08-09 | be32d2215c0d1174e442327de79b743cc23df0907878a4f722568989ab44eb4b |
| 2026-08-10 | 1a9e644d9ec5471173e7d020b5fcef06d442b25a9accf6fe63ba8abb07bee8f9 |
| 2026-08-11 | 9ed792d412db7e4b68fba1396adadcf2de90989f4972669341c5a1c91f7cf4dc |

Canonical 14D partitions 2026-08-20..2026-09-02 (committed on origin/main): unchanged, zero git diff.

## Regenerated 30d rolling manifest — `ROLLING_MANIFEST_30d_2026-09-02.json`

`rolling-research-corpus.ts --window 30 --now 2026-09-03T14:52:28.420Z --read-proof` (report-only, no materialize):

- WINDOW_START=2026-08-04, WINDOW_END=2026-09-02, **WINDOW_COMPLETE=true**
- **AVAILABLE_PARTITION_N=30, MISSING_PARTITION_N=0, MISSING_DAYS=[]**
- PARTITION_HASH_REFERENCES_ONLY=true, PRODUCTION_PRIMARY_READS=0
- PIT_FUTURE_LEAK_N (WINDOW_UNIQUE_SELECTION) = 0
- read-proof: DB_READS=0, BROAD_SCANS=0, PARTITIONS_STREAMED=30, ROWS_STREAMED=30696, MATCHES_MANIFEST_PRE_COLLAPSE=true

### Complete-30d cross-partition identity (distinct units, never mixed)

| metric | value | unit |
|---|---|---|
| WINDOW_PRE_COLLAPSE_ROW_N | 30696 | Σ frozen compact rows over 30 partitions (SOURCE_STAGE WINDOW_PRE_COLLAPSE) |
| WINDOW_UNIQUE_SELECTION_N | 19929 | distinct (population_id, condition_id, selected_token_id) (WINDOW_UNIQUE_SELECTION) |
| WINDOW_UNIQUE_PHYSICAL_EVENT_SELECTION_N | 3182 | distinct (population_id, provider_event_id) among unique selections (WINDOW_UNIQUE_PHYSICAL_EVENT) |

Collapse rule: a selection identity in >1 partition collapses to its earliest-DECISION_AT frozen row; physical events never multiplied across dates.

### Per-population, complete 30d window (never pooled)

| population_id | INPUT_ROWS | UNIQUE_SELECTION_N | UNIQUE_PHYS_EVENT_SELECTION_N | SETTLED_N | OPEN_N | NO_MATCH_N | Score LEVEL cov / min / max | Score SERIES cov | Volume cov | price-path cov | lead-time cov | LABEL_COUNTS_FROZEN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SEP_PUBLIC_RICH_V1      | 4607  | 4510  | 2014 | 3145 | 1365 | 0 | 100% / 53 / 83 | 0% | 0%    | 88.0% | 100%  | WIN 1562 / LOSS 1583 / OPEN 1365 |
| SEP_SHADOW_STRATEGIC_V1 | 26089 | 15419 | 1168 | 8189 | 7230 | 0 | 0% / null / null | 0% | 38.1% | 4.0%  | 50.6% | WIN 4004 / LOSS 4185 / OPEN 7230 |

UNIT: INPUT_ROWS = frozen compact rows across constituent partitions pre cross-partition collapse (WINDOW_PRE_COLLAPSE).
UNIQUE_SELECTION_N = distinct (population_id, condition_id, selected_token_id) — one model bet (WINDOW_UNIQUE_SELECTION).
Coverage denominators are UNIQUE_SELECTION_N per population.

## Score LEVEL / SERIES

- Score LEVEL carried verbatim from `generated_signal_pairs.pre_event_score_num` with explicit `scoreLevelSource` tag.
  SEP_PUBLIC_RICH_V1: 100% coverage across all 8 Chunk-B days; window LEVEL range 53..83.
- SEP_SHADOW_STRATEGIC_V1: structural null — `scoreLevel=null` on 100% of rows, never synthesized.
- Score SERIES coverage = **0%** for both populations across the complete 30d window. This is an explicit
  DATA QUALITY dimension to carry forward: it does not block Score-LEVEL or non-SERIES predicates; any
  model that requires Score SERIES is simply ineligible until that evidence exists.
- LEVEL and SERIES stay distinct fields (`scoreLevel`/`scoreLevelSource` vs `score`).
  Confirmed by `tests/modeling/forward-rich/scoreLevel.test.ts`.

## Boundaries respected

- No production DB read/write/fallback; no broad scan. No schema/migration/settlement/PIT/identity/population redesign.
- No accepted/frozen partition overwritten; Chunk-A + 14D content preserved exactly.
- Populations never pooled; AUG_SHADOW_C4_V1 not present in these partitions and no calendar-derived leakage
  (`derivePopulationId` + `rollingCorpus` tests, 26/26 PASS).
- No PnL/ROI/MaxDD/scorecard/threshold/candidate evaluation. No new helper script; no full build; no adjacent inspection.
- No PR/merge/release performed.
