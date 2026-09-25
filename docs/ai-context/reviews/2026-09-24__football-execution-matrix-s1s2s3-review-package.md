# Independent Review Package — Football Execution Matrix S1/S2/S3

Status: **PERSISTED — real S1/S2/S3 evidence rows exist in the research clone**
(project `nppznoujvnyjargjkmnv`), written by the already-published materializer after
Architect applied both required migrations. A same-slice rerun proved DB-level idempotency
(identical row ids returned on both runs, zero duplicates). See §9 for the persisted-DB
proof.
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

## 9. Persisted DB proof (real writes, mission 3)

Architect applied both `20260924120000_football_execution_matrix_s1s2s3_research_evidence.sql`
and `20260924133000_football_execution_matrix_s1s2s3_public_bridge.sql` to
`nppznoujvnyjargjkmnv`. The materializer (`scripts/execution-matrix/materializeFootballS1S2S3.ts`,
run without `--dry-run`) then wrote real rows successfully — the same first-real-write call
that previously failed with `PGRST106`/"function not found" now succeeds.

**Read-path limitation, and how idempotency was proven anyway:** `research.*` is still not
exposed via PostgREST on this clone (see §7) — this session has no `SELECT` path into
`research.football_execution_matrix_s1s2s3_evidence`, only the `INSERT ... ON CONFLICT ...
RETURNING id` write RPC. So aggregate DB proof here is derived from that RPC's own
authoritative return values across two consecutive real runs, not from a separate read
query — the write RPC only returns an id on successful commit, and
`ON CONFLICT (condition_id, selected_token_id, formula_version, decision_time, strategy,
recorded_window_start) DO UPDATE ... RETURNING id` returns the *existing* row's id on a
duplicate call, never a new one. Two consecutive real runs against the same source slice
returned:

- Run 1: 12 row ids (4×S1, 4×S2, 4×S3), all distinct.
- Run 2 (immediately after, same source slice, no source data changed): the **exact same 12
  ids**, same strategy assignment, zero new ids. `set(run1_ids) == set(run2_ids)`,
  `len(run1_ids) == len(run2_ids) == 12 == len(unique ids)`.

This is conclusive: the second run upserted the same 12 logical rows rather than creating
new ones — DB-level idempotent rerun, proven, without fabricating a count.

**Aggregate-first evidence** (derived from the RPC-confirmed writes; the clone was at
0/0/0/0 before this mission per Architect's report, and this materializer is the only writer
of this table so far):

| Metric | Value |
|---|---|
| Total candidate identities | 4 |
| Row count after first run | 12 |
| Row count after second run | 12 (unchanged — same 12 rows) |
| S1 rows | 4 |
| S1 TAKE / NO_TAKE | 4 / 0 |
| S2 rows | 4 |
| S2 ACTUAL_FILL / FILL_OPPORTUNITY / NO_FILL / UNKNOWN | 0 / 4 / 0 / 0 |
| S3 rows | 4 |
| S3 ACTUAL_FILL / FILL_OPPORTUNITY / NO_FILL / UNKNOWN | 0 / 4 / 0 / 0 |
| Authoritative ACTUAL_FILL count | 0 (no matching `bet_execution_ledger`/`executor_order_events` row for this candidate/token; none fabricated) |
| min / max `decision_time` | `2026-07-16T09:34:41.255239+00:00` / `2026-07-16T13:04:58.007037+00:00` |
| min / max `recorded_at` (client-observed at RPC call time; DB `now()` is a few ms earlier) | `2026-09-24T20:13:30.459Z` / `2026-09-24T20:14:49.130Z` |
| Identity mismatches | 0 (`assertSameCandidateIdentity` did not throw on any candidate) |
| Exact Score contamination | 0 |
| Duplicate logical observations after rerun | 0 |

**Reproduction:**
```bash
npx tsx scripts/execution-matrix/materializeFootballS1S2S3.ts          # writes, idempotent
npx tsx scripts/execution-matrix/materializeFootballS1S2S3.ts --dry-run  # compute-only, no writes
```

**Known limitation carried forward:** without a `research`-schema read path on this clone,
an independent reviewer cannot yet run an ad hoc `SELECT` to re-verify row counts directly —
they can only re-run the materializer (safe, idempotent) and observe the same returned ids,
or Architect can grant a read-only RPC/schema exposure as a follow-up. This does not weaken
the idempotency proof above, which relies only on the write RPC's own conflict semantics.

## 10. Review B-lite repair and post-repair clone proof (2026-09-25)

This section supersedes the pre-review fill attribution, four-field conflict key,
read-path and "current" 12-row claims above. Those paragraphs document the reviewed
`4334fcb` implementation, not the repaired authority.

B-lite verdict was `FAIL_EXECUTION_AUTHORITY` on four findings:

1. **Ordinary full-match eligibility:** discovery previously accepted every
   `normalized_sport='soccer'` snapshot. It now requires the existing snapshot's
   structured `normalized_market_family` in `moneyline/spread/total` and
   `market_family_gate_status='passed'`. PREMVP's canonical Contur3 market/scope
   classifiers examine *every* event/market title and slug as veto evidence.
   Unknown structured family or gate fails closed. Source lineage is
   `public.market_price_liquidity_snapshots` (itself normalized by the liquidity
   watchlist builder from fine market type), joined exactly by condition/token
   to `public.generated_signal_pairs`.
2. **Exact Score:** structured market-family gate is primary. Every available
   title/slug is separately checked for forbidden classes; a generic event title
   cannot mask an Exact Score market title. Candidate label checks can only
   reject; they never admit a row without the structured snapshot gate.
3. **Fill authority:** the materializer no longer reads `submitted_price` or
   accepts broad `/fill/i` statuses. It links the exact
   `generated_signal_pairs.id` to
   `executor_order_events.executor_meta.reconciliation_v1.source_signal_pair_id`,
   requires `MATCHED_CONFIRMED`, one linked `clob_order_id`, then exactly one
   `bet_execution_ledger.exchange_order_id` with the same condition/token,
   explicit filled/matched status, `fill_price` and `filled_at` strictly after
   that candidate's decision. The ledger `fill_price` supplies decimal odds.
   No order or ledger evidence exists for the four clone decisions, so none is
   attributed. A price touch remains `FILL_OPPORTUNITY`.
4. **DB identity:** additive clone migration
   `20260925051832_football_execution_matrix_authority_repair.sql` replaces the
   four-field unique/conflict key with `(condition_id, selected_token_id,
   provider_event_id, formula_version, decision_time, strategy,
   recorded_window_start)`. Its transaction first verified exactly 12 old rows
   by materializer source tags and absent version marker, deleted only those
   rows, then installed the new key and bridge conflict target. Every repaired
   row has diagnostics `materializer_version=FOOTBALL_EXECUTION_MATRIX_S1S2S3_MATERIALIZER_V2`.

The clone `nppznoujvnyjargjkmnv` was queried independently. Before migration it
held exactly 12 unversioned materializer rows and no other rows in this table.
The migration was applied to that clone, then the materializer ran twice without
`--dry-run`. Both runs returned the identical set of 12 IDs. An independent
read-only SQL aggregate after the second run found:

| Measure | Post-repair value |
|---|---:|
| Candidate identities | 4 |
| Rows after first / second run | 12 / 12 |
| S1 rows; TAKE / NO_TAKE | 4; 4 / 0 |
| S2 rows; ACTUAL_FILL / FILL_OPPORTUNITY / NO_FILL / UNKNOWN | 4; 0 / 4 / 0 / 0 |
| S3 rows; ACTUAL_FILL / FILL_OPPORTUNITY / NO_FILL / UNKNOWN | 4; 0 / 4 / 0 / 0 |
| Authoritative actual fills | 0 |
| Full-match eligibility rejected snapshot rows | 0 |
| Exact Score contamination | 0 |
| Pre-decision fill rejections | 0 |
| Ambiguous/unattributed fill rejections | 0 |
| Duplicate logical observations | 0 |
| Old/unversioned rows | 0 |
| min/max decision_time | 2026-07-16 09:34:41.255239+00 / 2026-07-16 13:04:58.007037+00 |
| min/max recorded_at after second run | 2026-09-25 05:27:57.982057+00 / 2026-09-25 05:27:58.784920+00 |

The repaired clone source has one soccer condition/token represented by three
snapshots, all structurally `total`/`passed`; it yields four decision times. There
are no matching order events or ledger rows. Thus real historical fill attribution
has not been exercised by this clone sample; synthetic tests cover the exact
causal linkage. No historical maker fill is inferred.

Reproduction:

```bash
node --import tsx --test tests/research-clone/footballExecutionMatrixS1S2S3.test.ts tests/research-clone/materializeFootballS1S2S3.test.ts
npm run build
npx tsx scripts/execution-matrix/materializeFootballS1S2S3.ts
npx tsx scripts/execution-matrix/materializeFootballS1S2S3.ts
```

Independent read query for the reviewer (run only on the research clone):

```sql
select strategy, coalesce(status,take_decision) outcome, count(*) rows,
       min(decision_time) min_decision_time, max(decision_time) max_decision_time,
       min(recorded_at) min_recorded_at, max(recorded_at) max_recorded_at
from research.football_execution_matrix_s1s2s3_evidence
where diagnostics->>'materializer_version' =
  'FOOTBALL_EXECUTION_MATRIX_S1S2S3_MATERIALIZER_V2'
group by strategy, coalesce(status,take_decision)
order by strategy, outcome;
```

Focused tests: 22/22 pass. `npm run build` passes. Standalone `tsc --noEmit`
is blocked by an existing missing `vitest` import in
`tests/modeling/football-denominator-reconciliation.test.ts`; build's own
TypeScript phase passes. `npm run control-plane:check` fails on pre-existing
UTF-8 BOM in four control-plane files. Neither failure is in this repair's
write boundary.

## 11. B2 capped-query authority repair for final Independent Review B3 (2026-09-25)

Independent Review B2 at `a0918ac24595d052a2fa15b425a2413c91f899cf` found one
remaining HIGH defect: the order and ledger reads each used `.limit(200)`.
`attributeExecutedFill` then treated exactly one matching row in those returned
arrays as global uniqueness. A further matching row beyond either cap could
therefore be hidden while `ACTUAL_FILL` was accepted. B2 also identified the
missing explicit `submitted_price`-only negative regression.

The materializer now queries `executor_order_events` for the exact candidate's
`generated_signal_pairs.id` in
`executor_meta.reconciliation_v1.source_signal_pair_id`, with the exact
condition/token and `MATCHED_CONFIRMED` state. It requests `count: "exact"`
with the projected rows in the same query. No fixed row cap is used for fill
authority. Before the ledger query, the returned order count must be a
non-negative safe integer, equal the returned array length, and exactly one.
The one order must still pass every source-pair, condition, token, status and
non-null `clob_order_id` check.

The ledger query is then narrowed to that exact `clob_order_id` as
`exchange_order_id`, plus the same condition/token. It also requests an exact
count without a fixed cap. `ACTUAL_FILL` requires a complete result with
exactly one ledger row; an accepted executed/matched status; finite ledger
`fill_price` in `(0,1)`; and `filled_at` strictly after this decision's
`created_at`. Decimal fill odds are `1 / fill_price`. The executor's
`submitted_price` is neither selected nor substituted for ledger `fill_price`.

This closes the capped-result proof gap: if the API returns only 200 of 201
matching rows, the exact count differs from the returned length and the fill
fails closed. A count above one also fails closed, even when every row was
returned. Null, missing, malformed and otherwise incomplete result sets fail
closed. [Supabase's JavaScript select reference](https://supabase.com/docs/reference/javascript/select)
documents the exact-count option; its
[JSONB contains filter](https://supabase.com/docs/reference/javascript/using-filters-contains)
is used to narrow the order query to the candidate reconciliation record.
The clone schema confirms `executor_meta` is JSONB. Current clone data has
no matching order events or ledger fills, so real `ACTUAL_FILL` attribution
remains `UNTESTED_WITH_REAL_FILL`; the static path and synthetic positive case
are covered.

Focused tests went red against the old array-only signature, then passed
`26/26` after the repair. They cover returned count above 200 with a shorter
row array for both stages, complete count above one, unknown/incomplete
counts, a complete one-order/one-ledger-fill positive case, exact query
filters/count options with a mocked client, and a `MATCHED_CONFIRMED` order
with `submitted_price` but no ledger `fill_price`. The latter produces
neither `ACTUAL_FILL` nor `actual_fill_decimal_odds`. Focused TypeScript check
on the touched materializer and test passes. `npm run build` passes. The
repository-wide `tsc --noEmit` still reports only the pre-existing missing
`vitest` import in `tests/modeling/football-denominator-reconciliation.test.ts`.
`npm run control-plane:check` still stops on the four pre-existing BOM files
identified above.

No materializer write run was needed: this repair changes only fill lookup,
and the clone has no order evidence for the four source decisions. A read-only
aggregate after the repair found four source candidate identities, 12 total
V2 rows, S1 `4 TAKE`, S2 `4 FILL_OPPORTUNITY`, S3
`4 FILL_OPPORTUNITY`, zero `ACTUAL_FILL`, zero duplicate logical
observations and zero old/unversioned rows. The V2 `recorded_at` bounds remain
`2026-09-25 05:27:57.982057+00` to `2026-09-25 05:27:58.784920+00`, identical
to §10. Persisted V2 evidence has not changed. The unique key and RPC
conflict target are untouched; §10's two-run idempotency proof still applies
to the same source slice. No production or live-money behavior changed.
