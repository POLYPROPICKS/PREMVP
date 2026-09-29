import { test } from "node:test";
import assert from "node:assert/strict";
import { replay, toPostgrestShape, selectA, type SourceRow, type AIdentity } from "../../scripts/modeling/step4c-contract-a-final-replay";

const AS_OF = "2026-09-28T10:34:08.835Z";
const START = "2026-09-28T16:00:00Z";
const row = (ev: string, c: string, t: string, price: number | string, score: number | string, created = "2026-09-28T06:00:00+00:00"): SourceRow => ({
  snapshot_event_id: ev, condition_id: c, selected_token_id: t, selected_outcome: "Yes", event_slug: `slug-${ev}`, market_slug: `m-${c}`,
  created_at: created, entry_price_num: price, signal_confidence_num: score, diagnostics: { gameStartIso: START },
}) as unknown as SourceRow;
const a = (ev: string, c: string, t: string, p: number): AIdentity => ({ event_id: ev, condition_id: c, selected_token_id: t, selected_price_num: p, snapshot_at: AS_OF, game_start_iso: START });

const src = [
  row("E1", "0xa", "t1", 0.4, 70), row("E1", "0xb", "t2", 0.5, 80), row("E1", "0xb", "t2", 0.5, 80, "2026-09-28T05:00:00+00:00"),
  row("E2", "0xc", "t3", 0.45, 60), row("E2", "0xd", "t4", 0.55, 61),
];
const aRows = [a("E1", "0xa", "t1", 0.4), a("E1", "0xb", "t2", 0.5), a("E2", "0xc", "t3", 0.45), a("E2", "0xd", "t4", 0.55)];

test("B is the Contract A producer, not the quality comparator; A is chronological-first", () => {
  const r = replay(src, aRows, AS_OF, ["E1", "E2"]);
  const e1 = r.events.find((e) => e.physicalEventKey === "E1")!;
  assert.equal(e1.A_EXACT_IDENTITY, "0xa::t1");
  assert.equal(e1.B_EXACT_IDENTITY, "0xb::t2"); // highest score wins inside the event
  assert.equal(e1.SAME_OR_DIFFERENT, "DIFFERENT");
  const e2 = r.events.find((e) => e.physicalEventKey === "E2")!;
  assert.equal(e2.B_FAIL_CLOSED, true);
  assert.deepEqual(e2.B_REJECTION_REASONS, { SCORE_BELOW_65: 2 });
  assert.equal(r.counts.PAIRED_EVENT_N, 1);
  assert.equal(r.counts.DIFFERENT_IDENTITY_PCT, 100);
});

test("determinism: reversed input and repeat produce identical B; assertions hold", () => {
  const f = replay(src, aRows, AS_OF, ["E1", "E2"]);
  const b = replay([...src].reverse(), [...aRows].reverse(), AS_OF, ["E1", "E2"]);
  assert.deepEqual(b.events, f.events);
  assert.ok(Object.values(f.assertions).every(Boolean));
});

test("rows created after as-of are rejected and flagged; outcome fields are flagged", () => {
  const future = [...src, row("E1", "0xe", "t5", 0.6, 99, "2026-09-28T11:00:00+00:00")];
  assert.equal(replay(future, aRows, AS_OF, ["E1"]).assertions.NO_SOURCE_ROW_AFTER_AS_OF, false);
  const leaked = src.map((r) => ({ ...r, winning_outcome: "Yes" }) as unknown as SourceRow);
  assert.equal(replay(leaked, aRows, AS_OF, ["E1"]).assertions.NO_OUTCOME_FIELD_IN_INPUT, false);
});

test("toPostgrestShape restores numbers and ISO timestamps without changing values", () => {
  const s = toPostgrestShape({ ...row("E1", "0xa", "t1", "0.435", "67"), created_at: "2026-09-28 08:40:11.12539+00" } as SourceRow);
  assert.equal(s.entry_price_num, 0.435);
  assert.equal(s.signal_confidence_num, 67);
  assert.equal(s.created_at, "2026-09-28T08:40:11.12539+00:00");
});

test("A tie-break uses the real comparator: lowest price, then condition_id", () => {
  const m = selectA([a("E", "0xb", "t", 0.3), a("E", "0xa", "t", 0.3), a("E", "0xc", "t", 0.2)]);
  assert.equal(m.get("E"), "0xc::t");
  assert.equal(selectA([a("E", "0xb", "t", 0.3), a("E", "0xa", "t", 0.3)]).get("E"), "0xa::t");
});
