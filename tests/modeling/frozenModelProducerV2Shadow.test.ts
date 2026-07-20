import assert from "node:assert/strict";
import { test } from "node:test";
import {
  produceFrozenModelV2ShadowDecisions,
  FROZEN_MODEL_V2_VERSION,
} from "../../lib/modeling/frozenModelProducerV2Shadow";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";

const AS_OF = "2026-07-20T12:00:00.000Z";

function baseRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    condition_id: "cond-1",
    token_id: "tok-1",
    selected_outcome: "TEAM_A",
    score: 70,
    entry_price_num: 0.4,
    created_at: "2026-07-20T10:00:00.000Z",
    event_slug: "nba-team-a-vs-team-b",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
    ...overrides,
  };
}

test("accepts a clean eligible row", () => {
  const result = produceFrozenModelV2ShadowDecisions([baseRow()], AS_OF);
  assert.equal(result.acceptedDecisions.length, 1);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.modelVersion, FROZEN_MODEL_V2_VERSION);
  assert.equal(result.acceptedDecisions[0].selectedOutcome, "TEAM_A");
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

test("timing window: 120 minutes accepted (inclusive), 121 minutes rejected", () => {
  const at120 = produceFrozenModelV2ShadowDecisions(
    [baseRow({ diagnostics: { gameStartIso: "2026-07-20T14:00:00.000Z" } })],
    AS_OF,
  );
  assert.equal(at120.acceptedDecisions.length, 1);
  assert.equal(at120.acceptedDecisions[0].minutesUntilStart, 120);

  const at121 = produceFrozenModelV2ShadowDecisions(
    [baseRow({ diagnostics: { gameStartIso: "2026-07-20T14:01:00.000Z" } })],
    AS_OF,
  );
  assert.equal(at121.acceptedDecisions.length, 0);
  assert.equal(at121.rejections[0].reason, "OUTSIDE_120M");
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
  const rowLowScore = baseRow({ token_id: "tok-1", score: 66, created_at: "2026-07-20T10:00:00.000Z" });
  const rowHighScore = baseRow({ token_id: "tok-2", score: 90, created_at: "2026-07-20T11:00:00.000Z" });
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
  const winnerForEvent1 = forward.acceptedDecisions.find((d) => d.eventKey === rowHighScore.event_slug);
  assert.ok(winnerForEvent1);
  assert.equal(winnerForEvent1?.score, 90);
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
