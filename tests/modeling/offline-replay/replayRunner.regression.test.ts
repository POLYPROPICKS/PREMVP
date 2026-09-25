/**
 * REPLAY RUNNER — model-ready view shape, no identity collapse, deterministic
 * rerun, and a C0 known-result regression pinned to the committed immutable
 * Sep01–08 corpus (independent of any later production-ingested day file).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModelReadyView } from "../../../lib/modeling/offline-replay/modelReadyView";
import { runReplay } from "../../../lib/modeling/offline-replay/replayRunner";

const WINDOW = { from: "2026-09-01", to: "2026-09-08", asOf: "2026-09-10T14:04:29.586Z" as const };

test("model-ready view: one row per market/outcome identity, physical events NOT collapsed", () => {
  const v = loadModelReadyView(WINDOW);
  assert.ok(v.rows.length > 15000, `expected the full Sep01-08 identity universe, got ${v.rows.length}`);
  // more identities than physical events — multi-market events preserved
  assert.ok(
    v.meta.counts.IDENTITY_N > v.meta.counts.DISTINCT_PHYSICAL_EVENT_N,
    "identities must not be collapsed to physical events in the view",
  );
  const sample = v.rows[0];
  for (const k of [
    "research_identity",
    "physical_event_id",
    "condition_id",
    "sport",
    "entry_price",
    "lead_time_hours",
    "terminal_status",
    "settlement_provenance",
    "gross_pnl_u_if_loss",
  ]) {
    assert.ok(k in sample, `model-ready row missing "${k}"`);
  }
});

test("deterministic: two runs produce an identical determinism hash", () => {
  const a = runReplay({ models: "all", groupBy: "sport", ...WINDOW });
  const b = runReplay({ models: "all", groupBy: "sport", ...WINDOW });
  assert.equal(a.determinism_hash, b.determinism_hash);
});

test("C0 known-result regression (Sep01-08, committed immutable corpus)", () => {
  const run = runReplay({ models: ["C0"], groupBy: "none", ...WINDOW });
  const c0 = run.overall.find((r) => r.MODEL === "C0")!;
  assert.equal(c0.TERMINAL_BET_N, 1578);
  assert.equal(c0.WINS, 931);
  assert.equal(c0.LOSSES, 647);
  assert.equal(c0.GROSS_PNL_U, 241.6);
  assert.equal(c0.GROSS_ROI_PCT, 15.3107);
  assert.equal(c0.MAX_DD_U, -23.24);
});

test("C4 ≡ C1 on this window (lead≥24 branch never fires in September) and C5 ≡ C0", () => {
  const run = runReplay({ models: ["C0", "C1", "C2", "C3", "C4", "C5"], groupBy: "none", ...WINDOW });
  const g = Object.fromEntries(run.overall.map((r) => [r.MODEL, r]));
  assert.equal(g.C2.SIMULATED_BET_N, 0);
  assert.equal(g.C3.SIMULATED_BET_N, 0);
  assert.equal(g.C4.GROSS_PNL_U, g.C1.GROSS_PNL_U);
  assert.equal(g.C4.TERMINAL_BET_N, g.C1.TERMINAL_BET_N);
  assert.equal(g.C5.GROSS_PNL_U, g.C0.GROSS_PNL_U);
});

test("UNRESOLVED bets never enter ROI", () => {
  const run = runReplay({ models: ["C0"], groupBy: "none", ...WINDOW });
  const c0 = run.overall[0];
  assert.equal(c0.WINS + c0.LOSSES, c0.TERMINAL_BET_N);
  assert.equal(c0.SIMULATED_BET_N, c0.TERMINAL_BET_N + c0.UNRESOLVED_BET_N);
});
