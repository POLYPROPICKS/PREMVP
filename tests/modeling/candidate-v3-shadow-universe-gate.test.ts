import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateCandidateV3UniverseGate,
  runCandidateV3Selector,
} from "../../scripts/modeling/candidate-v3-shadow-universe-gate";
import { produceFrozenModelV2ShadowDecisions } from "../../lib/modeling/frozenModelProducerV2Shadow";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";

const AS_OF = "2026-07-20T12:00:00.000Z";
const GAME_START = "2026-07-20T13:00:00.000Z";
const T90_BOUNDARY = "2026-07-20T11:30:00.000Z";

interface RowOptions {
  n?: number;
  diagnostics?: Record<string, unknown>;
  sport?: unknown;
  nestedMarketType?: unknown;
  flatMarketType?: unknown;
  overrides?: Partial<ExportRow>;
}

// Default: soccer + nested "Moneyline" market type, eligible for every producer gate.
function row(options: RowOptions = {}): ExportRow {
  const n = options.n ?? 1;
  const diagnostics: Record<string, unknown> = {
    gameStartIso: GAME_START,
    providerSportFamily: "sport" in options ? options.sport : "soccer",
    ...options.diagnostics,
  };
  const nested = "nestedMarketType" in options ? options.nestedMarketType : "Moneyline";
  if (nested !== undefined) diagnostics.researchContext = { marketType: nested };
  if (options.flatMarketType !== undefined) diagnostics.marketType = options.flatMarketType;
  return {
    condition_id: `cond-${n}`,
    selected_token_id: `tok-${n}`,
    selected_outcome: "TEAM_A",
    score: 70,
    entry_price_num: 0.4,
    created_at: T90_BOUNDARY,
    event_slug: `soccer-team-a-vs-team-b-${n}`,
    diagnostics,
    ...options.overrides,
  };
}

const ids = (rows: readonly ExportRow[]) =>
  runCandidateV3Selector(rows, AS_OF).acceptedDecisions.map((d) => d.decisionId).sort();

test("1. soccer + moneyline is admitted to the producer and accepted", () => {
  const gate = evaluateCandidateV3UniverseGate(row());
  assert.equal(gate.allowed, true);
  assert.equal(gate.reason_code, "ALLOWED");
  assert.equal(gate.normalized_sport_family, "soccer");
  assert.equal(gate.canonical_market_class, "allowed_fullmatch_moneyline");
  const result = runCandidateV3Selector([row()], AS_OF);
  assert.equal(result.acceptedDecisions.length, 1);
  assert.equal(result.universeAllowedCount, 1);
  assert.equal(result.universeRejectedCount, 0);
});

test("2. football alias normalizes to soccer and is admitted", () => {
  for (const alias of ["football", "Football", " FOOTBALL "]) {
    const gate = evaluateCandidateV3UniverseGate(row({ sport: alias }));
    assert.equal(gate.allowed, true, alias);
    assert.equal(gate.normalized_sport_family, "soccer");
  }
});

test("3. tennis / baseball / basketball fail closed before the producer", () => {
  for (const sport of ["tennis", "baseball", "basketball", "mlb", "nba"]) {
    const gate = evaluateCandidateV3UniverseGate(row({ sport }));
    assert.equal(gate.allowed, false, sport);
    assert.equal(gate.reason_code, "SPORT_FAMILY_NOT_SOCCER");
  }
  // Proves the gap the repair closes: the bare producer would accept a tennis row.
  assert.equal(produceFrozenModelV2ShadowDecisions([row({ sport: "tennis" })], AS_OF).acceptedDecisions.length, 1);
  const composed = runCandidateV3Selector([row({ sport: "tennis" })], AS_OF);
  assert.equal(composed.acceptedDecisions.length, 0);
  assert.equal(composed.universeGateRejectionCounts.SPORT_FAMILY_NOT_SOCCER, 1);
});

test("4. missing / blank / non-string providerSportFamily fails closed", () => {
  for (const sport of [undefined, null, "", "   ", 42, { family: "soccer" }]) {
    const gate = evaluateCandidateV3UniverseGate(row({ sport }));
    assert.equal(gate.allowed, false, String(sport));
    assert.equal(gate.reason_code, "SPORT_FAMILY_MISSING");
  }
  assert.equal(evaluateCandidateV3UniverseGate(row({ overrides: { diagnostics: undefined } })).reason_code, "SPORT_FAMILY_MISSING");
});

test("4b. sport is structured-only: title/slug text saying football is not used", () => {
  const gate = evaluateCandidateV3UniverseGate(
    row({ sport: undefined, overrides: { event_slug: "football-arsenal-vs-chelsea", market_slug: "epl-football-moneyline", sport: "football" } }),
  );
  assert.equal(gate.reason_code, "SPORT_FAMILY_MISSING");
});

test("5. marketType present only at diagnostics.researchContext.marketType is resolved", () => {
  const gate = evaluateCandidateV3UniverseGate(row({ nestedMarketType: "Moneyline", flatMarketType: undefined }));
  assert.equal(gate.allowed, true);
  assert.equal(gate.raw_market_type, "Moneyline");
});

test("6. fallback diagnostics.marketType works", () => {
  const gate = evaluateCandidateV3UniverseGate(row({ nestedMarketType: undefined, flatMarketType: "Spread" }));
  assert.equal(gate.allowed, true);
  assert.equal(gate.raw_market_type, "Spread");
  assert.equal(gate.canonical_market_class, "allowed_fullmatch_spread");
});

test("6b. precedence: nested surface wins and agreeing surfaces (case/space-insensitive) pass", () => {
  const gate = evaluateCandidateV3UniverseGate(row({ nestedMarketType: "  Moneyline ", flatMarketType: "moneyline" }));
  assert.equal(gate.allowed, true);
  assert.equal(gate.raw_market_type, "Moneyline");
});

test("7. missing market type fails closed (producer alone would admit it)", () => {
  for (const nested of [undefined, "", "  ", 7, null]) {
    const gate = evaluateCandidateV3UniverseGate(row({ nestedMarketType: nested }));
    assert.equal(gate.allowed, false, String(nested));
    assert.equal(gate.reason_code, "MARKET_TYPE_UNRESOLVED");
  }
  // Producer has no top-level market_type on this row, so it admits it: the gate is what closes it.
  assert.equal(produceFrozenModelV2ShadowDecisions([row({ nestedMarketType: undefined })], AS_OF).acceptedDecisions.length, 1);
  assert.equal(runCandidateV3Selector([row({ nestedMarketType: undefined })], AS_OF).acceptedDecisions.length, 0);
});

test("8. contradictory market-type surfaces fail closed", () => {
  const gate = evaluateCandidateV3UniverseGate(row({ nestedMarketType: "Moneyline", flatMarketType: "Spread" }));
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason_code, "MARKET_TYPE_CONTRADICTION");
});

test("9. canonical moneyline allowed", () => {
  for (const mt of ["Moneyline", "Match Winner", "1X2", "Draw No Bet"]) {
    assert.equal(evaluateCandidateV3UniverseGate(row({ nestedMarketType: mt })).canonical_market_class, "allowed_fullmatch_moneyline", mt);
    assert.equal(evaluateCandidateV3UniverseGate(row({ nestedMarketType: mt })).allowed, true, mt);
  }
});

test("10. canonical spread allowed", () => {
  for (const mt of ["Spread", "Asian Handicap"]) {
    assert.equal(evaluateCandidateV3UniverseGate(row({ nestedMarketType: mt })).canonical_market_class, "allowed_fullmatch_spread", mt);
    assert.equal(evaluateCandidateV3UniverseGate(row({ nestedMarketType: mt })).allowed, true, mt);
  }
});

test("11. canonical total allowed", () => {
  for (const mt of ["Total Goals", "Over/Under", "Totals"]) {
    assert.equal(evaluateCandidateV3UniverseGate(row({ nestedMarketType: mt })).canonical_market_class, "allowed_fullmatch_total", mt);
    assert.equal(evaluateCandidateV3UniverseGate(row({ nestedMarketType: mt })).allowed, true, mt);
  }
});

test("12. exact-score / corners / halftime / unknown (incl. literal BINARY) fail closed", () => {
  const cases: Array<[string, string]> = [
    ["Exact Score", "forbidden_exact_score"],
    ["Total Corners", "forbidden_corners"],
    ["Halftime Result", "forbidden_halftime"],
    ["1st Half Over/Under", "forbidden_halftime"],
    ["Anytime Goalscorer", "forbidden_goalscorer"],
    ["Mystery Market", "unknown"],
    ["BINARY", "unknown"],
  ];
  for (const [mt, cls] of cases) {
    const gate = evaluateCandidateV3UniverseGate(row({ nestedMarketType: mt }));
    assert.equal(gate.allowed, false, mt);
    assert.equal(gate.reason_code, "MARKET_CLASS_NOT_ALLOWED", mt);
    assert.equal(gate.canonical_market_class, cls, mt);
  }
});

test("13. reversed input yields identical selected identities", () => {
  const rows = [
    row({ n: 1 }),
    row({ n: 2, sport: "tennis" }),
    row({ n: 3, nestedMarketType: "Spread", overrides: { score: 90 } }),
    row({ n: 4, nestedMarketType: "Exact Score" }),
    row({ n: 5, nestedMarketType: undefined }),
    row({ n: 6, nestedMarketType: "Total Goals", overrides: { score: 80 } }),
  ];
  const forward = ids(rows);
  assert.equal(forward.length, 3);
  assert.deepEqual(ids([...rows].reverse()), forward);
  const a = runCandidateV3Selector(rows, AS_OF);
  const b = runCandidateV3Selector([...rows].reverse(), AS_OF);
  assert.deepEqual(a.acceptedDecisions, b.acceptedDecisions);
  assert.deepEqual(a.universeGateRejectionCounts, b.universeGateRejectionCounts);
  assert.deepEqual(a.acceptedMarketClassCounts, b.acceptedMarketClassCounts);
});

test("14. no outcome field participates", () => {
  const plain = row();
  const withOutcomes = row({ overrides: { winning_outcome: "TEAM_B", real_pnl_usd: -12.5, outcome: "LOSS", resolved_outcome: "TEAM_B" } });
  assert.deepEqual(evaluateCandidateV3UniverseGate(plain), evaluateCandidateV3UniverseGate(withOutcomes));
  // Outcome text that looks like a forbidden market or non-soccer sport must not influence admission.
  const decoy = row({ overrides: { winning_outcome: "Exact Score 2-1", outcome: "tennis", selected_outcome: "TEAM_A" } });
  assert.equal(evaluateCandidateV3UniverseGate(decoy).allowed, true);
  assert.deepEqual(
    runCandidateV3Selector([plain], AS_OF).acceptedDecisions,
    runCandidateV3Selector([withOutcomes], AS_OF).acceptedDecisions,
  );
});

test("15. at most one producer decision per physical event; accepted class counts and producer rejections reported", () => {
  const sameEvent = { event_slug: "soccer-arsenal-vs-chelsea" };
  const rows = [
    row({ n: 1, nestedMarketType: "Moneyline", overrides: { ...sameEvent, score: 70 } }),
    row({ n: 2, nestedMarketType: "Spread", overrides: { ...sameEvent, score: 85 } }),
    row({ n: 3, nestedMarketType: "Total Goals", overrides: { ...sameEvent, score: 75 } }),
    row({ n: 4, nestedMarketType: "Exact Score", overrides: { ...sameEvent, score: 99 } }),
    row({ n: 5, sport: "tennis", overrides: { ...sameEvent, score: 99 } }),
  ];
  const result = runCandidateV3Selector(rows, AS_OF);
  assert.equal(result.acceptedDecisions.length, 1);
  assert.equal(result.acceptedDecisions[0].score, 85);
  assert.deepEqual(result.acceptedMarketClassCounts, { allowed_fullmatch_spread: 1 });
  assert.deepEqual(result.universeGateRejectionCounts, { MARKET_CLASS_NOT_ALLOWED: 1, SPORT_FAMILY_NOT_SOCCER: 1 });
  assert.equal(result.inputCount, 5);
  assert.equal(result.universeAllowedCount, 3);
  // Producer rejections are reported against ORIGINAL input indices (rows 0 and 2 lost the tie-break).
  assert.deepEqual(
    result.producerRejections.map((r) => [r.index, r.reason]).sort((a, b) => Number(a[0]) - Number(b[0])),
    [[0, "DUPLICATE_EVENT_LOWER_RANK"], [2, "DUPLICATE_EVENT_LOWER_RANK"]],
  );
});

test("composition calls the existing producer: non-gate rules still apply to admitted rows", () => {
  const low = runCandidateV3Selector([row({ overrides: { score: 64 } })], AS_OF);
  assert.equal(low.acceptedDecisions.length, 0);
  assert.equal(low.producerRejections[0].reason, "SCORE_BELOW_65");
  const bare = produceFrozenModelV2ShadowDecisions([row()], AS_OF);
  assert.deepEqual(runCandidateV3Selector([row()], AS_OF).acceptedDecisions, bare.acceptedDecisions);
});
