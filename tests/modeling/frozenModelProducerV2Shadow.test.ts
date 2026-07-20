import assert from "node:assert/strict";
import { test } from "node:test";
import {
  produceFrozenModelV2ShadowDecisions,
  FROZEN_MODEL_V2_VERSION,
} from "../../lib/modeling/frozenModelProducerV2Shadow";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";

const AS_OF = "2026-07-20T12:00:00.000Z";
const GAME_START = "2026-07-20T13:00:00.000Z"; // fixed anchor for all boundary math below

// T-90 eligibility (accepted source: executionWaterfall.ts's T90 resolution)
// requires created_at <= game_start - 90min. Combined with the timing gate
// (accepted source: boundedRoutingExperiments.ts's passesTimingWithin120m,
// 0 <= hoursUntilStart < 2), the effective reachable minutesUntilStart range
// for any T-90-RESOLVED, ACCEPTED row is [90, 120) -- never 0-89, because a
// row with minutesUntilStart < 90 is, by construction, not T-90-eligible in
// the first place (it fails SNAPSHOT_NOT_T90_COMPATIBLE before the timing
// gate is ever evaluated). This is not a gap in coverage: it is the correct,
// literal consequence of combining both accepted-source gates faithfully. Do
// not weaken the T-90 gate to make sub-90-minute rows reach OUTSIDE_120M --
// that would reintroduce the near-kickoff/in-play leakage defect this repair
// fixes (see FROZEN_MODEL_V2_SHADOW_FINAL_ACCEPTANCE.md P1-2).
const T90_BOUNDARY = "2026-07-20T11:30:00.000Z"; // game_start - 90min, exactly

function baseRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    condition_id: "cond-1",
    token_id: "tok-1",
    selected_outcome: "TEAM_A",
    score: 70,
    entry_price_num: 0.4,
    created_at: T90_BOUNDARY,
    event_slug: "nba-team-a-vs-team-b",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    diagnostics: { gameStartIso: GAME_START },
    ...overrides,
  };
}

test("accepts a clean eligible row (T-90-exact snapshot, 90 minutes to start)", () => {
  const result = produceFrozenModelV2ShadowDecisions([baseRow()], AS_OF);
  assert.equal(result.acceptedDecisions.length, 1);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.modelVersion, FROZEN_MODEL_V2_VERSION);
  assert.equal(result.acceptedDecisions[0].selectedOutcome, "TEAM_A");
  assert.equal(result.acceptedDecisions[0].minutesUntilStart, 90);
});

test("score threshold: 65 accepted, 64 rejected", () => {
  const at65 = produceFrozenModelV2ShadowDecisions([baseRow({ score: 65 })], AS_OF);
  assert.equal(at65.acceptedDecisions.length, 1);

  const at64 = produceFrozenModelV2ShadowDecisions([baseRow({ score: 64 })], AS_OF);
  assert.equal(at64.acceptedDecisions.length, 0);
  assert.equal(at64.rejections[0].reason, "SCORE_BELOW_65");
});

test("price floor: 0.30 accepted, 0.29 rejected", () => {
  const at030 = produceFrozenModelV2ShadowDecisions([baseRow({ entry_price_num: 0.3 })], AS_OF);
  assert.equal(at030.acceptedDecisions.length, 1);

  const at029 = produceFrozenModelV2ShadowDecisions([baseRow({ entry_price_num: 0.29 })], AS_OF);
  assert.equal(at029.acceptedDecisions.length, 0);
  assert.equal(at029.rejections[0].reason, "PRICE_BELOW_030");
});

test("timing upper bound: 119.999 minutes accepted, exactly 120 rejected, 121 rejected", () => {
  // created_at chosen so the row is its own T-90-eligible snapshot (created
  // well before game_start - 90min is not needed here -- we only need
  // created_at <= game_start - 90min, which all three cases below satisfy,
  // since minutesUntilStart 119.999/120/121 are all >= 90).
  const at119_999 = produceFrozenModelV2ShadowDecisions(
    [baseRow({ created_at: "2026-07-20T11:00:00.001Z" })], // 119.999... min before start
    AS_OF,
  );
  assert.equal(at119_999.acceptedDecisions.length, 1);
  assert.ok(at119_999.acceptedDecisions[0].minutesUntilStart < 120);
  assert.ok(at119_999.acceptedDecisions[0].minutesUntilStart > 119.99);

  const at120 = produceFrozenModelV2ShadowDecisions(
    [baseRow({ created_at: "2026-07-20T11:00:00.000Z" })], // exactly 120 min before start
    AS_OF,
  );
  assert.equal(at120.acceptedDecisions.length, 0);
  assert.equal(at120.rejections[0].reason, "OUTSIDE_120M");

  const at121 = produceFrozenModelV2ShadowDecisions(
    [baseRow({ created_at: "2026-07-20T10:59:00.000Z" })], // 121 min before start
    AS_OF,
  );
  assert.equal(at121.acceptedDecisions.length, 0);
  assert.equal(at121.rejections[0].reason, "OUTSIDE_120M");
});

test("timing lower bound is enforced by T-90 eligibility: a row created less than 90 minutes before start is never T-90-eligible, so it fails closed as SNAPSHOT_NOT_T90_COMPATIBLE (not OUTSIDE_120M) -- it can never reach the timing gate with minutesUntilStart in [0,90)", () => {
  const near0 = produceFrozenModelV2ShadowDecisions(
    [baseRow({ created_at: "2026-07-20T12:59:00.000Z" })], // 1 min before start
    "2026-07-20T13:00:00.000Z", // as-of after the row's own created_at, so it's visible and reaches T-90 resolution
  );
  assert.equal(near0.acceptedDecisions.length, 0);
  assert.equal(near0.rejections[0].reason, "SNAPSHOT_NOT_T90_COMPATIBLE");

  const afterStart = produceFrozenModelV2ShadowDecisions(
    [baseRow({ created_at: "2026-07-20T13:05:00.000Z" })], // 5 min AFTER start (negative minutesUntilStart)
    "2026-07-20T13:10:00.000Z", // as-of after the row's own created_at, so it's visible and reaches T-90 resolution
  );
  assert.equal(afterStart.acceptedDecisions.length, 0);
  assert.equal(afterStart.rejections[0].reason, "SNAPSHOT_NOT_T90_COMPATIBLE");
});

test("T-90 snapshot resolution: latest eligible snapshot wins; one millisecond after the T-90 boundary is ineligible and does not displace the earlier valid snapshot", () => {
  const earlierValid = baseRow({ created_at: "2026-07-20T11:00:00.000Z", score: 71 }); // 120min before start: T-90 eligible
  const exactlyAtT90 = baseRow({ created_at: T90_BOUNDARY, score: 80 }); // exactly at T-90: eligible, later than earlierValid
  const oneMsAfterT90 = baseRow({ created_at: "2026-07-20T11:30:00.001Z", score: 99 }); // 1ms after T-90: INELIGIBLE

  const result = produceFrozenModelV2ShadowDecisions([earlierValid, exactlyAtT90, oneMsAfterT90], AS_OF);
  assert.equal(result.acceptedDecisions.length, 1);
  // The winner must be exactlyAtT90 (score 80, minutesUntilStart 90) -- the
  // latest ELIGIBLE snapshot -- never oneMsAfterT90 (score 99, ineligible),
  // proving the higher-score-but-ineligible row cannot displace it.
  assert.equal(result.acceptedDecisions[0].score, 80);
  assert.equal(result.acceptedDecisions[0].minutesUntilStart, 90);
});

test("T-90 snapshot resolution is order-independent (shuffled input selects the same snapshot)", () => {
  const earlierValid = baseRow({ created_at: "2026-07-20T11:00:00.000Z", score: 71 });
  const exactlyAtT90 = baseRow({ created_at: T90_BOUNDARY, score: 80 });
  const oneMsAfterT90 = baseRow({ created_at: "2026-07-20T11:30:00.001Z", score: 99 });

  const forward = produceFrozenModelV2ShadowDecisions([earlierValid, exactlyAtT90, oneMsAfterT90], AS_OF);
  const shuffled = produceFrozenModelV2ShadowDecisions([oneMsAfterT90, earlierValid, exactlyAtT90], AS_OF);
  const shuffled2 = produceFrozenModelV2ShadowDecisions([exactlyAtT90, oneMsAfterT90, earlierValid], AS_OF);

  assert.deepEqual(forward.acceptedDecisions, shuffled.acceptedDecisions);
  assert.deepEqual(forward.acceptedDecisions, shuffled2.acceptedDecisions);
});

test("rejects rows created after the as-of boundary (future data)", () => {
  const result = produceFrozenModelV2ShadowDecisions(
    [baseRow({ created_at: "2026-07-20T12:00:01.000Z" })],
    AS_OF,
  );
  assert.equal(result.acceptedDecisions.length, 0);
  assert.equal(result.rejections[0].reason, "FUTURE_DATA_REJECTED");
});

test("rejects malformed created_at and malformed event start as snapshot-incompatible", () => {
  const badCreated = produceFrozenModelV2ShadowDecisions([baseRow({ created_at: "not-a-date" })], AS_OF);
  assert.equal(badCreated.rejections[0].reason, "SNAPSHOT_NOT_T90_COMPATIBLE");

  const badStart = produceFrozenModelV2ShadowDecisions(
    [baseRow({ diagnostics: { gameStartIso: "not-a-date" } })],
    AS_OF,
  );
  assert.equal(badStart.rejections[0].reason, "SNAPSHOT_NOT_T90_COMPATIBLE");
});

test("excludes eSports markets", () => {
  const result = produceFrozenModelV2ShadowDecisions(
    [baseRow({ event_slug: "lol-worlds-final", market_slug: "lol-worlds-final-winner" })],
    AS_OF,
  );
  assert.equal(result.acceptedDecisions.length, 0);
  assert.equal(result.rejections[0].reason, "ESPORTS_EXCLUDED");
});

test("fails closed on missing identity fields", () => {
  const missingCondition = produceFrozenModelV2ShadowDecisions(
    [baseRow({ condition_id: undefined })],
    AS_OF,
  );
  assert.equal(missingCondition.rejections[0].reason, "MISSING_EVENT_IDENTITY");

  const missingToken = produceFrozenModelV2ShadowDecisions([baseRow({ token_id: undefined })], AS_OF);
  assert.equal(missingToken.rejections[0].reason, "MISSING_TOKEN_ID");

  const missingOutcome = produceFrozenModelV2ShadowDecisions(
    [baseRow({ selected_outcome: undefined })],
    AS_OF,
  );
  assert.equal(missingOutcome.rejections[0].reason, "MISSING_SELECTED_OUTCOME");
});

// Integration Milestone 2B.2: current source-contract alignment. The real
// generated_signal_pairs schema and Contur3's own buildFireModelCandidates.ts
// query (SIGNAL_SELECT_COLS) both use `selected_token_id` as the canonical
// token identity column -- proven directly from lib/executor/buildFireModelCandidates.ts's
// SIGNAL_SELECT_COLS constant and its `row.selected_token_id` reads
// throughout (identity key, candidate mapping, idempotency key). The frozen
// model previously only recognized `token_id`/`tokenId` (the accepted
// historical exporter format), causing every real current-schema row to
// fail closed as MISSING_TOKEN_ID even when otherwise fully eligible.
test("current canonical token contract: selected_token_id (Contur3's own field) is recognized and produces a decision when every other gate passes", () => {
  const result = produceFrozenModelV2ShadowDecisions(
    [baseRow({ token_id: undefined, selected_token_id: "tok-1" })],
    AS_OF,
  );
  assert.equal(result.acceptedDecisions.length, 1);
  assert.equal(result.rejections.length, 0);
});

test("accepted historical exporter contract continues to work: token_id (legacy field) still resolves", () => {
  const result = produceFrozenModelV2ShadowDecisions([baseRow()], AS_OF); // baseRow() uses token_id
  assert.equal(result.acceptedDecisions.length, 1);
});

test("condition_id is never used as token_id: a row with only condition_id (no token_id/selected_token_id anywhere) fails closed as MISSING_TOKEN_ID, not accepted with condition_id borrowed as the token", () => {
  const result = produceFrozenModelV2ShadowDecisions(
    [baseRow({ token_id: undefined, selected_token_id: undefined })],
    AS_OF,
  );
  assert.equal(result.acceptedDecisions.length, 0);
  assert.equal(result.rejections[0].reason, "MISSING_TOKEN_ID");
  // Defensive: even if condition_id and token_id happened to collide in a
  // pathological fixture, the decision (if any) must never report a token
  // identity equal to the condition identity via the condition_id fallback
  // path -- there is no such fallback path in the implementation, verified
  // by source inspection (resolveIdentity reads tokenId only from
  // TOKEN_ID_FIELDS, never from CONDITION_ID_FIELDS or conditionId).
});

test("ambiguous token value fails closed: a non-string/non-number selected_token_id (e.g. an array of candidate tokens) is not accepted as a token identity", () => {
  const result = produceFrozenModelV2ShadowDecisions(
    [baseRow({ token_id: undefined, selected_token_id: ["tok-1", "tok-2"] as unknown as string })],
    AS_OF,
  );
  assert.equal(result.acceptedDecisions.length, 0);
  assert.equal(result.rejections[0].reason, "MISSING_TOKEN_ID");
});

test("production incident regression: a realistic current-schema row (selected_token_id, no legacy token_id) that also fails another frozen gate is rejected for THAT reason, not MISSING_TOKEN_ID -- proves the token fix doesn't silently paper over other gates", () => {
  const belowScore = produceFrozenModelV2ShadowDecisions(
    [baseRow({ token_id: undefined, selected_token_id: "tok-1", score: 40 })],
    AS_OF,
  );
  assert.equal(belowScore.rejections[0].reason, "SCORE_BELOW_65");
});

test("rejects unsupported market family", () => {
  const result = produceFrozenModelV2ShadowDecisions([baseRow({ market_type: "SCALAR" })], AS_OF);
  assert.equal(result.rejections[0].reason, "UNSUPPORTED_MARKET");
});

test("leakage prevention: winning_outcome / real_pnl_usd never change the decision", () => {
  const clean = produceFrozenModelV2ShadowDecisions([baseRow()], AS_OF);
  const withLeakageWin = produceFrozenModelV2ShadowDecisions(
    [baseRow({ winning_outcome: "TEAM_A", real_pnl_usd: 500 })],
    AS_OF,
  );
  const withLeakageLoss = produceFrozenModelV2ShadowDecisions(
    [baseRow({ winning_outcome: "TEAM_B", real_pnl_usd: -500 })],
    AS_OF,
  );
  assert.deepEqual(clean.acceptedDecisions, withLeakageWin.acceptedDecisions);
  assert.deepEqual(clean.acceptedDecisions, withLeakageLoss.acceptedDecisions);
});

test("one-per-event dedup: deterministic tie-break, order-independent", () => {
  const rowLowScore = baseRow({ token_id: "tok-1", score: 66, created_at: T90_BOUNDARY });
  const rowHighScore = baseRow({ token_id: "tok-2", score: 90, created_at: "2026-07-20T11:15:00.000Z" });
  const rowOtherEvent = baseRow({
    condition_id: "cond-2",
    token_id: "tok-3",
    event_slug: "nhl-team-c-vs-team-d",
    market_slug: "nhl-team-c-vs-team-d-moneyline",
  });

  const forward = produceFrozenModelV2ShadowDecisions([rowLowScore, rowHighScore, rowOtherEvent], AS_OF);
  const reversed = produceFrozenModelV2ShadowDecisions([rowOtherEvent, rowHighScore, rowLowScore], AS_OF);

  assert.equal(forward.acceptedDecisions.length, 2);
  assert.deepEqual(
    forward.acceptedDecisions.map((d) => d.decisionId).sort(),
    reversed.acceptedDecisions.map((d) => d.decisionId).sort(),
  );
  // eventKey is the canonical grouping key from eventGroupSelection.ts
  // (normalized + source-prefixed, e.g. "slug:nba-team-a-vs-team-b"), not the
  // raw event_slug -- both rows share the same event_slug, so they must
  // resolve to the same eventKey and only the higher-scoring one survives.
  const eventKeys = forward.acceptedDecisions.map((d) => d.eventKey);
  assert.equal(new Set(eventKeys).size, forward.acceptedDecisions.length, "no duplicate eventKeys among accepted decisions");
  const winnerForEvent1 = forward.acceptedDecisions.find((d) => d.score === 90);
  assert.ok(winnerForEvent1, "the score-90 row must be the accepted winner for its event");
  const duplicateRejection = forward.rejections.find((r) => r.reason === "DUPLICATE_EVENT_LOWER_RANK");
  assert.ok(duplicateRejection);
});

test("determinism: repeated runs are byte-identical", () => {
  const rows = [baseRow(), baseRow({ condition_id: "cond-2", token_id: "tok-2", event_slug: "nhl-x-vs-y", market_slug: "nhl-x-vs-y-ml" })];
  const first = JSON.stringify(produceFrozenModelV2ShadowDecisions(rows, AS_OF));
  const second = JSON.stringify(produceFrozenModelV2ShadowDecisions(rows, AS_OF));
  assert.equal(first, second);
});

test("does not import any reservation/queue/Ireland/CLOB module", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../lib/modeling/frozenModelProducerV2Shadow.ts", import.meta.url), "utf8"),
  );
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line));
  const forbidden = [
    "nightEventReservations",
    "eventExecutionQueue",
    "executorOrderEvents",
    "executorQueueMark",
    "ireland",
    "Ireland",
    "clob",
    "CLOB",
  ];
  for (const line of importLines) {
    for (const token of forbidden) {
      assert.ok(!line.includes(token), `import line must not reference ${token}: ${line}`);
    }
  }
});
