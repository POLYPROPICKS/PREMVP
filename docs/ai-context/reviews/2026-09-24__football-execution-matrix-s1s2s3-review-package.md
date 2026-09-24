# Independent Review Package — Football Execution Matrix S1/S2/S3

Status: RESEARCH_EVIDENCE_CAPTURE_READY — not yet backed by real prospective observations.
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

## 6. Reference economics vs. execution authority

Architect screening context (Aug 04–Sep 24 canonical model-ready corpus, 75,743 rows;
football cohort, decimal odds 1.85–2.00: selected = 1,334, terminal = 909,
reference PnL = +182.39u, reference ROI = +20.06%) is **REFERENCE_PNL / NOT_EXECUTION_
AUTHORITY** until independently reproduced from real prospective S1/S2/S3 evidence rows
captured through this schema. Nothing in this package treats that reference cohort as
proof of live executable edge — `ACTUAL_FILL` rows from authoritative execution evidence
are the only rows this schema treats as execution authority.
