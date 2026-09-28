import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ODDS_BUCKETS,
  TIMING_BUCKETS,
  MARKET_BUCKET_IDS,
  inBucket,
  displayOdds,
  marketBucketOf,
  isOrdinaryHold,
  periodOfModelDate,
  buildStructuralCandidates,
  computeCell,
  buildOddsGrid,
  buildMarketStructureGrid,
  type StructuralCandidate,
} from "../../scripts/modeling/football-structural-authority";
import type { SourceRow, OverlayRecord } from "../../scripts/modeling/build-football-denominator-reconciliation";
import type { CorpusLabel } from "../../lib/modeling/research-corpus/rollingCorpus";

// ── odds bucket boundaries ──────────────────────────────────────────────────
test("odds buckets match the exact founder-facing decimal-odds bucket list", () => {
  assert.deepEqual(
    ODDS_BUCKETS.map((b) => b.label),
    ["<1.35", "1.35-1.50", "1.50-1.75", "1.75-2.00", "2.00-2.25", "2.25-2.50", "2.50-3.00", "3.00-4.00", "4.00-5.00", "5.00+"],
  );
});

test("odds bucket boundary at exactly 1.75 falls in [1.75,2.00), not [1.50,1.75)", () => {
  const b175 = ODDS_BUCKETS.find((b) => b.id === "1_75_2_00")!;
  const b150 = ODDS_BUCKETS.find((b) => b.id === "1_50_1_75")!;
  assert.equal(inBucket(1.75, b175), true);
  assert.equal(inBucket(1.75, b150), false);
});

test("odds bucket boundary at exactly 2.00 falls in [2.00,2.25), not [1.75,2.00)", () => {
  const b200 = ODDS_BUCKETS.find((b) => b.id === "2_00_2_25")!;
  const b175 = ODDS_BUCKETS.find((b) => b.id === "1_75_2_00")!;
  assert.equal(inBucket(2.0, b200), true);
  assert.equal(inBucket(2.0, b175), false);
});

test("5.00+ bucket is unbounded above and includes exactly 5.00", () => {
  const top = ODDS_BUCKETS.find((b) => b.id === "GE_5_00")!;
  assert.equal(inBucket(5.0, top), true);
  assert.equal(inBucket(999, top), true);
  const prev = ODDS_BUCKETS.find((b) => b.id === "4_00_5_00")!;
  assert.equal(inBucket(5.0, prev), false);
});

test("DISPLAY_ODDS = 1 / entry_price", () => {
  assert.equal(displayOdds(0.5), 2);
  assert.ok(Math.abs(displayOdds(0.8) - 1.25) < 1e-10);
});

// ── timing bucket boundaries ────────────────────────────────────────────────
test("timing buckets match the exact founder-facing lead-time bucket list", () => {
  assert.deepEqual(
    TIMING_BUCKETS.map((b) => b.label),
    ["<1h", "1-3h", "3-6h", "6-12h", "12-24h", ">=24h"],
  );
});

test("timing bucket boundary at exactly 1h falls in [1,3), not <1h", () => {
  const lt1 = TIMING_BUCKETS.find((b) => b.id === "LT_1H")!;
  const b13 = TIMING_BUCKETS.find((b) => b.id === "1_3H")!;
  assert.equal(inBucket(1, lt1), false);
  assert.equal(inBucket(1, b13), true);
});

test("timing bucket boundary at exactly 24h falls in >=24h, not 12-24h", () => {
  const b1224 = TIMING_BUCKETS.find((b) => b.id === "12_24H")!;
  const ge24 = TIMING_BUCKETS.find((b) => b.id === "GE_24H")!;
  assert.equal(inBucket(24, b1224), false);
  assert.equal(inBucket(24, ge24), true);
});

// ── market structure classification / Exact Score exclusion ───────────────
test("market structure classifies the six requested buckets exactly", () => {
  assert.equal(marketBucketOf("moneyline"), "moneyline");
  assert.equal(marketBucketOf("totals"), "totals");
  assert.equal(marketBucketOf("spreads"), "spreads");
  assert.equal(marketBucketOf("total_corners"), "total_corners");
  assert.equal(marketBucketOf("soccer_exact_score"), "soccer_exact_score");
  assert.equal(marketBucketOf("soccer_first_to_score"), "other_structured");
  assert.deepEqual(MARKET_BUCKET_IDS, ["moneyline", "totals", "spreads", "total_corners", "other_structured", "soccer_exact_score"]);
});

test("soccer_exact_score is kept outside ordinary HOLD, everything else stays inside", () => {
  assert.equal(isOrdinaryHold("soccer_exact_score"), false);
  assert.equal(isOrdinaryHold("moneyline"), true);
  assert.equal(isOrdinaryHold(null), true);
});

// ── period boundary correctness ─────────────────────────────────────────────
test("period boundaries assign AUG / SEP_1_12 / SEP_13_24 exactly at the calendar edges", () => {
  assert.equal(periodOfModelDate("2026-08-04"), "AUG");
  assert.equal(periodOfModelDate("2026-08-31"), "AUG");
  assert.equal(periodOfModelDate("2026-09-01"), "SEP_1_12");
  assert.equal(periodOfModelDate("2026-09-12"), "SEP_1_12");
  assert.equal(periodOfModelDate("2026-09-13"), "SEP_13_24");
  assert.equal(periodOfModelDate("2026-09-24"), "SEP_13_24");
});

// ── fixture builders ─────────────────────────────────────────────────────────
function sourceRow(overrides: Partial<SourceRow> & { canonical_row?: Record<string, unknown> } = {}): SourceRow {
  return {
    model_date: "2026-08-05",
    population_id: "POP_A",
    condition_id: "COND_1",
    selected_token_id: "TOK_1",
    decision_at: "2026-08-05T10:00:00.000Z",
    provider_event_id: "EVT_1",
    sport_family: "soccer",
    settlement_label: "WIN",
    entry_price_num: 0.55,
    canonical_row: { sportFamily: "soccer", eventStart: "2026-08-05T18:00:00.000Z", marketTypeRaw: "moneyline" },
    ...overrides,
  };
}

function overlayFor(r: SourceRow, reconciledSportFamily: string | null, reconciledMarketType: string | null = "moneyline"): OverlayRecord {
  return {
    model_date: r.model_date,
    population_id: r.population_id,
    provider_event_id: r.provider_event_id,
    condition_id: r.condition_id,
    selected_token_id: r.selected_token_id,
    decision_at: r.decision_at,
    source_sport_family: r.sport_family,
    reconciled_sport_family: reconciledSportFamily,
    sport_reconciliation_basis: reconciledSportFamily === "soccer" ? "SPORT_EXPLICIT" : "SPORT_UNRESOLVED",
    provider_sport_code: null,
    source_market_type: reconciledMarketType,
    reconciled_market_type: reconciledMarketType,
    market_type_source: "MARKET_TYPE_CANONICAL",
    display_odds_available: true,
    settlement_available: true,
    lead_time_available: false,
    score_level_available: false,
    data_coverage_available: false,
    volume_available: false,
  };
}

const EMPTY_SERIES = { observationCount: 0, firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, delta: null };

// ── unresolved sport fails closed ───────────────────────────────────────────
test("unresolved sport: a row whose overlay sport is not resolved to soccer is excluded", () => {
  const r = sourceRow({ condition_id: "C_UNRESOLVED", canonical_row: { eventStart: "2026-08-05T18:00:00.000Z" } });
  const overlay = overlayFor(r, null);
  const { candidates } = buildStructuralCandidates([r], [overlay]);
  assert.equal(candidates.length, 0);
});

test("unresolved sport: a row whose overlay sport resolved to a different explicit sport is excluded", () => {
  const r = sourceRow({ condition_id: "C_OTHER_SPORT", sport_family: "tennis", canonical_row: { sportFamily: "tennis", eventStart: "2026-08-05T18:00:00.000Z" } });
  const overlay = overlayFor(r, "tennis");
  const { candidates } = buildStructuralCandidates([r], [overlay]);
  assert.equal(candidates.length, 0);
});

test("unresolved sport: a row whose overlay sport resolved to soccer is included", () => {
  const r = sourceRow();
  const overlay = overlayFor(r, "soccer");
  const { candidates } = buildStructuralCandidates([r], [overlay]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sportFamily, "soccer");
});

// ── selection-before-settlement / OPEN holds the slot / one bet per event per cell ─
function candidate(overrides: Partial<StructuralCandidate> = {}): StructuralCandidate {
  return {
    physicalEventKey: "EVT_1",
    decisionTimestamp: "2026-08-05T08:00:00.000Z",
    eventStart: "2026-08-05T18:00:00.000Z",
    entryPrice: 0.5, // DISPLAY_ODDS = 1/0.5 = 2.00 -> bucket 2_00_2_25
    sportFamily: "soccer",
    ref: "COND_1",
    candidateRef: "TOK_1",
    scoreLevel: null,
    score: EMPTY_SERIES,
    selectedPrice: EMPTY_SERIES,
    volumeUsd: null,
    rowLeadTimeHours: null,
    marketTypeRaw: "moneyline",
    candidateIdentity: "COND_1::TOK_1::2026-08-05T08:00:00.000Z",
    period: "AUG",
    modelDate: "2026-08-05",
    ...overrides,
  };
}

test("one bet max per physical event per tested cell, even with two candidate rows for the same event", () => {
  const a = candidate({ candidateIdentity: "A", candidateRef: "TOK_1", decisionTimestamp: "2026-08-05T08:00:00.000Z" });
  const b = candidate({ candidateIdentity: "B", candidateRef: "TOK_2", decisionTimestamp: "2026-08-05T09:00:00.000Z" });
  const settlement = new Map<string, CorpusLabel>([
    ["A", "WIN"],
    ["B", "LOSS"],
  ]);
  const bucket = ODDS_BUCKETS.find((x) => x.id === "2_00_2_25")!;
  const m = computeCell([a, b], settlement, (e) => isOrdinaryHold(e.marketTypeRaw) && inBucket(displayOdds(e.entryPrice), bucket));
  assert.equal(m.N_SELECTED, 1);
  assert.equal(m.WINS + m.LOSSES, 1);
  assert.equal(m.WINS, 1); // chronological-first qualifying row (A) wins
});

test("selection-before-settlement: the chronologically-first row is selected regardless of its own settlement outcome", () => {
  // B is chronologically first but LOSES; A is second but WINS. Selection must still pick B.
  const a = candidate({ candidateIdentity: "A", decisionTimestamp: "2026-08-05T09:00:00.000Z" });
  const b = candidate({ candidateIdentity: "B", decisionTimestamp: "2026-08-05T08:00:00.000Z" });
  const settlement = new Map<string, CorpusLabel>([
    ["A", "WIN"],
    ["B", "LOSS"],
  ]);
  const bucket = ODDS_BUCKETS.find((x) => x.id === "2_00_2_25")!;
  const m = computeCell([a, b], settlement, (e) => isOrdinaryHold(e.marketTypeRaw) && inBucket(displayOdds(e.entryPrice), bucket));
  assert.equal(m.N_SELECTED, 1);
  assert.equal(m.LOSSES, 1); // B, the chronologically-first row, was selected and it lost
  assert.equal(m.WINS, 0);
});

test("OPEN keeps the event's slot: selected and counted in N_OPEN, no settled PnL, never frees the event for a later candidate", () => {
  const a = candidate({ candidateIdentity: "A", decisionTimestamp: "2026-08-05T08:00:00.000Z" });
  const b = candidate({ candidateIdentity: "B", decisionTimestamp: "2026-08-05T09:00:00.000Z" });
  const settlement = new Map<string, CorpusLabel>([
    ["A", "OPEN"],
    ["B", "WIN"],
  ]);
  const bucket = ODDS_BUCKETS.find((x) => x.id === "2_00_2_25")!;
  const m = computeCell([a, b], settlement, (e) => isOrdinaryHold(e.marketTypeRaw) && inBucket(displayOdds(e.entryPrice), bucket));
  assert.equal(m.N_SELECTED, 1);
  assert.equal(m.N_OPEN, 1);
  assert.equal(m.N_SETTLED, 0);
  assert.equal(m.WINS, 0);
  assert.equal(m.LOSSES, 0);
  assert.equal(m.REFERENCE_PNL_U, 0);
});

// ── referenceEconomics reused, not reimplemented ────────────────────────────
test("REFERENCE_PNL_U matches the frozen settlement rule exactly (flat 1u, WIN = 1/p - 1)", () => {
  const c = candidate({ candidateIdentity: "X", physicalEventKey: "EVT_X", entryPrice: 0.5 });
  const settlement = new Map<string, CorpusLabel>([["X", "WIN"]]);
  const bucket = ODDS_BUCKETS.find((b) => b.id === "2_00_2_25")!;
  const m = computeCell([c], settlement, (e) => inBucket(displayOdds(e.entryPrice), bucket));
  assert.equal(m.REFERENCE_PNL_U, 1 / 0.5 - 1); // == 1
});

test("REFERENCE_PNL_U for a LOSS is exactly -1 (flat 1u stake)", () => {
  const c = candidate({ candidateIdentity: "Y", physicalEventKey: "EVT_Y", entryPrice: 0.5 });
  const settlement = new Map<string, CorpusLabel>([["Y", "LOSS"]]);
  const bucket = ODDS_BUCKETS.find((b) => b.id === "2_00_2_25")!;
  const m = computeCell([c], settlement, (e) => inBucket(displayOdds(e.entryPrice), bucket));
  assert.equal(m.REFERENCE_PNL_U, -1);
});

// ── grid-level Exact Score exclusion ────────────────────────────────────────
test("a soccer_exact_score candidate is excluded from every odds-bucket cell, but reported in the market-structure grid", () => {
  const r = sourceRow({ canonical_row: { eventStart: "2026-08-05T18:00:00.000Z", marketTypeRaw: "soccer_exact_score" } });
  const overlay = overlayFor(r, "soccer", "soccer_exact_score");
  const { candidates, settlementByCandidateIdentity } = buildStructuralCandidates([r], [overlay]);
  const grid = buildOddsGrid(candidates, settlementByCandidateIdentity);
  const totalSelected = ODDS_BUCKETS.reduce((sum, b) => sum + grid.AUG[b.id].N_SELECTED, 0);
  assert.equal(totalSelected, 0);

  const marketGrid = buildMarketStructureGrid(candidates, settlementByCandidateIdentity);
  assert.equal(marketGrid.AUG.soccer_exact_score.N_SELECTED, 1);
});

// ── artifact determinism at the pure-function layer ─────────────────────────
test("buildOddsGrid is deterministic: identical JSON across repeat runs and insensitive to input row order", () => {
  const r1 = sourceRow({ condition_id: "C1", decision_at: "2026-08-05T08:00:00.000Z" });
  const r2 = sourceRow({ condition_id: "C2", decision_at: "2026-08-05T09:00:00.000Z", entry_price_num: 0.45 });
  const ov1 = overlayFor(r1, "soccer");
  const ov2 = overlayFor(r2, "soccer");

  const { candidates: candA, settlementByCandidateIdentity: setA } = buildStructuralCandidates([r1, r2], [ov1, ov2]);
  const { candidates: candB, settlementByCandidateIdentity: setB } = buildStructuralCandidates([r2, r1], [ov2, ov1]);

  const gridA = buildOddsGrid(candA, setA);
  const gridB = buildOddsGrid(candB, setB);
  assert.equal(JSON.stringify(gridA), JSON.stringify(gridB));

  const gridA2 = buildOddsGrid(candA, setA);
  assert.equal(JSON.stringify(gridA), JSON.stringify(gridA2));
});
