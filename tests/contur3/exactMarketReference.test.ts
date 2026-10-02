import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateExactMarketReference,
  type ExactMarketIdentity,
  type ReferenceEvidence,
} from "../../lib/executor/exactMarketReference";

const START = "2026-10-02T11:00:00.000Z";
const T30_AT = "2026-10-02T10:30:00.000Z"; // 30 min before start -> T_MINUS_30 window
const T10_AT = "2026-10-02T10:45:00.000Z"; // 15 min before start -> T_MINUS_10 window
const EVENT = "provider:polymarket:game:1:2026-10-02";
const UNDER: ExactMarketIdentity = { physicalEventId: EVENT, conditionId: "0xcond", tokenId: "tok-under", side: "Under" };
const OVER: ExactMarketIdentity = { ...UNDER, tokenId: "tok-over", side: "Over" };

function book(source: "T10_BOOK" | "T30_BOOK", identity: ExactMarketIdentity, bid: number | null, ask: number | null, extra: Partial<ReferenceEvidence> = {}): ReferenceEvidence {
  const t10 = source === "T10_BOOK";
  return {
    source, identity, observationKey: `${source}:${identity.tokenId}`,
    observationPhase: t10 ? "T_MINUS_10" : "T_MINUS_30", captureComplete: true, fetchStatus: "SUCCESS",
    bestBid: bid, bestAsk: ask, observedAt: t10 ? T10_AT : T30_AT, eventStartIso: START, ...extra,
  };
}

test("A: same-condition binary mirror adds zero witnesses and never upgrades WEAK", () => {
  const result = evaluateExactMarketReference(UNDER, [
    book("T10_BOOK", UNDER, 0.48, 0.5),
    { ...book("T10_BOOK", OVER, 0.5, 0.52), source: "BINARY_COMPLEMENT" },
    book("T30_BOOK", OVER, 0.5, 0.52), // mirror even when labelled as a book witness
  ]);
  assert.equal(result.status, "WEAK");
  assert.equal(result.independent_witness_count, 1);
  assert.deepEqual(result.sources_used, ["T10_BOOK"]);
  assert.equal(result.rejected_sources.filter((r) => r.reason === "SAME_CONDITION_BINARY_MIRROR").length, 2);
});

test("A (real case): Under 0.02/0.51 with Over 0.49/0.98 mirror is UNRESOLVED, no 0.49 reference", () => {
  const result = evaluateExactMarketReference(UNDER, [
    book("T10_BOOK", UNDER, 0.02, 0.51),
    book("T30_BOOK", UNDER, 0.02, 0.52),
    { ...book("T10_BOOK", OVER, 0.49, 0.98), source: "BINARY_COMPLEMENT" },
  ]);
  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.reference_price, null);
  assert.equal(result.uncertainty, null);
  assert.equal(result.independent_witness_count, 0);
  assert.deepEqual(result.rejected_sources.map((r) => r.reason).sort(), [
    "BOOK_SPREAD_ABOVE_SOURCE_QUALITY", "BOOK_SPREAD_ABOVE_SOURCE_QUALITY", "SAME_CONDITION_BINARY_MIRROR",
  ]);
});

test("B: one valid exact temporal witness -> WEAK with its mid and half-spread", () => {
  const result = evaluateExactMarketReference(UNDER, [book("T10_BOOK", UNDER, 0.5, 0.52)]);
  assert.equal(result.status, "WEAK");
  assert.equal(result.reference_price, 0.51);
  assert.equal(result.uncertainty, 0.01);
});

test("C: T30 + T10 exact witnesses with a common price -> STRONG on the overlap", () => {
  const result = evaluateExactMarketReference(UNDER, [
    book("T30_BOOK", UNDER, 0.49, 0.51),
    book("T10_BOOK", UNDER, 0.5, 0.52),
  ]);
  assert.equal(result.status, "STRONG");
  assert.equal(result.independent_witness_count, 2);
  assert.equal(result.reference_price, 0.505);
  assert.equal(result.uncertainty, 0.005);
});

test("C: the same observation counted twice is a duplicate, not a second witness", () => {
  const t10 = book("T10_BOOK", UNDER, 0.5, 0.52);
  const result = evaluateExactMarketReference(UNDER, [t10, { ...t10 }]);
  assert.equal(result.status, "WEAK");
  assert.deepEqual(result.rejected_sources, [{ source: "T10_BOOK", reason: "DUPLICATE_OBSERVATION" }]);
});

test("D: conflicting exact witnesses with no common price -> UNRESOLVED", () => {
  const result = evaluateExactMarketReference(UNDER, [
    book("T30_BOOK", UNDER, 0.4, 0.42),
    book("T10_BOOK", UNDER, 0.5, 0.52),
  ]);
  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.reason, "WITNESS_CONFLICT_NO_COMMON_PRICE");
  assert.equal(result.reference_price, null);
});

test("E: planning evidence for a sibling market cannot validate another exact market", () => {
  const sibling: ExactMarketIdentity = { physicalEventId: EVENT, conditionId: "0xother", tokenId: "tok-x", side: "Over" };
  const result = evaluateExactMarketReference(UNDER, [
    book("T10_BOOK", UNDER, 0.5, 0.52),
    { ...book("T10_BOOK", sibling, 0.5, 0.52), source: "PLANNING_PRICE", observationKey: "plan" },
    { ...book("T10_BOOK", sibling, 0.5, 0.52), source: "OTHER_LINE", observationKey: "line" },
  ]);
  assert.equal(result.status, "WEAK");
  assert.deepEqual(result.rejected_sources.map((r) => r.reason), [
    "PLANNING_SIBLING_NOT_EXACT_MARKET", "OTHER_MARKET_NO_VALIDATED_EXACT_MAPPING",
  ]);
});

test("F: no evidence, unavailable trade, stale or incomplete books never fabricate a reference", () => {
  for (const evidence of [
    [],
    [{ ...book("T10_BOOK", UNDER, 0.5, 0.52), source: "RECENT_TRADE" as const }],
    [book("T10_BOOK", UNDER, 0.5, 0.52, { captureComplete: false })],
    [book("T10_BOOK", UNDER, 0.5, 0.52, { observedAt: "2026-10-02T10:00:00.000Z" })],
    [book("T10_BOOK", UNDER, null, 0.52)],
    [book("T10_BOOK", UNDER, 0.5, 0.52, { fetchStatus: "FAILED" })],
  ]) {
    const result = evaluateExactMarketReference(UNDER, evidence);
    assert.equal(result.status, "UNRESOLVED");
    assert.equal(result.reference_price, null);
    assert.equal(result.independent_witness_count, 0);
  }
});

test("identity inconsistency on the exact token -> UNRESOLVED even beside a valid witness", () => {
  const result = evaluateExactMarketReference(UNDER, [
    book("T10_BOOK", UNDER, 0.5, 0.52),
    book("T30_BOOK", { ...UNDER, side: "Over" }, 0.5, 0.52),
  ]);
  assert.equal(result.status, "UNRESOLVED");
  assert.equal(result.reason, "IDENTITY_INCONSISTENT");
});
