import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionCandidate } from "../../lib/modeling/executionWaterfall";
import {
  bootstrapCapitalRisk,
  buildCapitalPolicyGrid,
  buildMinskOperatingDaySplit,
  replayScientificCapitalPolicy,
  selectCapitalPolicy,
  selectDevelopmentParetoPolicies,
  selectFinalArchitectureCells,
  stableHash,
  type ScientificCapitalPolicy,
} from "../../lib/modeling/scientificCapitalArchitecture";
import { renderScientificArchitectureDashboard, renderScientificFounderReport } from "../../lib/modeling/scientificArchitectureReport";

const row = (id: string, decision: string, resolved: string, price: number, result: "WIN" | "LOSS"): ExecutionCandidate => ({
  observationId: id,
  identity: id,
  matchKey: id,
  decisionAtIso: decision,
  createdAtIso: decision,
  resolvedAtIso: resolved,
  finalScore: 70,
  dataCoverage: 90,
  entryPrice: price,
  row: { id, created_at: decision, resolved_at: resolved, entry_price_num: price, signal_result: result },
});

const noVault: ScientificCapitalPolicy = { family: "NO_VAULT_FIXED100", id: "NO_VAULT_FIXED100" };

test("fixed $100 stake, settlement batching and capital reconciliation are exact", () => {
  const candidates = [
    row("a", "2026-01-01T10:00:00Z", "2026-01-02T10:00:00Z", .5, "WIN"),
    row("b", "2026-01-01T10:00:00Z", "2026-01-02T10:00:00Z", .5, "LOSS"),
  ];
  const replay = replayScientificCapitalPolicy(candidates, noVault, { maxOpenPositions: 30, maxOpenExposurePct: 1 });
  assert.deepEqual(replay.ledger.map((entry) => entry.stake), [100, 100]);
  assert.equal(replay.totalStaked, 200);
  assert.equal(replay.netPnl, 0);
  assert.equal(replay.endingActive + replay.endingVault, replay.endingTotal);
  assert.equal(replay.invalidCapitalStates, 0);
});

test("settlement policy application batches equal timestamps but preserves distinct settlement timestamps", () => {
  const policy: ScientificCapitalPolicy = { family: "HIGH_WATERMARK_DRAWDOWN_FLOOR", id: "HWM_0.20", alpha: .2 };
  const replay = replayScientificCapitalPolicy([
    row("a", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", .5, "WIN"),
    row("b", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z", .5, "WIN"),
  ], policy, { maxOpenPositions: 30, maxOpenExposurePct: 1 });
  assert.deepEqual(replay.transfers.map((transfer) => transfer.atIso), [
    "INITIAL",
    "2026-01-01T11:00:00.000Z",
    "2026-01-01T12:00:00.000Z",
  ]);
});

test("confirmation block PnL is attributed to the immutable decision operating day", () => {
  const replay = replayScientificCapitalPolicy([
    row("a", "2026-01-01T15:00:00Z", "2026-01-04T10:00:00Z", .5, "WIN"),
  ], noVault, { maxOpenPositions: 30, maxOpenExposurePct: 1 });
  assert.deepEqual(replay.blockPnl, { "2026-01-01": 100 });
});

test("accepted-per-operating-day capacity is fail-closed with one terminal reason", () => {
  const replay = replayScientificCapitalPolicy([
    row("a", "2026-01-01T15:00:00Z", "2026-01-02T10:00:00Z", .5, "WIN"),
    row("b", "2026-01-01T15:00:00Z", "2026-01-02T10:00:00Z", .5, "WIN"),
    row("c", "2026-01-01T15:00:00Z", "2026-01-02T10:00:00Z", .5, "WIN"),
  ], noVault, { maxOpenPositions: 30, maxOpenExposurePct: 1, maxAcceptedPerOperatingDay: 2 });
  assert.deepEqual(replay.ledger.map((entry) => entry.terminalReason), ["EXECUTED_FULL", "EXECUTED_FULL", "DAILY_LIMIT"]);
});

test("Vault is one-way and static/high-watermark/CPPI formulas are bounded", () => {
  const win = [row("a", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", .5, "WIN")];
  const policies: ScientificCapitalPolicy[] = [
    { family: "STATIC_CAPITAL_FLOOR", id: "STATIC_0.40", alpha: .4 },
    { family: "HIGH_WATERMARK_DRAWDOWN_FLOOR", id: "HWM_0.40", alpha: .4 },
    { family: "ONE_WAY_RATCHETED_CPPI", id: "CPPI_0.40_0.50", alpha: .4, multiplier: .5 },
  ];
  for (const policy of policies) {
    const replay = replayScientificCapitalPolicy(win, policy, { maxOpenPositions: 30, maxOpenExposurePct: 1 });
    assert.ok(replay.endingVault >= 4000);
    assert.ok(replay.transfers.every((transfer) => transfer.amount >= 0));
    assert.equal(replay.invalidCapitalStates, 0);
  }
});

test("coarse-to-fine policy grid respects exact coarse count and hard cap", () => {
  const coarse = buildCapitalPolicyGrid([]);
  assert.equal(coarse.length, 25);
  const refined = buildCapitalPolicyGrid(coarse.slice(0, 3));
  assert.ok(refined.length <= 35);
  assert.equal(new Set(refined.map((policy) => policy.id)).size, refined.length);
});

test("development refinement seeds come only from the deterministic Pareto frontier", () => {
  const seeds = selectDevelopmentParetoPolicies([
    { policy: noVault, developmentPnl: 100, maximumFall: 100, skippedPositions: 0 },
    { policy: { family: "STATIC_CAPITAL_FLOOR", id: "STATIC_0.20", alpha: .2 }, developmentPnl: 90, maximumFall: 110, skippedPositions: 1 },
    { policy: { family: "HIGH_WATERMARK_DRAWDOWN_FLOOR", id: "HWM_0.20", alpha: .2 }, developmentPnl: 95, maximumFall: 80, skippedPositions: 0 },
  ]);
  assert.deepEqual(seeds.map((policy) => policy.id), ["NO_VAULT_FIXED100", "HWM_0.20"]);
});

test("Minsk operating-day split is chronological and confirmation-isolated", () => {
  const blocks = Array.from({ length: 20 }, (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`);
  const split = buildMinskOperatingDaySplit(blocks);
  assert.equal(split.development.length, 14);
  assert.equal(split.confirmation.length, 6);
  assert.ok(split.development.every((value) => value < split.confirmation[0]));
  assert.equal(split.lockedBeforeConfirmation, true);
});

test("winner rule requires positive confirmation differential and SPA threshold", () => {
  const winner = selectCapitalPolicy([
    { policy: noVault, confirmationPnl: 1000, cvar95MaxFall: 500, probabilityBelowInitial: .1, endingVault: 0, skippedPositions: 0, spaConsistent: 1, spaUpper: 1 },
    { policy: { family: "STATIC_CAPITAL_FLOOR", id: "STATIC_0.40", alpha: .4 }, confirmationPnl: 1200, cvar95MaxFall: 400, probabilityBelowInitial: .08, endingVault: 4000, skippedPositions: 1, spaConsistent: .05, spaUpper: .08 },
  ]);
  assert.equal(winner.policy.id, "STATIC_0.40");
  const blocked = selectCapitalPolicy([
    { policy: noVault, confirmationPnl: 1000, cvar95MaxFall: 500, probabilityBelowInitial: .1, endingVault: 0, skippedPositions: 0, spaConsistent: 1, spaUpper: 1 },
    { policy: { family: "STATIC_CAPITAL_FLOOR", id: "STATIC_0.40", alpha: .4 }, confirmationPnl: 1200, cvar95MaxFall: 400, probabilityBelowInitial: .08, endingVault: 4000, skippedPositions: 1, spaConsistent: .11, spaUpper: .2 },
  ]);
  assert.equal(blocked.policy.id, "NO_VAULT_FIXED100");
});

test("selection and freeze hashes are deterministic", () => {
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }));
});

test("final architecture selection is permutation-invariant and uses explicit tie breaks", () => {
  const fixed = { model: "A", stakePolicy: "FIXED_100" as const, selectionHash: "fixed", eligibleForFinalSelection: true, confirmation: { netPnl: 1000, invalidCapitalStates: 0, maximumFallFromTotalPeak: 500, risk: { cvar95MaximumFall: 700, probabilityBelowInitial: .1 } } };
  const dynamic = { model: "B", stakePolicy: "DYNAMIC_ACTIVE_3PCT" as const, selectionHash: "dynamic", eligibleForFinalSelection: true, confirmation: { netPnl: 1050, invalidCapitalStates: 0, maximumFallFromTotalPeak: 500, risk: { cvar95MaximumFall: 700, probabilityBelowInitial: .1 } } };
  const forward = selectFinalArchitectureCells([dynamic, fixed], 4035.199895);
  const reverse = selectFinalArchitectureCells([fixed, dynamic], 4035.199895);
  assert.equal(forward.scientificWinner.selectionHash, "fixed");
  assert.deepEqual(forward, reverse);
});

test("stationary bootstrap is reproducible and reports explicit CVaR names", () => {
  const one = bootstrapCapitalRisk([100, -100, 50, -25], 2, 200, 20260716);
  const two = bootstrapCapitalRisk([100, -100, 50, -25], 2, 200, 20260716);
  assert.deepEqual(one, two);
  assert.ok(one.cvar95MaximumFall >= 0);
  assert.ok(one.probabilityBelowInitial >= 0 && one.probabilityBelowInitial <= 1);
});

test("Minsk dynamic 3% stake is fixed within a cycle and does not shrink after opening", () => {
  const candidates = [
    row("a", "2026-01-01T18:00:00+03:00", "2026-01-02T10:00:00Z", .5, "WIN"),
    row("b", "2026-01-01T19:00:00+03:00", "2026-01-02T10:00:00Z", .5, "LOSS"),
  ];
  const replay = replayScientificCapitalPolicy(candidates, noVault, { maxOpenPositions: 30, maxOpenExposurePct: 1, stakePolicy: "DYNAMIC_ACTIVE_3PCT" });
  assert.deepEqual(replay.ledger.map((entry) => entry.stake), [300, 300]);
});

test("dashboard renders supplied machine evidence without business recomputation", () => {
  const evidence = { title: "Freeze", frozenDatasetSha256: "abc", capitalFrontier: { p: 1 }, finalMatrix: [{ model: "M" }], winner: { selectionHash: "winner-hash", confirmation: { blockPnl: { a: 1 } } }, winnerCurve: [{ atIso: "x", total: 10000, active: 9000, vault: 1000, fallFromTotalPeak: 0 }], bootstrap: { cvar95MaximumFall: 123 } };
  const html = renderScientificArchitectureDashboard(evidence);
  assert.match(html, /winner-hash/);
  assert.match(html, /cvar95MaximumFall/);
  assert.match(html, /24×7\/night-only/);
  const embedded = html.match(/<script type="application\/json" id="machine-evidence">(.*?)<\/script>/)?.[1];
  assert.ok(embedded);
  assert.deepEqual(JSON.parse(embedded), evidence);
});

test("plain-Russian founder report is generated only from supplied evidence", () => {
  const cell = { model: "M", stakePolicy: "FIXED_100", operationScenario: "NIGHT_ONLY", capitalPolicy: { id: "NO_VAULT_FIXED100" }, capacity: { maxOpenPositions: 30, maxOpenExposurePct: .8, maxAcceptedPerOperatingDay: 100 }, confirmation: { executedMatches: 1, netPnl: 50, roi: 50, endingTotal: 10050, minimumTotal: 10000, maximumFallFromTotalPeak: 0, risk: { cvar95MaximumFall: 10, probabilityBelowInitial: .1 } } };
  const report = renderScientificFounderReport({ datasetSha256: "abc", sensitivityVerdict: "UNIVERSAL_POLICY_SUPPORTED", primaryCapitalPolicy: "NO_VAULT_FIXED100", sensitivityCapitalPolicy: "NO_VAULT_FIXED100", primarySpa: { consistent: .5, upper: .6 }, sensitivitySpa: { consistent: .4, upper: .5 }, pnlMax: cell, riskMin: cell, winner: cell });
  assert.match(report, /отчёт основателю/);
  assert.match(report, /historical pseudo-out-of-sample/);
  assert.match(report, /Ireland parity/);
});
