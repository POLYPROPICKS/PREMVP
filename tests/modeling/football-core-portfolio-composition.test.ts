import { test } from "node:test";
import assert from "node:assert/strict";
import { composePriority, overlapStats, compare, renderCeoMd } from "../../scripts/modeling/football-core-portfolio-composition";
import type { SelectedCandidate } from "../../scripts/modeling/daily-portfolio-frontier";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

let seq = 0;
function pick(ev: string, at: string, price = 0.52, token = `t${++seq}`): SelectedCandidate {
  return {
    physicalEventKey: ev, decisionTimestamp: at, eventStart: "2026-09-30T00:00:00Z", leadTimeHours: 5,
    entryPrice: price, sportFamily: "soccer", ref: `c-${ev}`, candidateRef: token, tier: 1,
    day: at.slice(0, 10), candidateIdentity: `c-${ev}::${token}::${at}`,
  };
}
const T = (h: number) => `2026-09-10T${String(h).padStart(2, "0")}:00:00Z`;
const settle = (rows: Array<[SelectedCandidate, CorpusLabel]>) => new Map(rows.map(([r, l]) => [r.candidateIdentity, l] as const));

const a1 = pick("E1", T(1), 0.5, "tA1");
const a2 = pick("E2", T(2), 0.5, "tA2");
const b2diff = pick("E2", T(3), 0.55, "tB2"); // same event, different token
const b1same = { ...a1 }; // same identity
const b3 = pick("E3", T(4), 0.5, "tB3");
const A = [a1, a2];
const B = [b1same, b2diff, b3];

test("A_THEN_B: A wins different-identity overlap, B adds only unclaimed events", () => {
  const c = composePriority(A, B);
  assert.deepEqual(c.portfolio.map((r) => r.candidateIdentity).sort(), [a1, a2, b3].map((r) => r.candidateIdentity).sort());
  assert.equal(c.incremental.length, 1);
  assert.equal(c.dropped.length, 2);
});

test("B_THEN_A: B wins different-identity overlap", () => {
  const c = composePriority(B, A);
  const e2 = c.portfolio.find((r) => r.physicalEventKey === "E2")!;
  assert.equal(e2.candidateIdentity, b2diff.candidateIdentity);
  assert.equal(c.portfolio.length, 3);
  assert.equal(c.incremental.length, 0);
});

test("at most one bet per physical event", () => {
  for (const c of [composePriority(A, B), composePriority(B, A)]) {
    const keys = c.portfolio.map((r) => r.physicalEventKey);
    assert.equal(new Set(keys).size, keys.length);
  }
});

test("same-identity overlap counted once; overlap stats exact", () => {
  const o = overlapStats(A, B);
  assert.equal(o.OVERLAP_PHYSICAL_EVENT_N, 2);
  assert.equal(o.SAME_SELECTED_IDENTITY_N, 1);
  assert.equal(o.DIFFERENT_SELECTED_IDENTITY_N, 1);
  assert.equal(o.A_ONLY_EVENT_N, 0);
  assert.equal(o.B_ONLY_EVENT_N, 1);
  assert.equal(o.UNION_EVENT_N, 3);
  assert.equal(o.DIFFERENT_IDENTITY_EXAMPLES.length, 1);
});

test("settlement cannot affect priority", () => {
  const flipped = compare(A, B, settle([[a1, "WIN"], [a2, "LOSS"], [b2diff, "WIN"], [b3, "WIN"]]), 1);
  const other = compare(A, B, settle([[a1, "LOSS"], [a2, "WIN"], [b2diff, "LOSS"], [b3, "LOSS"]]), 1);
  assert.equal(flipped.A_THEN_B.metrics.selected_n, other.A_THEN_B.metrics.selected_n);
  assert.deepEqual(composePriority(A, B).portfolio.map((r) => r.candidateIdentity), composePriority(A, B).portfolio.map((r) => r.candidateIdentity));
  // A always keeps E2 under A_THEN_B even though B's E2 pick wins
  const c = composePriority(A, B);
  assert.ok(c.portfolio.some((r) => r.candidateIdentity === a2.candidateIdentity));
});

test("OPEN is not LOSS and has no PnL; ROI over settled only", () => {
  const cmp = compare([a1, a2], [b3], settle([[a1, "WIN"], [a2, "OPEN"], [b3, "LOSS"], [b2diff, "LOSS"]]), 1);
  const m = cmp.A_THEN_B.metrics;
  assert.equal(m.selected_n, 3);
  assert.equal(m.open_n, 1);
  assert.equal(m.settled_n, 2);
  assert.equal(m.losses, 1);
  assert.equal(m.pnl_u, 0); // +1 (WIN @0.5) -1 (LOSS)
  assert.equal(m.roi_pct, 0);
  assert.equal(cmp.A_THEN_B.B_incremental.pnl_u, -1);
});

test("standalone A/B metrics equal direct evaluation; deltas and ceiling consistent", () => {
  const s = settle([[a1, "WIN"], [a2, "LOSS"], [b2diff, "WIN"], [b3, "WIN"]]);
  const cmp = compare(A, B, s, 2);
  assert.equal(cmp.standalone.CORE_A.selected_n, 2);
  assert.equal(cmp.standalone.CORE_A.pnl_u, 0);
  assert.equal(cmp.standalone.CORE_B.settled_n, 3);
  assert.equal(cmp.A_THEN_B.DELTA_PNL_VS_A, Math.round((cmp.A_THEN_B.metrics.pnl_u - cmp.standalone.CORE_A.pnl_u) * 100) / 100);
  assert.ok(cmp.overlap.UNION_EVENT_N <= cmp.naive_no_overlap_ceiling.selected_n);
});

test("deterministic output regardless of input order", () => {
  const s = settle([[a1, "WIN"], [a2, "LOSS"], [b2diff, "WIN"], [b3, "WIN"]]);
  const x = compare(A, B, s, 2);
  const y = compare([...A].reverse(), [...B].reverse(), s, 2);
  assert.deepEqual(x.A_THEN_B.metrics, y.A_THEN_B.metrics);
  assert.deepEqual(x.B_THEN_A.metrics, y.B_THEN_A.metrics);
  assert.equal(renderCeoMd(x, 2), renderCeoMd(x, 2));
});
