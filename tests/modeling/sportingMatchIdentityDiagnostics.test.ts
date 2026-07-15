import test from "node:test";
import assert from "node:assert/strict";
import { inspectSportingMatchIdentity } from "../../lib/modeling/sportingMatchIdentityDiagnostics";

test("reports only candidate fields actually present and their coverage", () => {
  const result = inspectSportingMatchIdentity([{ event_slug: "match-a", condition_id: "c1", market_slug: "m1" }, { event_slug: "", condition_id: "c2", market_slug: "m2" }]);
  assert.deepEqual(result.fieldCoverage, [{ field: "event_slug", populatedRows: 1, coveragePct: 50 }]);
});

test("detects a repeated real field value spanning separate market identities", () => {
  const result = inspectSportingMatchIdentity([
    { event_slug: "match-a", condition_id: "c1", market_slug: "winner" },
    { event_slug: "match-a", condition_id: "c2", market_slug: "totals" },
  ]);
  assert.deepEqual(result.likelyMultiMarketClusters, [{ field: "event_slug", value: "match-a", rowCount: 2, distinctConditionIds: 2, distinctMarketSlugs: 2, collisionRisk: "MULTI_MARKET" }]);
});

test("does not treat a repeated value with one market identity as a collision risk", () => {
  const result = inspectSportingMatchIdentity([
    { canonical_event_key: "match-a", condition_id: "c1", market_slug: "winner" },
    { canonical_event_key: "match-a", condition_id: "c1", market_slug: "winner" },
  ]);
  assert.equal(result.likelyMultiMarketClusters.length, 0);
  assert.equal(result.collisionRisks.length, 0);
});

test("is deterministic and never mutates input rows", () => {
  const rows = [{ event_slug: "match-a", condition_id: "c1", market_slug: "winner" }, { event_slug: "match-a", condition_id: "c2", market_slug: "totals" }];
  const before = JSON.stringify(rows);
  assert.deepEqual(inspectSportingMatchIdentity(rows), inspectSportingMatchIdentity([...rows].reverse()));
  assert.equal(JSON.stringify(rows), before);
});
