import test from "node:test";
import assert from "node:assert/strict";
import {
  assertHistoricalSportingMatchIdentityAuditSafe,
  deriveHistoricalSportingMatchKeyV1,
  buildHistoricalSportingMatchIdentityIndex,
  auditHistoricalSportingMatchIdentityV1,
} from "../../lib/modeling/historicalSportingMatchIdentity";

const start = "2026-07-12T01:00:00Z";
const row = (id: string, eventSlug: string, marketSlug = "Live market activity", gameStartIso = start) => ({
  id,
  event_slug: eventSlug,
  market_slug: marketSlug,
  diagnostics: { gameStartIso },
});

test("several A-vs-B markets at one start receive one HIGH_PAIR_START key", () => {
  const a = deriveHistoricalSportingMatchKeyV1(row("1", "Argentina vs. Switzerland", "Match winner"));
  const b = deriveHistoricalSportingMatchKeyV1(row("2", "Argentina vs. Switzerland: O/U 8.5 Total Corners", "Corners"));
  assert.equal(a.key, b.key);
  assert.equal(a.confidence, "HIGH_PAIR_START");
});

test("A-vs-B and B-vs-A at one start receive one key", () => {
  assert.equal(
    deriveHistoricalSportingMatchKeyV1(row("1", "Argentina vs. Switzerland")).key,
    deriveHistoricalSportingMatchKeyV1(row("2", "Switzerland vs. Argentina")).key,
  );
});

test("same participants at a different start receive a different key", () => {
  assert.notEqual(
    deriveHistoricalSportingMatchKeyV1(row("1", "Argentina vs. Switzerland")).key,
    deriveHistoricalSportingMatchKeyV1(row("2", "Argentina vs. Switzerland", "Winner", "2026-07-13T01:00:00Z")).key,
  );
});

test("same start never merges different participant pairs", () => {
  assert.notEqual(
    deriveHistoricalSportingMatchKeyV1(row("1", "Argentina vs. Switzerland")).key,
    deriveHistoricalSportingMatchKeyV1(row("2", "Norway vs. England")).key,
  );
});

test("one-sided market links only to the unique HIGH match in its start bucket", () => {
  const rows = [row("1", "Norway vs. England"), row("2", "Norway — Match Winner")];
  const index = buildHistoricalSportingMatchIdentityIndex(rows);
  assert.equal(index.byObservationId.get("2")?.confidence, "UNIQUE_SAME_START_LINK");
  assert.equal(index.byObservationId.get("1")?.key, index.byObservationId.get("2")?.key);
});

test("one-sided market with two possible matches is REJECTED_AMBIGUOUS", () => {
  const rows = [row("1", "Norway vs. England"), row("2", "Norway vs. Sweden"), row("3", "Norway — Match Winner")];
  const index = buildHistoricalSportingMatchIdentityIndex(rows);
  assert.equal(index.byObservationId.get("3")?.confidence, "REJECTED_AMBIGUOUS");
  assert.equal(index.byObservationId.get("3")?.key, null);
});

test("market-type suffixes do not change match identity", () => {
  assert.equal(
    deriveHistoricalSportingMatchKeyV1(row("1", "Norway vs. England - Halftime Result")).key,
    deriveHistoricalSportingMatchKeyV1(row("2", "Norway vs. England: O/U 9.5 Total Corners")).key,
  );
});

test("input permutation does not change keys, audit hash, or collision count", () => {
  const rows = [row("1", "Norway vs. England"), row("2", "England — Match Winner"), row("3", "Argentina vs. Switzerland")];
  const a = auditHistoricalSportingMatchIdentityV1(rows);
  const b = auditHistoricalSportingMatchIdentityV1([...rows].reverse());
  assert.equal(a.contentHash, b.contentHash);
  assert.equal(a.derivedMatchCollisionCount, 0);
  assert.deepEqual(a.summary, b.summary);
});

test("collision audit guard fails closed", () => {
  const audit = auditHistoricalSportingMatchIdentityV1([row("1", "Norway vs. England")]);
  assert.doesNotThrow(() => assertHistoricalSportingMatchIdentityAuditSafe(audit));
  assert.throws(
    () => assertHistoricalSportingMatchIdentityAuditSafe({ ...audit, derivedMatchCollisionCount: 1 }),
    /found 1 collisions/,
  );
});
