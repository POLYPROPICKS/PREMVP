import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStrict, resolveIdentities, resolveStrict, summarize } from "../../scripts/modeling/step4c-strict-terminal-resolver";

const C = "0xabc";
const mk = (o: Record<string, unknown> = {}) => ({
  conditionId: C, closed: true, outcomes: '["A","B"]', outcomePrices: '["1","0"]', clobTokenIds: '["t1","t2"]', ...o,
});

test("WIN when selected token is the single winner", () => {
  assert.equal(classifyStrict(C, "t1", mk()).label, "WIN");
});
test("LOSS only when selected token valid and opposite wins", () => {
  const r = classifyStrict(C, "t2", mk());
  assert.equal(r.label, "LOSS");
  assert.ok(r.tokenInClobTokenIds);
});
test("selected token missing from clobTokenIds is INVALID_TOKEN_IDENTITY, never LOSS", () => {
  const r = classifyStrict(C, "tX", mk());
  assert.equal(r.label, "INVALID_TOKEN_IDENTITY");
  assert.equal(r.reason, "SELECTED_TOKEN_NOT_IN_CLOB_TOKEN_IDS");
});
test("unparsable clobTokenIds is INVALID_TOKEN_IDENTITY", () => {
  assert.equal(classifyStrict(C, "t1", mk({ clobTokenIds: "not json" })).label, "INVALID_TOKEN_IDENTITY");
  assert.equal(classifyStrict(C, "t1", mk({ clobTokenIds: undefined })).label, "INVALID_TOKEN_IDENTITY");
});
test("returned conditionId mismatch or absence is LOOKUP_UNAVAILABLE/CONDITION_ID_MISMATCH", () => {
  for (const cid of ["0xother", undefined]) {
    const r = classifyStrict(C, "t1", mk({ conditionId: cid }));
    assert.equal(r.label, "LOOKUP_UNAVAILABLE");
    assert.equal(r.reason, "CONDITION_ID_MISMATCH");
  }
});
test("conditionId comparison is case-insensitive", () => {
  assert.equal(classifyStrict("0xABC", "t1", mk()).label, "WIN");
});
test("unclosed market is OPEN", () => {
  assert.equal(classifyStrict(C, "t1", mk({ closed: false })).label, "OPEN");
});
test("null lookup is LOOKUP_UNAVAILABLE, never OPEN", () => {
  assert.equal(classifyStrict(C, "t1", null).label, "LOOKUP_UNAVAILABLE");
});
test("closed without a single >=0.99 winner is LOOKUP_UNAVAILABLE, never OPEN/LOSS", () => {
  const r = classifyStrict(C, "t1", mk({ outcomePrices: '["0.5","0.5"]' }));
  assert.equal(r.label, "LOOKUP_UNAVAILABLE");
  assert.equal(r.reason, "CLOSED_WITHOUT_SINGLE_WINNER");
});
test("empty identity is LOOKUP_UNAVAILABLE", () => {
  assert.equal(classifyStrict("", "t1", mk()).label, "LOOKUP_UNAVAILABLE");
});
test("fetcher throw is LOOKUP_UNAVAILABLE", async () => {
  const r = await resolveStrict(C, "t1", async () => { throw new Error("net"); });
  assert.equal(r.label, "LOOKUP_UNAVAILABLE");
});
test("reversed input gives identical label counts and invariants pass", async () => {
  const markets: Record<string, unknown> = {
    a: mk({ conditionId: "a" }), b: mk({ conditionId: "b", closed: false }), c: null,
    d: mk({ conditionId: "zzz" }), e: mk({ conditionId: "e" }),
  };
  const ids = [
    { condition_id: "a", selected_token_id: "t2" }, { condition_id: "b", selected_token_id: "t1" },
    { condition_id: "c", selected_token_id: "t1" }, { condition_id: "d", selected_token_id: "t1" },
    { condition_id: "e", selected_token_id: "nope" },
  ];
  const f = async (cid: string) => (markets[cid] as any) ?? null;
  const s1 = summarize(await resolveIdentities(ids, f));
  const s2 = summarize(await resolveIdentities([...ids].reverse(), f));
  assert.deepEqual({ ...s1, REASON_COUNTS: 0 }, { ...s2, REASON_COUNTS: 0 });
  assert.deepEqual(s1.REASON_COUNTS, s2.REASON_COUNTS);
  assert.deepEqual([s1.LOSS_N, s1.OPEN_N, s1.LOOKUP_UNAVAILABLE_N, s1.INVALID_TOKEN_IDENTITY_N, s1.CONDITION_ID_MISMATCH_N], [1, 1, 2, 1, 1]);
  assert.ok(s1.STRICT_INVARIANTS_PASS);
});
