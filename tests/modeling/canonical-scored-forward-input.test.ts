import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVED_SCORED_FORMULA_VERSIONS,
  CANONICAL_SCORED_AUTHORITY_STATUS,
  CANONICAL_SCORED_SELECT_COLUMNS,
  REQUIRED_SOURCE_INTEGRATION_CONTRACT,
  adaptCanonicalScoredRows,
  canonicalSourceRowSha256,
  isOutcomeFieldName,
  runCanonicalScoredForwardV3,
  type UnverifiedAsOfAssertion,
  type UnverifiedBinaryTokenPairAssertion,
} from "../../scripts/modeling/canonical-scored-forward-input";

const AS_OF: UnverifiedAsOfAssertion = { asOfIso: "2026-10-13T12:00:00.000Z" };
const GAME_START = "2026-10-13T13:00:00+00:00";
const T90_BOUNDARY = "2026-10-13T11:30:00+00:00";
const OBSERVED = "2026-10-13T11:10:00+00:00";
const INGESTED = "2026-10-13T11:20:00+00:00";

type Source = Record<string, unknown>;

// Default: a structurally valid soccer moneyline evidence row (synthetic fixture, contract test only).
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

const pair = (n = 1, tokens?: string[]): UnverifiedBinaryTokenPairAssertion => ({
  conditionId: `cond-${n}`,
  outcomeTokenIds: tokens ?? [`tok-${n}-a`, `tok-${n}-b`],
});

const run = (rows: Source[], pairs?: UnverifiedBinaryTokenPairAssertion[], asOf: UnverifiedAsOfAssertion = AS_OF) =>
  adaptCanonicalScoredRows({ rows, unverifiedAsOf: asOf, unverifiedBinaryTokenPairs: pairs });

const receiptOf = (rows: Source[], pairs?: UnverifiedBinaryTokenPairAssertion[]) =>
  runCanonicalScoredForwardV3({ rows, unverifiedAsOf: AS_OF, unverifiedBinaryTokenPairs: pairs }).receipt;

const reasonsOf = (result: ReturnType<typeof run>) => result.rejections.map((r) => r.reason);

// ---- B1: authority cannot be forged ---------------------------------------------------------

test("B1: a fully valid row with well-formed caller assertions is still AUTHORITY_UNVERIFIED and never reaches V3/B2", () => {
  const { adapter, receipt } = runCanonicalScoredForwardV3({ rows: [src(1)], unverifiedAsOf: AS_OF, unverifiedBinaryTokenPairs: [pair(1)] });
  assert.equal(adapter.authorityStatus, CANONICAL_SCORED_AUTHORITY_STATUS);
  assert.equal(adapter.requiredSourceIntegrationContract, REQUIRED_SOURCE_INTEGRATION_CONTRACT);
  assert.ok(adapter.authorityGaps.length >= 2);
  assert.equal(adapter.rows.length, 0);
  assert.deepEqual(adapter.rejectionCounts, { AUTHORITY_UNVERIFIED: 1 });
  assert.equal(receipt.selector.acceptedDecisions.length, 0);
  assert.equal(receipt.adapterEmittedCount, 0);
  assert.equal(receipt.authorityStatus, "AUTHORITY_UNVERIFIED");
});

test("B1 repro: the former string literals DB_SERVER_CLOCK_TIMESTAMP / CLOB_MARKET_OUTCOME_TOKENS cannot forge authority", () => {
  const forgedAsOf = { asOfIso: AS_OF.asOfIso, authority: "DB_SERVER_CLOCK_TIMESTAMP" } as unknown as UnverifiedAsOfAssertion;
  const forgedPairs = [{ ...pair(1), authority: "CLOB_MARKET_OUTCOME_TOKENS" }] as unknown as UnverifiedBinaryTokenPairAssertion[];
  const { adapter, receipt } = runCanonicalScoredForwardV3({ rows: [src(1)], unverifiedAsOf: forgedAsOf, unverifiedBinaryTokenPairs: forgedPairs });
  assert.equal(adapter.rows.length, 0);
  assert.deepEqual(adapter.rejectionCounts, { AUTHORITY_UNVERIFIED: 1 });
  assert.equal(receipt.selector.acceptedDecisions.length, 0);
  assert.ok(!JSON.stringify(receipt).includes('"market_type":"BINARY"'));
  // The legacy input shape (serverAsOf / binaryIdentityProofs) is no longer an accepted channel at all.
  assert.throws(
    () => adaptCanonicalScoredRows({ rows: [src(1)], serverAsOf: AS_OF, binaryIdentityProofs: forgedPairs } as unknown as Parameters<typeof adaptCanonicalScoredRows>[0]),
    /AS_OF_INVALID/,
  );
});

test("B1: no number of rows or assertions produces an emitted row, a BINARY label or an accepted decision", () => {
  const rows = [1, 2, 3, 4, 5, 6].map((n) => src(n, { signal_confidence_num: 60 + n * 5 }));
  const { adapter, receipt } = runCanonicalScoredForwardV3({ rows, unverifiedAsOf: AS_OF, unverifiedBinaryTokenPairs: [1, 2, 3, 4, 5, 6].map((n) => pair(n)) });
  assert.equal(adapter.rows.length, 0);
  assert.equal(adapter.rejections.length, rows.length);
  assert.equal(receipt.selector.acceptedDecisions.length, 0);
  assert.equal(receipt.selector.producerRejections.length, 0);
});

test("as-of must be a valid instant with an explicit offset", () => {
  assert.throws(() => run([src(1)], [pair(1)], { asOfIso: "garbage" }), /AS_OF_INVALID/);
  assert.throws(() => run([src(1)], [pair(1)], { asOfIso: "2026-10-13T12:00:00" }), /AS_OF_INVALID/);
  assert.throws(() => run([src(1)], [pair(1)], null as unknown as UnverifiedAsOfAssertion), /AS_OF_INVALID/);
});

// ---- preserved gates (exact reject reasons) -------------------------------------------------

test("neg: unknown / missing formula version is rejected", () => {
  assert.deepEqual(APPROVED_SCORED_FORMULA_VERSIONS, ["v2-lite-growth-safe"]);
  const result = run(
    [
      src(1, { metric_formula_version: "shadow-firemodel1_1_research_v0" }),
      src(2, { metric_formula_version: null }),
      src(3, { metric_formula_version: "V2-LITE-GROWTH-SAFE" }),
    ],
    [pair(1), pair(2), pair(3)],
  );
  assert.deepEqual(result.rejectionCounts, { FORMULA_VERSION_NOT_APPROVED: 3 });
});

test("neg: missing score / entry price is rejected and no alternative score is substituted", () => {
  const result = run(
    [
      src(1, { signal_confidence_num: null, pre_event_score_num: 99, score: 99 }),
      src(2, { signal_confidence_num: "abc" }),
      src(3, { signal_confidence_num: undefined }),
      src(4, { entry_price_num: null }),
    ],
    [pair(1), pair(2), pair(3), pair(4)],
  );
  assert.deepEqual(result.rejectionCounts, { ENTRY_PRICE_MISSING: 1, SCORE_MISSING: 3 });
});

test("neg: future ingestion, future observation, ingestion-before-observation, invalid times", () => {
  const result = run(
    [
      src(1, { ingested_at: "2026-10-13T12:00:00.001+00:00" }),
      src(2, { observed_at: "2026-10-13T12:00:00.001+00:00", ingested_at: "2026-10-13T12:00:00.002+00:00" }),
      src(3, { observed_at: INGESTED, ingested_at: OBSERVED }),
      src(4, { ingested_at: "not-a-time" }),
      src(5, { observed_at: "2026-10-13T11:10:00" }), // no UTC offset: refuse to guess
    ],
    [1, 2, 3, 4, 5].map((n) => pair(n)),
  );
  assert.deepEqual(reasonsOf(result), [
    "FUTURE_INGESTION",
    "FUTURE_OBSERVATION",
    "INGESTION_PRECEDES_OBSERVATION",
    "INGESTED_AT_INVALID",
    "OBSERVED_AT_INVALID",
  ]);
});

test("neg: T-90 is measured from ingested_at, not observed_at; exact boundary passes the T-90 gate", () => {
  const result = run(
    [
      // Observed well before T-90 but only available in DBClone after it.
      src(1, { observed_at: "2026-10-13T10:00:00+00:00", ingested_at: "2026-10-13T11:30:00.001+00:00" }),
      src(2, { observed_at: "2026-10-13T10:00:00+00:00", ingested_at: T90_BOUNDARY }),
    ],
    [pair(1), pair(2)],
  );
  assert.deepEqual(reasonsOf(result), ["T90_VIOLATION", "AUTHORITY_UNVERIFIED"]);
});

test("neg: invalid game start is rejected; no start is invented", () => {
  const result = run([src(1, { game_start_iso: null }), src(2, { game_start_iso: "tomorrow" })], [pair(1), pair(2)]);
  assert.deepEqual(result.rejectionCounts, { GAME_START_INVALID: 2 });
});

test("neg: missing market type is rejected rather than defaulted", () => {
  const result = run([src(1, { market_type: null }), src(2, { market_type: "  " })], [pair(1), pair(2)]);
  assert.deepEqual(result.rejectionCounts, { MARKET_TYPE_MISSING: 2 });
});

test("neg: missing / malformed / conflicting caller token pairs keep BINARY_IDENTITY_UNPROVEN", () => {
  const rows = [src(1), src(2), src(3), src(4), src(5), src(6)];
  const result = run(rows, [
    { conditionId: "cond-2", outcomeTokenIds: ["tok-2-a", "tok-2-b", "tok-2-c"] }, // three tokens
    { conditionId: "cond-3", outcomeTokenIds: ["other-a", "other-b"] }, // selected token absent
    { conditionId: "cond-4", outcomeTokenIds: ["tok-4-a", "tok-4-b"] }, // conflicting pair
    { conditionId: "cond-4", outcomeTokenIds: ["tok-4-a", "tok-4-z"] },
    { conditionId: "cond-5", outcomeTokenIds: ["tok-5-a", "tok-5-a"] }, // duplicated token
    pair(6), // well-formed, still unverified
    // cond-1: no assertion at all
  ]);
  assert.deepEqual(result.rejectionCounts, { AUTHORITY_UNVERIFIED: 1, BINARY_IDENTITY_UNPROVEN: 5 });
  assert.deepEqual(reasonsOf(result).slice(-1), ["AUTHORITY_UNVERIFIED"]);
  assert.equal(result.rejections.find((r) => r.index === 5)?.reason, "AUTHORITY_UNVERIFIED");
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
  const result = run(rows, [1, 2, 3, 4, 5, 6].map((n) => pair(n)));
  assert.deepEqual(result.rejectionCounts, { AUTHORITY_UNVERIFIED: 1, EVENT_GROUP_UNPROVEN: 5 });
  assert.equal(result.rejections.find((r) => r.reason === "AUTHORITY_UNVERIFIED")?.index, 5);
});

test("neg: one condition mapped to two provider events is EVENT_GROUP_UNPROVEN", () => {
  const result = run(
    [src(1, { provider_event_id: "evt-a" }), src(1, { item_observation_id: "20000000-0000-0000-0000-000000000001", provider_event_id: "evt-b" })],
    [pair(1)],
  );
  assert.deepEqual(result.rejectionCounts, { EVENT_GROUP_UNPROVEN: 2 });
});

test("rows not yet available at the asserted as-of cannot poison event grouping for earlier rows", () => {
  const result = run(
    [src(1, { provider_event_id: "evt-x" }), src(2, { provider_event_id: "evt-x", game_start_iso: "2026-10-13T14:00:00+00:00", ingested_at: "2026-10-13T12:30:00+00:00" })],
    [pair(1), pair(2)],
  );
  assert.deepEqual(reasonsOf(result), ["AUTHORITY_UNVERIFIED", "FUTURE_INGESTION"]);
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
    unverifiedAsOf: AS_OF,
    unverifiedBinaryTokenPairs: [1, 2, 3, 4, 5, 6].map((n) => pair(n)),
  });
  assert.deepEqual(adapter.rejectionCounts, { AUTHORITY_UNVERIFIED: 1, OUTCOME_FIELD_PRESENT: 5 });
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

test("raw event_title / market_question are neither selected, nor decision input, nor in the receipt", () => {
  assert.ok(!CANONICAL_SCORED_SELECT_COLUMNS.includes("event_title"));
  assert.ok(!CANONICAL_SCORED_SELECT_COLUMNS.includes("market_question"));
  const TITLE = "TITLE_SENTINEL_77c1 won 3-1";
  const QUESTION = "QUESTION_SENTINEL_42d0 final";
  const a = runCanonicalScoredForwardV3({ rows: [src(1, { event_title: TITLE, market_question: QUESTION })], unverifiedAsOf: AS_OF, unverifiedBinaryTokenPairs: [pair(1)] });
  const b = runCanonicalScoredForwardV3({ rows: [src(1, { event_title: "other", market_question: "other" })], unverifiedAsOf: AS_OF, unverifiedBinaryTokenPairs: [pair(1)] });
  const serialized = JSON.stringify(a);
  assert.ok(!serialized.includes("TITLE_SENTINEL") && !serialized.includes("QUESTION_SENTINEL"));
  assert.equal(a.receipt.receiptSha256, b.receipt.receiptSha256); // free text is not decision evidence
});

// ---- B2: the receipt binds the evidence -----------------------------------------------------

test("B2 repro 1: different fully rejected inputs with identical rejection counts no longer share a receipt", () => {
  const setA = [src(1, { metric_formula_version: "bad-a" }), src(2, { metric_formula_version: "bad-a" })];
  const setB = [src(11, { metric_formula_version: "bad-b" }), src(12, { metric_formula_version: "bad-b" })];
  const a = receiptOf(setA);
  const b = receiptOf(setB);
  assert.deepEqual(a.adapterRejectionCounts, b.adapterRejectionCounts);
  assert.equal(a.inputCount, b.inputCount);
  assert.notEqual(a.receiptSha256, b.receiptSha256);
  assert.notEqual(a.inputRowsSha256, b.inputRowsSha256);
  // Even rows with no usable identity keys are told apart by their allowed-field digest.
  const keyless = [src(1, { observation_id: null, metric_formula_version: "x1" })];
  const keyless2 = [src(1, { observation_id: null, metric_formula_version: "x2" })];
  assert.notEqual(receiptOf(keyless).receiptSha256, receiptOf(keyless2).receiptSha256);
});

test("B2 repro 2: replacing the second token of a binary-proof assertion changes the receipt", () => {
  const rows = [src(1)];
  const base = receiptOf(rows, [pair(1, ["tok-1-a", "tok-1-b"])]);
  const swapped = receiptOf(rows, [pair(1, ["tok-1-a", "tok-1-z"])]);
  assert.equal(base.authorityStatus, swapped.authorityStatus);
  assert.deepEqual(base.adapterRejectionCounts, swapped.adapterRejectionCounts);
  assert.notEqual(base.receiptSha256, swapped.receiptSha256);
  // The condition identity is bound too.
  const otherCondition = receiptOf(rows, [{ conditionId: "cond-other", outcomeTokenIds: ["tok-1-a", "tok-1-b"] }]);
  assert.notEqual(base.receiptSha256, otherCondition.receiptSha256);
  // Token order inside the pair is not evidence: the canonical pair is order-independent.
  assert.equal(base.receiptSha256, receiptOf(rows, [pair(1, ["tok-1-b", "tok-1-a"])]).receiptSha256);
});

test("B2: receipt carries the full rejection list with source index, row identity and reason", () => {
  const receipt = receiptOf([src(1, { signal_confidence_num: null }), src(2)], [pair(2)]);
  assert.deepEqual(
    receipt.rejections.map((r) => [r.index, r.sourceRowKey?.slice(-1), r.reason]),
    [
      [0, "1", "SCORE_MISSING"],
      [1, "2", "AUTHORITY_UNVERIFIED"],
    ],
  );
  for (const rejection of receipt.rejections) assert.match(rejection.sourceRowSha256, /^[0-9a-f]{64}$/);
});

test("B2: any significant score / formula / time / identity field change on any row, rejected or not, changes the receipt", () => {
  const base = [src(1), src(2, { metric_formula_version: "bad" })]; // second row is rejected
  const pairs = [pair(1), pair(2)];
  const baseHash = receiptOf(base, pairs).receiptSha256;
  const mutations: Source[] = [
    { signal_confidence_num: 71 },
    { entry_price_num: 0.41 },
    { metric_formula_version: "bad-2" },
    { observed_at: "2026-10-13T11:11:00+00:00" },
    { ingested_at: "2026-10-13T11:21:00+00:00" },
    { game_start_iso: "2026-10-13T13:01:00+00:00" },
    { selected_token_id: "tok-x" },
    { condition_id: "cond-x" },
    { provider_event_id: "evt-x" },
    { market_type: "spread" },
    { selected_outcome: "No" },
  ];
  for (const mutation of mutations) {
    for (const target of [0, 1]) {
      const rows = base.map((row, i) => (i === target ? { ...row, ...mutation } : row));
      if (JSON.stringify(rows) === JSON.stringify(base)) continue; // mutation equals the existing value
      assert.notEqual(receiptOf(rows, pairs).receiptSha256, baseHash, `row ${target} ${JSON.stringify(mutation)}`);
    }
  }
  // Row order is evidence (source index is part of the rejection list).
  assert.notEqual(receiptOf([base[1], base[0]], pairs).receiptSha256, baseHash);
  // As-of and a dropped/added row are evidence as well.
  assert.notEqual(runCanonicalScoredForwardV3({ rows: base, unverifiedAsOf: { asOfIso: "2026-10-13T12:00:00.001Z" }, unverifiedBinaryTokenPairs: pairs }).receipt.receiptSha256, baseHash);
  assert.notEqual(receiptOf([base[0]], pairs).receiptSha256, baseHash);
});

test("B2: outcome / settlement / PnL values never enter the digest", () => {
  const a = receiptOf([src(1, { signal_result: "WIN", real_pnl_usd: 12.5 })], [pair(1)]);
  const b = receiptOf([src(1, { signal_result: "LOSS", real_pnl_usd: -7 })], [pair(1)]);
  assert.equal(a.receiptSha256, b.receiptSha256);
  assert.equal(canonicalSourceRowSha256(src(1, { winning_outcome: "A" })), canonicalSourceRowSha256(src(1, { winning_outcome: "B" })));
});

test("deterministic receipt: identical input -> identical hash, no wall clock, input is not mutated", () => {
  const realNow = Date.now;
  Date.now = () => {
    throw new Error("wall clock must not be used");
  };
  try {
    const rows = [src(1), src(2, { signal_confidence_num: 30 })];
    const pairs = [pair(1), pair(2)];
    const frozen = JSON.stringify({ rows, pairs });
    const a = runCanonicalScoredForwardV3({ rows, unverifiedAsOf: AS_OF, unverifiedBinaryTokenPairs: pairs });
    const b = runCanonicalScoredForwardV3({ rows, unverifiedAsOf: AS_OF, unverifiedBinaryTokenPairs: [pairs[1], pairs[0]] }); // assertion order is not evidence
    assert.equal(JSON.stringify({ rows, pairs }), frozen);
    assert.equal(a.receipt.receiptSha256, b.receipt.receiptSha256);
    assert.match(a.receipt.receiptSha256, /^[0-9a-f]{64}$/);
    const c = receiptOf([src(1, { signal_confidence_num: 71 }), rows[1]], pairs);
    assert.notEqual(a.receipt.receiptSha256, c.receiptSha256);
  } finally {
    Date.now = realNow;
  }
});
