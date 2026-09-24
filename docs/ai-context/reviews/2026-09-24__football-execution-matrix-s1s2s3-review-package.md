# Independent Review Package — Football Execution Matrix S1/S2/S3

Status: **WIRED, SOURCE-PROVEN, DB-WRITE BLOCKED** — the materializer consumes real
prospective football evidence already in the research clone and computes correct S1/S2/S3
evidence rows (verified end to end against project `nppznoujvnyjargjkmnv`), but cannot yet
persist them: see §7 for the exact first broken edge and the bounded fix committed for it.
Scope: PREMVP research clone only. No production mutation, no live-money behavior change,
no Signal Score / model change.

## 1. Methodology / field contract

One frozen candidate identity (`condition_id`, `selected_token_id`, `provider_event_id`,
`formula_version`, `decision_time`) feeds three independent shadow execution strategies,
all evaluated against the SAME signal:

- **S1_TAKER_HOLD** — immediate taker fill against contemporaneous available decimal odds,
  gated by a minimum acceptable decimal odds. `TAKE` iff
  `availableDecimalOdds >= minAcceptableDecimalOdds`.
- **S2_FIXED_MAKER_HOLD** — a single fixed maker target (initial research value: **2.00**
  decimal odds). Records whether the target became reachable and the best observed
  acceptable price, with strict fill semantics (below).
- **S3_MAKER_VALUE_BAND_HOLD** — a maker ladder (initial research values: **2.00 / 1.95 /
  1.90**, minimum acceptable **1.85**). Records each level reached and the best reachable
  acceptable price.

Ladder/target values above are **research benchmarks, not proven-optimal thresholds**.

### Odds contract

Decimal odds are first-class and kept conceptually distinct at every layer (types, evidence
rows, DB columns): model/reference odds, available odds, maker target odds, minimum
acceptable odds, actual fill odds, and closing odds (only when genuinely available) are
never conflated. Internal CLOB share-price representations are converted at the boundary
(`sharePriceToDecimalOdds` / `decimalOddsToSharePrice`) and never leak into evidence fields.

### Fill-status semantics (S2/S3)

`ACTUAL_FILL | FILL_OPPORTUNITY | NO_FILL | UNKNOWN`. A market price merely reaching a
target/ladder level is **FILL_OPPORTUNITY**, never `ACTUAL_FILL`. `ACTUAL_FILL` requires
externally supplied authoritative execution evidence (`executor_order_events`,
`bet_execution_ledger`, or `manual_review`) — enforced both in code
(`lib/executionMatrix/footballS1S2S3.ts`) and in the DB via
`football_execution_matrix_s1s2s3_evidence_no_fill_without_source` (a row cannot be
`ACTUAL_FILL` without `fill_evidence_source`).

### Semantic guarantees

- S1/S2/S3 consume the same frozen signal; execution evaluation cannot alter signal/model
  selection (evidence functions are pure — they pass model/candidate fields through
  unchanged and derive nothing back into selection).
- `NO_FILL` and `UNKNOWN` are preserved outcomes, not collapsed into a boolean.
- No settlement/future information appears in decision-time evidence fields (no
  `settledOutcome` / `winningOutcome` / `resolvedAt` / `closingOdds`-as-decision-input).
- Shadow S2/S3 evidence does not require real-money order placement to populate.
- Historical S2/S3 fills are never fabricated — `ACTUAL_FILL` requires evidence.

## 2. Schema / evidence location

- Table: `research.football_execution_matrix_s1s2s3_evidence`
- Migration: `supabase/migrations/20260924120000_football_execution_matrix_s1s2s3_research_evidence.sql`
- Research-clone only (`PREMVP-DB-CLONE`); not applied to production.

## 3. Implementation

- `lib/executionMatrix/footballS1S2S3.ts` — pure evaluation functions:
  `evaluateS1TakerHold`, `evaluateS2FixedMakerHold`, `evaluateS3MakerValueBandHold`,
  `sharePriceToDecimalOdds`, `decimalOddsToSharePrice`, `assertSameCandidateIdentity`.
- Implementation SHA: see `git log -1 --format=%H -- lib/executionMatrix/footballS1S2S3.ts`
  on this branch (recorded at PR time in the PR description).

## 4. Focused test evidence

`tests/research-clone/footballExecutionMatrixS1S2S3.test.ts` — 9 tests, proving:

1. Same candidate identity shared across S1/S2/S3 (and drift is detected).
2. Decimal-odds conversion (share price ↔ decimal odds), including boundary rejection.
3. Minimum-odds semantics for S1 TAKE/NO_TAKE and the S3 minimum-acceptable floor.
4. Maker touch != ACTUAL_FILL for both S2 and S3.
5. NO_FILL vs UNKNOWN preservation (no observations vs. observed-but-unreachable).
6. Execution observations cannot modify model/candidate selection (pass-through proof).
7. No future/settlement leakage into decision-time evidence fields.

Run: `node --import tsx --test tests/research-clone/footballExecutionMatrixS1S2S3.test.ts`
Result at commit time: **9/9 PASS**.

`tests/research-clone/materializeFootballS1S2S3.test.ts` (added in the wiring mission) — 10
tests on the pure mapping/assembly layer (`scripts/execution-matrix/materializeFootballS1S2S3.ts`):
real-source field mapping, identity preservation across S1/S2/S3, temporal ordering/causality
(snapshots at/before decision time excluded), Exact Score exclusion, no fabricated
ACTUAL_FILL without an authoritative row, and deterministic `recorded_window_start` for
idempotent reruns. Result: **10/10 PASS**. Combined: **19/19 PASS**.

Typecheck: `npx tsc --noEmit -p tsconfig.json` — no errors attributable to the touched
files (`lib/executionMatrix/footballS1S2S3.ts`,
`tests/research-clone/footballExecutionMatrixS1S2S3.test.ts`); one pre-existing, unrelated
failure exists on this branch (`tests/modeling/football-denominator-reconciliation.test.ts`
missing the `vitest` package), unchanged by this work.

## 5. Reproduction / query instructions

```bash
# Run the focused test suite
node --import tsx --test tests/research-clone/footballExecutionMatrixS1S2S3.test.ts

# Apply the clone-only DDL to PREMVP-DB-CLONE (never production)
psql "$PREMVP_DB_CLONE_URL" -f supabase/migrations/20260924120000_football_execution_matrix_s1s2s3_research_evidence.sql

# Query captured evidence for one candidate identity across all three strategies
select strategy, status, target_decimal_odds, ladder_decimal_odds,
       best_observed_acceptable_decimal_odds, actual_fill_decimal_odds, recorded_at
from research.football_execution_matrix_s1s2s3_evidence
where condition_id = :'condition_id'
  and selected_token_id = :'selected_token_id'
order by strategy, recorded_at;
```

## 6a. Source → business path (real wiring, mission 2)

```
public.generated_signal_pairs                      (candidate identity + decision-time
  condition_id, selected_token_id,                   contemporaneous odds: entry_price_num
  metric_formula_version, created_at,                 is the SAME row's price, not a later
  entry_price_num                                     re-fetch)
        |
        v  (temporal filter: captured_at > decision_time)
public.market_price_liquidity_snapshots             (post-decision orderbook trajectory:
  condition_id, token_id, captured_at,                 implied_decimal_odds_mid feeds S2/S3
  implied_decimal_odds_mid                             observations, already decimal odds)
        |
        v  (join on condition_id + token_id; requires bet_status/order_status match /fill/i)
public.bet_execution_ledger /                        (authoritative fill evidence — only
public.executor_order_events                          source ACTUAL_FILL may come from)
        |
        v
lib/executionMatrix/footballS1S2S3.ts                (evaluateS1TakerHold /
  evaluateS2FixedMakerHold / evaluateS3...)             evaluateS2FixedMakerHold /
        |                                               evaluateS3MakerValueBandHold)
        v
public.record_football_execution_matrix_s1s2s3_evidence(jsonb)   <- bridge RPC (§7)
        |
        v
research.football_execution_matrix_s1s2s3_evidence   (durable evidence, upserted on the
                                                         logical-observation identity)
```

Implementation: `scripts/execution-matrix/materializeFootballS1S2S3.ts`.
Run: `npx tsx scripts/execution-matrix/materializeFootballS1S2S3.ts [--dry-run]`.

## 6b. Real first-run proof (dry-run, `--dry-run`, against `nppznoujvnyjargjkmnv`)

The only football/soccer candidate/orderbook pair currently replicated into this clone
(`market_price_liquidity_snapshots.normalized_sport = 'soccer'`, an MLS Over/Under 2.5
market — `mls-lag-laf-2026-07-17-total-2pt5`, `condition_id`
`0x8a73cde5bd77cadc87069bd510a49195df3da700dd1791a4f0cc47b073d98c16`) produced:

```json
{
  "candidateIdentities": 4,
  "rowsByStrategy": { "S1_TAKER_HOLD": 4, "S2_FIXED_MAKER_HOLD": 4, "S3_MAKER_VALUE_BAND_HOLD": 4 },
  "s1TakeCounts": { "TAKE": 4, "NO_TAKE": 0 },
  "s2StatusCounts": { "ACTUAL_FILL": 0, "FILL_OPPORTUNITY": 4, "NO_FILL": 0, "UNKNOWN": 0 },
  "s3StatusCounts": { "ACTUAL_FILL": 0, "FILL_OPPORTUNITY": 4, "NO_FILL": 0, "UNKNOWN": 0 },
  "authoritativeActualFills": 0,
  "exactScoreContamination": 0,
  "decisionTimes": [
    "2026-07-16T09:34:41.255239+00:00", "2026-07-16T11:33:42.216554+00:00",
    "2026-07-16T12:03:50.198451+00:00", "2026-07-16T13:04:58.007037+00:00"
  ]
}
```

Field lineage for this real slice: 4 distinct `generated_signal_pairs.created_at` rows for
the same `(condition_id, selected_token_id)` → 4 candidate identities, each with its own
decision time. `entry_price_num = 0.385` on all 4 → `availableDecimalOdds ≈ 2.597` ≥ the
1.85 research minimum → `S1 = TAKE` on all 4. Three `market_price_liquidity_snapshots` rows
(2026-07-17 03:21 / 03:31 / 03:41 UTC), all strictly after every decision time (2026-07-16
09:34–13:04 UTC) → temporally causal S2/S3 observations, `implied_decimal_odds_mid ≈ 2.597`
on all three, above the 2.00 S2 target and the 1.95/1.90 S3 rungs → `FILL_OPPORTUNITY` on
both, never `ACTUAL_FILL` (no matching row in `bet_execution_ledger` or
`executor_order_events` for this condition/token — none exists, so none is fabricated).

## 7. Exact first broken edge fixed in this mission

**Edge:** `candidate/orderbook evidence → execution-matrix evaluation` computes correctly
(§6b proves it against real rows), but `evaluation → durable research evidence write` fails.
The research-clone project (`nppznoujvnyjargjkmnv`) exposes only the `public` and
`graphql_public` schemas over PostgREST — confirmed by
`GET /rest/v1/?apikey=...` (swagger lists only `public.*` paths) and by an explicit
`Accept-Profile: research` probe, which returns
`PGRST106 "Invalid schema: research"`. The materializer's only clone credential in this
session is a REST/service-role key (`SUPABASE_CLONE_URL` / `SUPABASE_CLONE_SERVICE_ROLE_KEY`)
— there is no direct Postgres/psql connection and no Supabase-management DDL access in this
session (the same constraint that required Architect, not this session, to apply the PR #398
DDL by hand). So `research.football_execution_matrix_s1s2s3_evidence` exists but is
unreachable from the only write path this session holds.

**Bounded fix committed:** `supabase/migrations/20260924133000_football_execution_matrix_s1s2s3_public_bridge.sql`
adds (a) a `public`-schema `SECURITY DEFINER` RPC,
`record_football_execution_matrix_s1s2s3_evidence(payload jsonb)`, that performs the
`research`-schema insert on the caller's behalf (auto-exposed by PostgREST as every other
function in this repo's migrations already is), and (b) the smallest schema correction the
PR #398 table was missing for idempotency: a `recorded_window_start` column plus a
`unique (condition_id, selected_token_id, formula_version, decision_time, strategy,
recorded_window_start)` constraint, so rerunning the materializer against the same source
slice upserts instead of duplicating.

**Proof the edge is real, not assumed:** running the materializer for real (no `--dry-run`)
against `nppznoujvnyjargjkmnv` fails with:
```
Could not find the function public.record_football_execution_matrix_s1s2s3_evidence(payload)
in the schema cache
```
— i.e. the bridge migration above has not yet been applied to the clone. Zero rows have
been written to `research.football_execution_matrix_s1s2s3_evidence` in this mission; the
table remains at the 0/0/0/0 state Architect reported at mission start. Once Architect
applies `20260924133000_football_execution_matrix_s1s2s3_public_bridge.sql` to the clone,
rerunning `npx tsx scripts/execution-matrix/materializeFootballS1S2S3.ts` (no flag) will
persist the 4 candidate identities / 12 rows shown in §6b as real, non-fabricated DB rows,
and is safe to rerun repeatedly (idempotent upsert on the logical-observation identity).

## 8. Known limitations

- `provider_event_id` uses `event_slug` (falling back to `condition_id` when absent) — no
  independent numeric provider-event-id field is populated on
  `generated_signal_pairs`/`current_signal_pair_serving` for this slice. This is a real
  identity value from the source, not a fabricated one, but it is not the same namespace a
  numeric provider event id would be.
- `modelFairDecimalOdds` is `null` for every row in this slice: the source carries only the
  entry/available price at decision time, no independently recorded reference/fair odds. Per
  the odds contract, this is left `NULL` rather than reusing `availableDecimalOdds`.
- The clone currently replicates exactly one football/soccer candidate/orderbook pair
  (`normalized_sport = 'soccer'` has 3 rows total in `market_price_liquidity_snapshots`, one
  `condition_id`/`token_id`). The wiring and its 12 computed rows are real, but the sample is
  small because upstream football orderbook replication into this clone is thin right now —
  that upstream coverage gap is outside this mission's scope (no market-data-platform work).
- `bet_execution_ledger`/`executor_order_events` fill matching uses a regex on
  `bet_status`/`order_status` (`/fill/i`) rather than a fixed enum, because the exact
  status vocabulary wasn't independently confirmed in this mission; no fill existed for the
  real slice tested, so this path is unexercised against real data.

## 6. Reference economics vs. execution authority

Architect screening context (Aug 04–Sep 24 canonical model-ready corpus, 75,743 rows;
football cohort, decimal odds 1.85–2.00: selected = 1,334, terminal = 909,
reference PnL = +182.39u, reference ROI = +20.06%) is **REFERENCE_PNL / NOT_EXECUTION_
AUTHORITY** until independently reproduced from real prospective S1/S2/S3 evidence rows
captured through this schema. Nothing in this package treats that reference cohort as
proof of live executable edge — `ACTUAL_FILL` rows from authoritative execution evidence
are the only rows this schema treats as execution authority.
