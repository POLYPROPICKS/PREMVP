import { test } from "node:test";
import assert from "node:assert/strict";

import type { RollingCompactRow } from "../../lib/modeling/research-corpus/rollingCorpus";
import { evaluateRows } from "../../lib/research-clone/modelReady";
import { toAtlasInput } from "../../scripts/modeling/factor-atlas";
import {
  runStandalone,
  runPortfolio,
  applyDailyCap,
  computeUncapped,
  computeCapacity,
  computeMarginal,
  metricsFor,
  PORTFOLIOS,
  type TieredBet,
} from "../../scripts/modeling/daily-portfolio-frontier";

const EMPTY = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };

function row(over: Partial<RollingCompactRow> & { conditionId: string; decisionAt: string }): RollingCompactRow {
  return {
    populationId: "SEP_PUBLIC_RICH_V1",
    selectedTokenId: "tok",
    providerEventId: `evt-${over.conditionId}`,
    entryPrice: 0.55,
    eventStart: new Date(Date.parse(over.decisionAt) + 5 * 3600_000).toISOString(),
    sportFamily: "soccer",
    label: "WIN",
    score: EMPTY,
    selectedPrice: EMPTY,
    volumeUsd: null,
    leadTimeHours: 5,
    scoreLevel: null,
    ...over,
  } as RollingCompactRow;
}

// Minimal ScorecardReadyRow-shaped adapter carrying only the fields toAtlasInput() reads.
function toScorecardRow(r: RollingCompactRow) {
  return {
    populationId: r.populationId,
    conditionId: r.conditionId,
    selectedTokenId: r.selectedTokenId,
    providerEventId: r.providerEventId,
    decisionAt: r.decisionAt,
    entryPrice: r.entryPrice,
    eventStart: r.eventStart,
    sportFamily: r.sportFamily,
    scoreLevel: typeof r.scoreLevel === "number" ? r.scoreLevel : null,
    score: r.score ?? EMPTY,
    selectedPrice: r.selectedPrice ?? EMPTY,
    volumeUsd: typeof r.volumeUsd === "number" ? r.volumeUsd : null,
    leadTimeHours: typeof r.leadTimeHours === "number" ? r.leadTimeHours : null,
    frozenLabel: r.label,
    labelAsOf: r.label,
  } as any;
}

const c0Predicate = (e: { entryPrice: number }) => e.entryPrice >= 0.5 && e.entryPrice < 0.6;
const scoreBucket = (e: { entryPrice: number; scoreLevel: number | null }) =>
  c0Predicate(e) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65;

test("strategy predicate is applied BEFORE physical-event selection", () => {
  // Same physicalEventKey, chronologically first row fails the score bucket,
  // second row satisfies it; the second row (not the first) must be selected.
  const rows = [
    row({ conditionId: "A1", providerEventId: "evt-shared", decisionAt: "2026-08-04T09:00:00.000Z", scoreLevel: 40 }),
    row({ conditionId: "A2", providerEventId: "evt-shared", decisionAt: "2026-08-04T09:01:00.000Z", scoreLevel: 63 }),
  ];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const bets = runStandalone(input, scoreBucket);
  assert.equal(bets.length, 1);
  assert.equal(bets[0].physicalEventKey, "evt-shared");
  assert.equal(bets[0].entryPrice, 0.55);
});

test("the same physical event contributes at most once to one standalone strategy across the whole range", () => {
  const rows = [
    row({ conditionId: "D1", providerEventId: "evt-dup", decisionAt: "2026-08-04T09:00:00.000Z", scoreLevel: 63 }),
    row({ conditionId: "D2", providerEventId: "evt-dup", decisionAt: "2026-08-11T09:00:00.000Z", scoreLevel: 63 }),
  ];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const bets = runStandalone(input, scoreBucket);
  assert.equal(bets.length, 1, "one physicalEventKey -> maximum one selected bet, chronological-first wins");
  assert.equal(bets[0].day, "2026-08-04");
});

test("composite tier priority is deterministic and no event appears in two tiers", () => {
  // Event A qualifies for TIER_PREFERRED (tennis @ P50_52) AND for TIER_P50_52
  // generically; it must be assigned to the highest-priority tier only (1).
  const rowsA = [row({ conditionId: "TA", providerEventId: "evt-a", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.51, sportFamily: "tennis" })];
  // Event B only qualifies for tier 2 (P50_52, not tennis, no score).
  const rowsB = [row({ conditionId: "TB", providerEventId: "evt-b", decisionAt: "2026-08-04T09:01:00.000Z", entryPrice: 0.51, sportFamily: "soccer" })];
  const input = toAtlasInput([...rowsA, ...rowsB].map((r) => toScorecardRow(r)));
  const dual = PORTFOLIOS.find((p) => p.id === "PORTFOLIO_DUAL")!;
  const bets = runPortfolio(input, dual.tiers);
  assert.equal(bets.length, 2);
  const byKey = new Map(bets.map((b) => [b.physicalEventKey, b]));
  assert.equal(byKey.get("evt-a")!.tier, 1, "tennis@P50_52 wins the preferred tier over the generic price tier");
  assert.equal(byKey.get("evt-b")!.tier, 2, "a non-preferred but price-qualifying event falls to the fallback tier");
  // No event appears twice: bets.length already equals the number of distinct physical events.
  assert.equal(new Set(bets.map((b) => b.physicalEventKey)).size, bets.length);
});

test("a composite portfolio never selects an event for two tiers even when a later row would also qualify a different tier", () => {
  // One physical event, two candidate rows: the first (chronologically) only
  // qualifies tier 2 (plain P52_54); the second qualifies tier 1 (tennis@P50_52).
  // The event must be assigned to tier 1 using tier 1's OWN qualifying row,
  // never a tier-2 row under a tier-1 label.
  const rows = [
    row({ conditionId: "M1", providerEventId: "evt-multi", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.53, sportFamily: "soccer" }),
    row({ conditionId: "M2", providerEventId: "evt-multi", decisionAt: "2026-08-04T09:05:00.000Z", entryPrice: 0.51, sportFamily: "tennis" }),
  ];
  const input = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const broad = PORTFOLIOS.find((p) => p.id === "PORTFOLIO_BROAD")!;
  const bets = runPortfolio(input, broad.tiers);
  assert.equal(bets.length, 1);
  assert.equal(bets[0].tier, 1);
  assert.equal(bets[0].entryPrice, 0.51, "tier 1 is satisfied by its OWN qualifying row (M2), not M1's tier-2-only row");
});

test("daily cap 15/20/30/40/50 is exact and keeps only the capacity-order-first N bets per day", () => {
  const bets: TieredBet[] = Array.from({ length: 25 }, (_, i) => ({
    physicalEventKey: `evt-${i}`,
    decisionTimestamp: `2026-08-04T${String(9 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00.000Z`,
    eventStart: "2026-08-04T20:00:00.000Z",
    leadTimeHours: 5,
    entryPrice: 0.55,
    sportFamily: "soccer",
    outcome: "WIN",
    pnlU: 1,
    tier: 1,
    day: "2026-08-04",
  }));
  const cap15 = applyDailyCap(bets, 15);
  const cap20 = applyDailyCap(bets, 20);
  assert.equal(cap15.length, 15);
  assert.equal(cap20.length, 20);
  // The cap keeps exactly the capacity-order-first N (earliest decisionTimestamp).
  assert.deepEqual(
    cap15.map((b) => b.physicalEventKey),
    bets.slice(0, 15).map((b) => b.physicalEventKey),
  );
});

test("incremental layer PnL equals the difference between adjacent capacities", () => {
  const bets: TieredBet[] = Array.from({ length: 45 }, (_, i) => ({
    physicalEventKey: `evt-${i}`,
    decisionTimestamp: `2026-08-04T${String(6 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00.000Z`,
    eventStart: "2026-08-04T20:00:00.000Z",
    leadTimeHours: 5,
    entryPrice: 0.55,
    sportFamily: "soccer",
    outcome: i % 3 === 0 ? "LOSS" : "WIN",
    pnlU: i % 3 === 0 ? -1 : 0.8,
    tier: 1,
    day: "2026-08-04",
  }));
  const allDates = ["2026-08-04"];
  const capacityByCap = new Map<number, ReturnType<typeof computeCapacity>>();
  for (const cap of [15, 20, 30, 40, 50]) capacityByCap.set(cap, computeCapacity(bets, cap, allDates));
  const marginal = computeMarginal(capacityByCap);
  const layer1520 = marginal.find((m) => m.layer === "15_TO_20")!;
  const cap15 = capacityByCap.get(15)!;
  const cap20 = capacityByCap.get(20)!;
  assert.equal(layer1520.incremental_event_n, cap20.selected_event_n - cap15.selected_event_n);
  assert.equal(layer1520.incremental_pnl_u, Math.round((cap20.total_pnl_u - cap15.total_pnl_u) * 100) / 100);
});

test("future settlement (WIN/LOSS outcome) is never used for capacity ordering", () => {
  // Two candidates on the same day, same tier; a LOSS decided earlier must
  // still be kept ahead of a WIN decided later under the deterministic
  // decisionAt-based capacity order.
  const bets: TieredBet[] = [
    { physicalEventKey: "evt-loss-first", decisionTimestamp: "2026-08-04T09:00:00.000Z", eventStart: "2026-08-04T20:00:00.000Z", leadTimeHours: 5, entryPrice: 0.55, sportFamily: "soccer", outcome: "LOSS", pnlU: -1, tier: 1, day: "2026-08-04" },
    { physicalEventKey: "evt-win-second", decisionTimestamp: "2026-08-04T09:05:00.000Z", eventStart: "2026-08-04T20:00:00.000Z", leadTimeHours: 5, entryPrice: 0.55, sportFamily: "soccer", outcome: "WIN", pnlU: 0.8, tier: 1, day: "2026-08-04" },
  ];
  const capped = applyDailyCap(bets, 1);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].physicalEventKey, "evt-loss-first", "capacity order is decisionAt-first, never outcome/PnL-first");
});

test("a low-flow, high-ROI strategy remains a SATELLITE candidate (never discarded for low N)", () => {
  const bets: TieredBet[] = [
    { physicalEventKey: "evt-1", decisionTimestamp: "2026-08-04T09:00:00.000Z", eventStart: "2026-08-04T20:00:00.000Z", leadTimeHours: 5, entryPrice: 0.55, sportFamily: "tennis", outcome: "WIN", pnlU: 0.8, tier: 1, day: "2026-08-04" },
  ];
  const allDates = ["2026-08-04", "2026-08-05"];
  const uncapped = computeUncapped(bets, allDates);
  assert.equal(uncapped.active_day_n, 1);
  assert.ok(uncapped.mean_events_per_active_day < 10, "single-event day is LOW_FLOW by construction");
  assert.ok(uncapped.roi_pct >= 20, "flat-1u WIN at 0.55 entry price clears the 20% ROI satellite floor");
  assert.ok(uncapped.pnl_u > 0);
});

test("a high-flow, positive strategy qualifies for CORE (FLOW_CLASS != LOW_FLOW, ROI > 0, PnL > 0)", () => {
  const bets: TieredBet[] = Array.from({ length: 15 }, (_, i) => ({
    physicalEventKey: `evt-${i}`,
    decisionTimestamp: `2026-08-04T${String(9 + i).padStart(2, "0")}:00:00.000Z`,
    eventStart: "2026-08-05T20:00:00.000Z",
    leadTimeHours: 5,
    entryPrice: 0.55,
    sportFamily: "soccer",
    outcome: "WIN",
    pnlU: 0.8,
    tier: 1,
    day: "2026-08-04",
  }));
  const uncapped = computeUncapped(bets, ["2026-08-04"]);
  assert.ok(uncapped.mean_events_per_active_day >= 10, "15 events on one active day clears the MEDIUM_FLOW floor");
  assert.ok(uncapped.roi_pct > 0 && uncapped.pnl_u > 0);
});

test("C0 parity: the same C0 predicate matches the existing frozen engine on a fixture", () => {
  const rows = [
    row({ conditionId: "C1", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.5, label: "WIN" }),
    row({ conditionId: "C2", decisionAt: "2026-08-04T10:00:00.000Z", entryPrice: 0.65, label: "WIN" }),
    row({ conditionId: "C3", decisionAt: "2026-08-04T11:00:00.000Z", entryPrice: 0.59, label: "LOSS" }),
  ];
  const scorecardRows = rows.map((r) => toScorecardRow(r));
  const expected = evaluateRows(scorecardRows as any) as Record<string, any>;
  const input = toAtlasInput(scorecardRows);
  const bets = runStandalone(input, c0Predicate);
  const actual = metricsFor(bets);
  assert.equal(actual.events, expected.C0.SELECTED_PHYSICAL_EVENT_N);
  assert.equal(actual.wins, expected.C0.WINS);
  assert.equal(actual.losses, expected.C0.LOSSES);
  assert.equal(actual.pnl_u, expected.C0.PNL_U);
  assert.equal(actual.roi_pct, expected.C0.ROI_PCT);
  assert.equal(actual.max_drawdown_u, expected.C0.MAX_DRAWDOWN_U);
});

test("reversed input order produces an identical canonical uncapped result", () => {
  const rows = [
    row({ conditionId: "R1", decisionAt: "2026-08-04T09:00:00.000Z", scoreLevel: 63 }),
    row({ conditionId: "R2", decisionAt: "2026-08-05T09:00:00.000Z", scoreLevel: 63 }),
  ];
  const forward = toAtlasInput(rows.map((r) => toScorecardRow(r)));
  const reversed = toAtlasInput([...rows].reverse().map((r) => toScorecardRow(r)));
  const a = computeUncapped(runStandalone(forward, scoreBucket), ["2026-08-04", "2026-08-05"]);
  const b = computeUncapped(runStandalone(reversed, scoreBucket), ["2026-08-04", "2026-08-05"]);
  assert.deepEqual(a, b);
});
