import { test } from "node:test";
import assert from "node:assert/strict";

import type { RollingCompactRow } from "../../lib/modeling/research-corpus/rollingCorpus";
import { toDecisionTimeSelectionInput, toAtlasInput } from "../../scripts/modeling/factor-atlas";
import {
  runStandaloneStrict,
  runPortfolioStrict,
  runStandalone,
  applyDailyCap,
  partialMetricsFor,
  PORTFOLIOS,
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

// Minimal ScorecardReadyRow-shaped adapter carrying only the fields
// toAtlasInput()/toDecisionTimeSelectionInput() read.
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

test("FIX 1 FOCUSED REGRESSION: settlement is not present on the candidate object a predicate receives", () => {
  // Type-level: DecisionTimeCandidate has no `labelAsOf`/`outcome` field to
  // read in the first place (see factor-atlas.ts). Runtime: assert directly
  // on the object instance passed into the predicate that neither key exists.
  const rows = [row({ conditionId: "K1", providerEventId: "evt-key", decisionAt: "2026-08-04T09:00:00.000Z", label: "OPEN" })];
  const { candidates } = toDecisionTimeSelectionInput(rows.map((r) => toScorecardRow(r)));
  let sawCandidate = false;
  runStandaloneStrict(candidates, (e) => {
    sawCandidate = true;
    assert.equal("labelAsOf" in e, false, "labelAsOf must not exist on the predicate's typed input object");
    assert.equal("outcome" in e, false, "outcome must not exist on the predicate's typed input object");
    return c0Predicate(e);
  });
  assert.equal(sawCandidate, true, "the predicate must actually have been invoked for this assertion to be meaningful");
});

test("FOCUSED REGRESSION: chronologically-first OPEN candidate must be selected over a later WIN candidate", () => {
  // Same physicalEventKey, both candidate rows qualify C0. The FIRST
  // (chronologically) is still OPEN at decision time; the SECOND has since
  // settled WIN. Selection-before-settlement MUST choose the first
  // (OPEN) row — settlement availability must never influence selection.
  const rows = [
    row({ conditionId: "O1", providerEventId: "evt-open-first", decisionAt: "2026-08-04T09:00:00.000Z", label: "OPEN" }),
    row({ conditionId: "O2", providerEventId: "evt-open-first", decisionAt: "2026-08-04T09:05:00.000Z", label: "WIN" }),
  ];
  const { candidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rows.map((r) => toScorecardRow(r)));
  const selected = runStandaloneStrict(candidates, c0Predicate);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].candidateRef, "tok", "identity check only distinguishes by conditionId (ref) here");
  assert.equal(selected[0].decisionTimestamp, "2026-08-04T09:00:00.000Z", "the chronologically-first qualifying row (OPEN) must win");
  assert.equal(settlementByCandidateIdentity.get(selected[0].candidateIdentity), "OPEN", "settlement is read from the SEPARATE lookup, AFTER selection, and it is OPEN here");
});

test("FOCUSED REGRESSION: changing the winning candidate's settlement label does not change which candidate is selected", () => {
  const baseRows = (label: "OPEN" | "WIN") => [
    row({ conditionId: "L1", providerEventId: "evt-label-stable", decisionAt: "2026-08-04T09:00:00.000Z", label }),
    row({ conditionId: "L2", providerEventId: "evt-label-stable", decisionAt: "2026-08-04T09:05:00.000Z", label: "WIN" }),
  ];
  const openInput = toDecisionTimeSelectionInput(baseRows("OPEN").map((r) => toScorecardRow(r)));
  const winInput = toDecisionTimeSelectionInput(baseRows("WIN").map((r) => toScorecardRow(r)));
  const openCase = runStandaloneStrict(openInput.candidates, c0Predicate);
  const winCase = runStandaloneStrict(winInput.candidates, c0Predicate);
  assert.equal(openCase.length, 1);
  assert.equal(winCase.length, 1);
  assert.equal(openCase[0].decisionTimestamp, winCase[0].decisionTimestamp, "same candidate (by decisionTimestamp/ref) selected regardless of its settlement label");
  assert.equal(openInput.settlementByCandidateIdentity.get(openCase[0].candidateIdentity), "OPEN");
  assert.equal(winInput.settlementByCandidateIdentity.get(winCase[0].candidateIdentity), "WIN");
});

test("OPEN/nonterminal candidates still occupy their selected AND cap slot — never replaced by a later-settled candidate", () => {
  const rows = [
    row({ conditionId: "P1", providerEventId: "evt-p1", decisionAt: "2026-08-04T09:00:00.000Z", label: "OPEN" }),
    row({ conditionId: "P2", providerEventId: "evt-p2", decisionAt: "2026-08-04T09:01:00.000Z", label: "WIN" }),
    row({ conditionId: "P3", providerEventId: "evt-p3", decisionAt: "2026-08-04T09:02:00.000Z", label: "LOSS" }),
    row({ conditionId: "P4", providerEventId: "evt-p4", decisionAt: "2026-08-04T09:03:00.000Z", label: "VOID" }),
  ];
  const { candidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rows.map((r) => toScorecardRow(r)));
  const selected = runStandaloneStrict(candidates, c0Predicate);
  const capped = applyDailyCap(selected, 50);
  assert.equal(capped.length, 4, "cap never drops an OPEN/nonterminal candidate that qualified and fits under the cap");
  const settlement = partialMetricsFor(capped, settlementByCandidateIdentity);
  assert.equal(settlement.SELECTED_N, 4);
  assert.equal(settlement.SETTLED_N, 2);
  assert.equal(settlement.OPEN_N, 1);
  assert.equal(settlement.OTHER_NONTERMINAL_N, 1);
  assert.equal(settlement.SETTLED_N + settlement.OPEN_N + settlement.OTHER_NONTERMINAL_N, settlement.SELECTED_N, "exact reconciliation");
  assert.equal(settlement.SETTLEMENT_COVERAGE_PCT, 50);
});

test("PORTFOLIO_BROAD tiering: an OPEN chronologically-first row still wins its tier over a later WIN row", () => {
  const rows = [
    row({ conditionId: "T1", providerEventId: "evt-tier", decisionAt: "2026-08-04T09:00:00.000Z", entryPrice: 0.51, sportFamily: "tennis", label: "OPEN" }),
    row({ conditionId: "T2", providerEventId: "evt-tier", decisionAt: "2026-08-04T09:05:00.000Z", entryPrice: 0.51, sportFamily: "tennis", label: "WIN" }),
  ];
  const { candidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rows.map((r) => toScorecardRow(r)));
  const broad = PORTFOLIOS.find((p) => p.id === "PORTFOLIO_BROAD")!;
  const selected = runPortfolioStrict(candidates, broad.tiers as Parameters<typeof runPortfolioStrict>[1]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].tier, 1);
  assert.equal(selected[0].decisionTimestamp, "2026-08-04T09:00:00.000Z");
  assert.equal(settlementByCandidateIdentity.get(selected[0].candidateIdentity), "OPEN");
});

test("SELECTION PARITY: the fixed decision-time-only path and the legacy WIN/LOSS-first path select the SAME candidate when every candidate row is already settled", () => {
  // When there is no OPEN/nonterminal row in play, the fix must not change
  // anything for an already-fully-settled dataset (no false positives).
  const rows = [
    row({ conditionId: "S1", providerEventId: "evt-settled", decisionAt: "2026-08-04T09:00:00.000Z", scoreLevel: 40, label: "LOSS" }),
    row({ conditionId: "S2", providerEventId: "evt-settled", decisionAt: "2026-08-04T09:05:00.000Z", scoreLevel: 63, label: "WIN" }),
  ];
  const scorecardRows = rows.map((r) => toScorecardRow(r));
  const scoreBucket = (e: { entryPrice: number; scoreLevel: number | null }) => c0Predicate(e) && typeof e.scoreLevel === "number" && e.scoreLevel >= 63 && e.scoreLevel < 65;

  const legacyBets = runStandalone(toAtlasInput(scorecardRows), scoreBucket);
  const { candidates } = toDecisionTimeSelectionInput(scorecardRows);
  const fixedCandidates = runStandaloneStrict(candidates, scoreBucket);

  assert.equal(legacyBets.length, 1);
  assert.equal(fixedCandidates.length, 1);
  assert.equal(legacyBets[0].physicalEventKey, fixedCandidates[0].physicalEventKey);
  assert.equal(legacyBets[0].decisionTimestamp, fixedCandidates[0].decisionTimestamp);
});
