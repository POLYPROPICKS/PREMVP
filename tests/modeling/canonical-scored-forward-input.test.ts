import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVED_SCORED_FORMULA_VERSIONS,
  CANONICAL_SCORED_SELECT_COLUMNS,
  adaptCanonicalScoredRows,
  isOutcomeFieldName,
  runCanonicalScoredForwardV3,
  type BinaryIdentityProof,
  type ServerAsOf,
} from "../../scripts/modeling/canonical-scored-forward-input";

const AS_OF: ServerAsOf = { asOfIso: "2026-10-13T12:00:00.000Z", authority: "DB_SERVER_CLOCK_TIMESTAMP" };
const GAME_START = "2026-10-13T13:00:00+00:00";
const T90_BOUNDARY = "2026-10-13T11:30:00+00:00";
const OBSERVED = "2026-10-13T11:10:00+00:00";
const INGESTED = "2026-10-13T11:20:00+00:00";

type Source = Record<string, unknown>;

// Default: a fully valid soccer moneyline evidence row (synthetic fixture, contract test only).
function src(n = 1, overrides: Source = {}): Source {
  return {
    observation_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    item_observation_id: `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    observed_at: OBSERVED,
    ingested_at: INGESTED,
    condition_id: `cond-${n}`,
    selected_token_id: `tok-${n}-a`,
    selected_outcome: "Yes",
    metric_formula_version: "v2-lite-growth-safe",
    entry_price_num: 0.4,
    signal_confidence_num: 70,
    provider_event_id: `evt-${n}`,
    provider_sport_family: "soccer",
    market_family: "MONEYLINE",
    market_type: "moneyline",
    game_start_iso: GAME_START,
    event_title: `Team A${n} vs Team B${n}`,
    market_question: `Will Team A${n} win?`,
    ...overrides,
  };
}

const proof = (n = 1): BinaryIdentityProof => ({
  conditionId: `cond-${n}`,
  outcomeTokenIds: [`tok-${n}-a`, `tok-${n}-b`],
  authority: "CLOB_MARKET_OUTCOME_TOKENS",
});

const run = (rows: Source[], proofs?: BinaryIdentityProof[], asOf: ServerAsOf = AS_OF) =>
  adaptCanonicalScoredRows({ rows, serverAsOf: asOf, binaryIdentityProofs: proofs });

const reasonsOf = (result: ReturnType<typeof run>) => result.rejections.map((r) => r.reason);

test("positive path: approved row reaches V3 and frozen B2 with source score and availability time", () => {
  const { adapter, receipt } = runCanonicalScoredForwardV3({ rows: [src(1)], serverAsOf: AS_OF, binaryIdentityProofs: [proof(1)] });
  assert.equal(adapter.rejections.length, 0);
  assert.equal(adapter.rows.length, 1);
  assert.equal(adapter.rows[0].signal_confidence_num, 70);
  assert.equal(adapter.rows[0].created_at, "2026-10-13T11:20:00.000Z"); // ingested_at, not observed_at
  assert.equal((adapter.rows[0].diagnostics as Record<string, unknown>).marketType, "moneyline"); // verbatim
  assert.equal(receipt.selector.acceptedDecisions.length, 1);
  assert.equal(receipt.selector.acceptedDecisions[0].score, 70);
  assert.equal(receipt.selector.acceptedDecisions[0].selectedOutcome, "Yes");
  assert.deepEqual(receipt.selector.acceptedMarketClassCounts, { allowed_fullmatch_moneyline: 1 });
});

test("neg: unknown / missing formula version is rejected", () => {
  assert.deepEqual(APPROVED_SCORED_FORMULA_VERSIONS, ["v2-lite-growth-safe"]);
  const result = run(
    [
      src(1, { metric_formula_version: "shadow-firemodel1_1_research_v0" }),
      src(2, { metric_formula_version: null }),
      src(3, { metric_formula_version: "V2-LITE-GROWTH-SAFE" }),
    ],
    [proof(1), proof(2), proof(3)],
  );
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.rejectionCounts, { FORMULA_VERSION_NOT_APPROVED: 3 });
});

test("neg: missing score is rejected and no alternative score is substituted", () => {
  const result = run(
    [
      src(1, { signal_confidence_num: null, pre_event_score_num: 99, score: 99 }),
      src(2, { signal_confidence_num: "abc" }),
      src(3, { signal_confidence_num: undefined }),
    ],
    [proof(1), proof(2), proof(3)],
  );
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.rejectionCounts, { SCORE_MISSING: 3 });
});

test("score is carried verbatim; numeric strings are parsed, never altered or re-thresholded", () => {
  const { adapter, receipt } = runCanonicalScoredForwardV3({
    rows: [src(1, { signal_confidence_num: "64.9" }), src(2, { signal_confidence_num: "65" }), src(3, { entry_price_num: 0.29 })],
    serverAsOf: AS_OF,
    binaryIdentityProofs: [proof(1), proof(2), proof(3)],
  });
  assert.deepEqual(adapter.rows.map((r) => r.signal_confidence_num), [64.9, 65, 70]);
  // Frozen B2 thresholds stay in force downstream: 64.9 < 65 and price 0.29 < 0.30 are rejected by the producer.
  const reasons = receipt.selector.producerRejections.map((r) => r.reason).sort();
  assert.deepEqual(reasons, ["PRICE_BELOW_030", "SCORE_BELOW_65"]);
  assert.equal(receipt.selector.acceptedDecisions.length, 1);
  assert.equal(receipt.selector.acceptedDecisions[0].score, 65);
});

test("neg: future ingestion, future observation and ingestion-before-observation", () => {
  const result = run(
    [
      src(1, { ingested_at: "2026-10-13T12:00:00.001+00:00" }),
      src(2, { observed_at: "2026-10-13T12:00:00.001+00:00", ingested_at: "2026-10-13T12:00:00.002+00:00" }),
      src(3, { observed_at: INGESTED, ingested_at: OBSERVED }),
      src(4, { ingested_at: "not-a-time" }),
      src(5, { observed_at: "2026-10-13T11:10:00" }), // no UTC offset: refuse to guess
    ],
    [1, 2, 3, 4, 5].map(proof),
  );
  assert.equal(result.rows.length, 0);
  assert.deepEqual(reasonsOf(result), [
    "FUTURE_INGESTION",
    "FUTURE_OBSERVATION",
    "INGESTION_PRECEDES_OBSERVATION",
    "INGESTED_AT_INVALID",
    "OBSERVED_AT_INVALID",
  ]);
});

test("neg: T-90 is measured from ingested_at, not observed_at; exact boundary is allowed", () => {
  const result = run(
    [
      // Observed well before T-90 but only available in DBClone after it.
      src(1, { observed_at: "2026-10-13T10:00:00+00:00", ingested_at: "2026-10-13T11:30:00.001+00:00" }),
      src(2, { observed_at: "2026-10-13T10:00:00+00:00", ingested_at: T90_BOUNDARY }),
    ],
    [proof(1), proof(2)],
  );
  assert.deepEqual(reasonsOf(result), ["T90_VIOLATION"]);
  assert.equal(result.rejections[0].index, 0);
  assert.equal(result.rows.length, 1);
});

test("neg: invalid game start is rejected; no start is invented", () => {
  const result = run([src(1, { game_start_iso: null }), src(2, { game_start_iso: "tomorrow" })], [proof(1), proof(2)]);
  assert.deepEqual(result.rejectionCounts, { GAME_START_INVALID: 2 });
});

test("neg: unsupported market class passes through verbatim and is rejected by the unchanged V3 gate", () => {
  const { adapter, receipt } = runCanonicalScoredForwardV3({
    rows: [src(1, { market_type: "anytime_goalscorer" }), src(2, { market_type: "exact_score" }), src(3, { market_type: "moneyline" })],
    serverAsOf: AS_OF,
    binaryIdentityProofs: [proof(1), proof(2), proof(3)],
  });
  assert.deepEqual(
    adapter.rows.map((r) => (r.diagnostics as Record<string, unknown>).marketType),
    ["anytime_goalscorer", "exact_score", "moneyline"],
  );
  assert.deepEqual(receipt.selector.universeGateRejectionCounts, { MARKET_CLASS_NOT_ALLOWED: 2 });
  assert.equal(receipt.selector.acceptedDecisions.length, 1);
});

test("neg: missing market type is rejected rather than defaulted", () => {
  const result = run([src(1, { market_type: null }), src(2, { market_type: "  " })], [proof(1), proof(2)]);
  assert.deepEqual(result.rejectionCounts, { MARKET_TYPE_MISSING: 2 });
});

test("neg: sport family is carried, not filtered or invented; non-soccer is rejected by V3", () => {
  const { receipt } = runCanonicalScoredForwardV3({
    rows: [src(1, { provider_sport_family: "tennis" }), src(2, { provider_sport_family: null })],
    serverAsOf: AS_OF,
    binaryIdentityProofs: [proof(1), proof(2)],
  });
  assert.deepEqual(receipt.selector.universeGateRejectionCounts, { SPORT_FAMILY_MISSING: 1, SPORT_FAMILY_NOT_SOCCER: 1 });
  assert.equal(receipt.selector.acceptedDecisions.length, 0);
});

test("neg: unproven binary identity is rejected and top-level BINARY is never invented", () => {
  const rows = [src(1), src(2), src(3), src(4), src(5)];
  const result = run(rows, [
    // cond-2: three tokens -> not binary
    { conditionId: "cond-2", outcomeTokenIds: ["tok-2-a", "tok-2-b", "tok-2-c"], authority: "CLOB_MARKET_OUTCOME_TOKENS" },
    // cond-3: proof does not contain the selected token
    { conditionId: "cond-3", outcomeTokenIds: ["other-a", "other-b"], authority: "CLOB_MARKET_OUTCOME_TOKENS" },
    // cond-4: two conflicting proofs void each other
    { conditionId: "cond-4", outcomeTokenIds: ["tok-4-a", "tok-4-b"], authority: "CLOB_MARKET_OUTCOME_TOKENS" },
    { conditionId: "cond-4", outcomeTokenIds: ["tok-4-a", "tok-4-z"], authority: "CLOB_MARKET_OUTCOME_TOKENS" },
    // cond-5: duplicated token is not two distinct outcomes
    { conditionId: "cond-5", outcomeTokenIds: ["tok-5-a", "tok-5-a"], authority: "CLOB_MARKET_OUTCOME_TOKENS" },
    // cond-1: no proof at all
  ]);
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.rejectionCounts, { BINARY_IDENTITY_UNPROVEN: 5 });
  // Without any proofs nothing is emitted, so no row can carry an invented market_type.
  assert.equal(run(rows).rows.length, 0);
});

test("positive binary proof is the only source of top-level BINARY", () => {
  const result = run([src(1)], [proof(1)]);
  assert.equal(result.rows[0].market_type, "BINARY");
});

test("neg: event collision (same provider_event_id, different start or sport) is EVENT_GROUP_UNPROVEN", () => {
  const rows = [
    src(1, { provider_event_id: "evt-shared" }),
    src(2, { provider_event_id: "evt-shared", game_start_iso: "2026-10-13T14:00:00+00:00" }),
    src(3, { provider_event_id: "evt-sport", provider_sport_family: "soccer" }),
    src(4, { provider_event_id: "evt-sport", provider_sport_family: "tennis" }),
    src(5, { provider_event_id: null }),
    src(6, { provider_event_id: "evt-ok" }),
  ];
  const result = run(rows, [1, 2, 3, 4, 5, 6].map(proof));
  assert.deepEqual(result.rejectionCounts, { EVENT_GROUP_UNPROVEN: 5 });
  assert.equal(result.rows.length, 1);
  assert.equal((result.rows[0].diagnostics as Record<string, unknown>).providerEventId, "evt-ok");
});

test("neg: one condition mapped to two provider events is EVENT_GROUP_UNPROVEN", () => {
  const result = run(
    [src(1, { provider_event_id: "evt-a" }), src(1, { item_observation_id: "20000000-0000-0000-0000-000000000001", provider_event_id: "evt-b" })],
    [proof(1)],
  );
  assert.deepEqual(result.rejectionCounts, { EVENT_GROUP_UNPROVEN: 2 });
});

test("rows not yet available at as-of cannot poison event proof for earlier rows", () => {
  const result = run(
    [src(1, { provider_event_id: "evt-x" }), src(2, { provider_event_id: "evt-x", game_start_iso: "2026-10-13T14:00:00+00:00", ingested_at: "2026-10-13T12:30:00+00:00" })],
    [proof(1), proof(2)],
  );
  assert.deepEqual(reasonsOf(result), ["FUTURE_INGESTION"]);
  assert.equal(result.rows.length, 1);
});

test("one-per-event selection stays with frozen B2 (higher score wins within a proven physical event)", () => {
  const { receipt } = runCanonicalScoredForwardV3({
    rows: [src(1, { provider_event_id: "evt-same", signal_confidence_num: 66 }), src(2, { provider_event_id: "evt-same", signal_confidence_num: 80 })],
    serverAsOf: AS_OF,
    binaryIdentityProofs: [proof(1), proof(2)],
  });
  assert.equal(receipt.selector.acceptedDecisions.length, 1);
  assert.equal(receipt.selector.acceptedDecisions[0].score, 80);
  assert.deepEqual(receipt.selector.producerRejections.map((r) => r.reason), ["DUPLICATE_EVENT_LOWER_RANK"]);
});

test("neg: outcome leakage - outcome-bearing keys reject the row and no value is copied", () => {
  const SENTINEL = "LEAK_SENTINEL_9f3a";
  const leaky = [
    src(1, { signal_result: SENTINEL }),
    src(2, { winning_outcome: SENTINEL }),
    src(3, { real_pnl_usd: SENTINEL }),
    src(4, { settlement_price: SENTINEL }),
    src(5, { signal_result: null }), // presence alone is enough; the value is never inspected
  ];
  const { adapter, receipt } = runCanonicalScoredForwardV3({
    rows: [...leaky, src(6)],
    serverAsOf: AS_OF,
    binaryIdentityProofs: [1, 2, 3, 4, 5, 6].map(proof),
  });
  assert.deepEqual(adapter.rejectionCounts, { OUTCOME_FIELD_PRESENT: 5 });
  assert.equal(adapter.rows.length, 1);
  assert.ok(!JSON.stringify({ adapter, receipt }).includes(SENTINEL));
  for (const column of CANONICAL_SCORED_SELECT_COLUMNS) {
    assert.equal(isOutcomeFieldName(column), false, `select column ${column} must not be outcome-bearing`);
  }
  for (const forbidden of ["signal_result", "winning_outcome", "real_pnl_usd", "pre_event_score_num", "formula_version"]) {
    assert.ok(!CANONICAL_SCORED_SELECT_COLUMNS.includes(forbidden), `${forbidden} must not be selected`);
  }
  // selected_outcome is a pick label, not an outcome field.
  assert.equal(isOutcomeFieldName("selected_outcome"), false);
});

test("as-of must carry DB server authority and a valid instant", () => {
  assert.throws(() => run([src(1)], [proof(1)], { asOfIso: AS_OF.asOfIso, authority: "LOCAL_CLOCK" } as unknown as ServerAsOf), /AS_OF_AUTHORITY_UNPROVEN/);
  assert.throws(() => run([src(1)], [proof(1)], { asOfIso: "garbage", authority: "DB_SERVER_CLOCK_TIMESTAMP" }), /AS_OF_INVALID/);
});

test("deterministic receipt: identical input -> identical hash, no wall clock, input is not mutated", () => {
  const realNow = Date.now;
  Date.now = () => {
    throw new Error("wall clock must not be used");
  };
  try {
    const rows = [src(1), src(2, { signal_confidence_num: 30 })];
    const frozen = JSON.stringify(rows);
    const a = runCanonicalScoredForwardV3({ rows, serverAsOf: AS_OF, binaryIdentityProofs: [proof(1), proof(2)] });
    const b = runCanonicalScoredForwardV3({ rows, serverAsOf: AS_OF, binaryIdentityProofs: [proof(1), proof(2)] });
    assert.equal(JSON.stringify(rows), frozen);
    assert.equal(a.receipt.receiptSha256, b.receipt.receiptSha256);
    assert.match(a.receipt.receiptSha256, /^[0-9a-f]{64}$/);
    const c = runCanonicalScoredForwardV3({ rows: [src(1, { signal_confidence_num: 71 }), rows[1]], serverAsOf: AS_OF, binaryIdentityProofs: [proof(1), proof(2)] });
    assert.notEqual(a.receipt.receiptSha256, c.receipt.receiptSha256);
  } finally {
    Date.now = realNow;
  }
});
