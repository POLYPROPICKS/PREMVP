# ROLLING_RESEARCH_CORPUS_14D_COMPLETE_V1 — findings

Mission: complete + prove the REAL immutable rolling research corpus for the 14
closed Europe/Minsk days ending 2026-09-02.

## START_GATE (all satisfied before any new artifact was written)

| Gate | Result |
|---|---|
| Live `origin/main` contains PR #236 Score-LEVEL semantics | `git rev-parse origin/main` = `aae2b8786137aee78ef4206c89036befe9888bee`; top commit is the PR #236 merge (`b0fe3de` `RESEARCH_CORPUS_SCORE_LEVEL_CORRECTION_V1`). Worktree HEAD == that SHA. |
| Existing accepted partitions 2026-08-27..2026-09-02 + hashes resolved | Captured from worktree HEAD (== origin/main) before any write — see table below. |
| Exact clone vs production identity resolved; selected DB = canonical research clone | `railway run --service research-clone-daily-sync` env probe: `SUPABASE_CLONE_URL` project ref = `nppznoujvnyjargjkmnv` (== `EXPECTED_CLONE_REF`); production ref = `nbnldzfsxffztsfrrxqy`; `clone_equals_prod = false`. The materializer `resolveCloneClient()` fails closed on any mismatch. |

### Accepted partition baseline (git blob SHA, worktree HEAD == origin/main)

```
2026-08-27  CORPUS 4709eaa865a85996a9d322b8476dd85639d13e49  MANIFEST 8883317e23a8afffdcb1085fc6e4a5832403798d
2026-08-28  CORPUS fcf3b3e04e4cab01f175588d1619292f425d4d99  MANIFEST b0b01ba293e8435f16f4bc2ad74479e60b894490
2026-08-29  CORPUS 654a08d68764f70e32dbec3d2d0fd300f0662059  MANIFEST 5cdbdd3bcbe9e6f3473df7f6450f5d0cc18042f9
2026-08-30  CORPUS edf26e670e7bc1d42010b62bc9fcb8d05289a23a  MANIFEST 38fb6413b6c6baab36ef093e4d1702dfff955b11
2026-08-31  CORPUS 854b229845e8f4abc4b0e5dc56a4239a77a61086  MANIFEST 23d23ee5d0a07d80a1d97c0c81a46d679dd3c4ae
2026-09-01  CORPUS df0584f9c490045ea02cf406e60dd68ffdb0cc96  MANIFEST e8112947cc90546937b3059e563452dcfcfe128b
2026-09-02  CORPUS 1d55e6033fe4e7ae83a7be194dbd7b166ed18806  MANIFEST 40533e0f4aa8ffa0b1f3194ea114194c8e03bdcc
```

After the full run: `git diff --stat -- modeling/evidence/research-corpus-factory-live-v1/` = **(none)**;
`git status --porcelain` for that dir shows only the 7 NEW untracked dates. Accepted content + hashes **unchanged**. TERMINAL #2 satisfied.

## What was produced

`railway run --service research-clone-daily-sync -- node --import tsx scripts/modeling/rolling-research-corpus.ts --window 14 --now 2026-09-03T12:00:00.000Z --materialize-missing --read-proof`

drove the ALREADY-CANONICAL clone-only path (`scripts/modeling/live-d1-research-corpus.ts` →
`scripts/modeling/freeze-d1-research-corpus.ts`) once per missing closed Minsk D-1 date, then rebuilt the 14d rolling manifest.

### 7 NEW immutable D-1 partitions (TERMINAL #1)

`modeling/evidence/research-corpus-factory-live-v1/{CORPUS,MANIFEST,SHA256SUMS}_<date>.{jsonl.gz,json,txt}`

| Date | rows | CANONICAL_CONTENT_SHA256 | PIT_FUTURE_LEAK_N | SOURCE_KIND / project | prod R/W |
|---|---|---|---|---|---|
| 2026-08-20 | 1004 | d719d6da8f84d60a40d259c36560b1c2b28e23d2ed0fe9b12f0621c7a869d47d | 0 | RESEARCH_CLONE / nppznoujvnyjargjkmnv | 0 / 0 |
| 2026-08-21 | 1133 | 7d41c3ea901e796dd72aa23a3cf6e2acd6142d52b3c33f99b4bf7131fe1974f6 | 0 | RESEARCH_CLONE / nppznoujvnyjargjkmnv | 0 / 0 |
| 2026-08-22 | 1096 | f2266b0b113830e0dc7c5f40d9a994be93da6dfea2163c7f1828c3c33c24f4af | 0 | RESEARCH_CLONE / nppznoujvnyjargjkmnv | 0 / 0 |
| 2026-08-23 | 1079 | 344592832483764ace6cf047582d31c5470168a4b0828c309024f4dc1af4d0d5 | 0 | RESEARCH_CLONE / nppznoujvnyjargjkmnv | 0 / 0 |
| 2026-08-24 | 908  | 03361b87c8fea02e05d9be50e2003a3ab4a406461ec5157d7cf1c42ff73ad630 | 0 | RESEARCH_CLONE / nppznoujvnyjargjkmnv | 0 / 0 |
| 2026-08-25 | 1025 | e3e028a4ad649a52855a30a8f9beb9372485272d3594ffa8e6f6e829da4a153c | 0 | RESEARCH_CLONE / nppznoujvnyjargjkmnv | 0 / 0 |
| 2026-08-26 | 1056 | ca14195233000fe1c8ed86fba04c4fab0dbf790c711bfe6951faa1063ca54896 | 0 | RESEARCH_CLONE / nppznoujvnyjargjkmnv | 0 / 0 |

Each partition: `MANIFEST.CANONICAL_CONTENT_SHA256` == recomputed sha256(canonical JSONL);
`SHA256SUMS` CANONICAL_CONTENT / CORPUS.gz / MANIFEST.json lines all match on-disk bytes;
`OUTPUT_COMPACT_ROW_N` == on-disk row count; `PIT_FUTURE_LEAK_N` == 0.
`RELEASE_STATUS = ACCEPTED_IMMUTABLE`. TERMINAL #4, #5 satisfied.

### Completed rolling window (TERMINAL #3)

`modeling/evidence/rolling-research-corpus-v1/ROLLING_MANIFEST_14d_2026-09-02.json`
(self sha256 `0be8cf1b83fe9bf9dfad751bac8c8736796030a14fe0fa6666040c2d0ea81051`,
recorded in the sibling `.SHA256SUMS.txt` alongside all 14 partition CANONICAL_CONTENT hashes;
`PARTITION_HASH_REFERENCES_ONLY = true` — no payload duplication):

```
WINDOW_START      = 2026-08-20
WINDOW_END        = 2026-09-02
PARTITION_N       = 14   (AVAILABLE_PARTITION_N)
MISSING_PARTITION_N = 0
WINDOW_COMPLETE   = true
PIT_FUTURE_LEAK_N = 0
```

Diff vs origin/main 14d manifest is exactly: `WINDOW_COMPLETE false→true`,
`MISSING_DAYS [7]→[]`, 7 partition entries appended, `GENERATED_AT` bump. No 7d / 30d file touched.

## Population identities kept separate (TERMINAL #6)

`POPULATION_POOLING = FORBIDDEN`. Every count below is per `population_id`; incompatible
populations are never summed into one funnel. `AUG_SHADOW_C4_V1` never appears — no
calendar-month classification of forward rows.

### Per-population window funnel (14d, from the rolling manifest)

| Field | SEP_PUBLIC_RICH_V1 | SEP_SHADOW_STRATEGIC_V1 |
|---|---|---|
| INPUT_ROWS (pre cross-partition collapse) | 1812 | 12769 |
| UNIQUE_SELECTION_N (post-collapse) | 1769 | 6451 |
| UNIQUE_PHYSICAL_EVENT_SELECTION_N | 1608 | 395 |
| SETTLED_N (frozen labels) | 1468 | 3202 |
| OPEN_N | 301 | 3249 |
| NO_MATCH_N | 0 | 0 |
| Score LEVEL present N / denominator | 1769 / 1769 | 0 / 6451 |
| Score LEVEL coverage | 100 % | 0 % (structural null — preserved) |
| Score LEVEL min–max | 53 – 81 | n/a |
| Score SERIES observation coverage | 0 / 1769 (0 %) | 0 / 6451 (0 %) |
| Volume coverage | 0 / 1769 (0 %) | 3744 / 6451 (58.0 %) |
| Price-path coverage | 1456 / 1769 (82.3 %) | 283 / 6451 (4.4 %) |
| Lead-time coverage | 1769 / 1769 (100 %) | 1785 / 6451 (27.7 %) |

Window pre-collapse total = 14581 frozen rows; unique-selection = 8220; unique physical-event
selection = 2003 (`CROSS_PARTITION_IDENTITY`). Collapse rule: a selection identity present in
>1 partition collapses to its earliest-`DECISION_AT` frozen row; physical events never
multiplied across dates. Pre-collapse and post-collapse denominators reported separately.
TERMINAL #7, #9 satisfied.

## Score LEVEL — decision-time verbatim carry (TERMINAL #8)

New partitions carry `scoreLevel` on the row itself (the D-1 reader now selects
`generated_signal_pairs.pre_event_score_num`; the additive overlay is only a retrofit for the
pre-correction accepted partitions and is not needed here).

For every new partition: every row with `scoreLevel` a number has
`scoreLevelSource = "generated_signal_pairs.pre_event_score_num"` (0 exceptions);
every row where the producer wrote null keeps `scoreLevel = null` with
`scoreLevelSource = null` (0 rows with a null level but non-null source).
`SEP_SHADOW_STRATEGIC_V1` is 0 % LEVEL on all 7 days — structural absence, never synthesized.
No LEVEL inferred from the GSRS Score SERIES; SERIES coverage is independently 0 and reported
separately.

## Local rolling consumption — DB-free (TERMINAL #10)

`--read-proof` (pure local consumption of the completed 14d window):

```
READ_SOURCE               = local immutable partition artifacts only
DB_READS                  = 0
BROAD_SCANS               = 0
PARTITIONS_STREAMED       = 14
ROWS_STREAMED             = 14581
MATCHES_MANIFEST_PRE_COLLAPSE = true
```

## Verification (cheapest sufficient — TERMINAL #11)

- Focused modeling tests: `node --import tsx --test tests/modeling/forward-rich/compactCorpus.test.ts tests/modeling/forward-rich/rollingCorpus.test.ts` → **13 pass / 0 fail** (includes "the committed immutable D-1 partition (2026-09-02) loads and hash-verifies").
- Direct materializer + rolling proof: run stdout above.
- Hashes / manifests: per-partition + rolling-manifest self-hash + SHA256SUMS all recomputed and matched.
- Diff integrity: `git diff --stat` = 2 files (the 14d rolling manifest + its SHA256SUMS), plus 7×2 untracked new-date files (CORPUS.gz + SHA256SUMS.txt; the 7 MANIFEST.json are covered by the repo's blanket `*.json` ignore and require `git add -f` at canonicalization, same as the accepted partitions).
- No model PnL / ROI / MaxDD / threshold / candidate-ranking computed anywhere (TERMINAL #12).

## Note (pre-existing, out of scope)

The accepted partitions' `SHA256SUMS_<date>.txt` MANIFEST-hash line does not match their current
`MANIFEST_<date>.json` bytes on origin/main (a pre-existing state from the PR #236 overlay
correction). The canonical rolling loader does not depend on that line (it verifies
`CANONICAL_CONTENT_SHA256`, which matches for all 14). Accepted payloads are read-only authority
here and were not touched.
