import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FROZEN_MODELS,
  FROZEN_MODEL_IDS,
  MODEL_RESEARCH_ENGINE_VERSION,
  evaluateEvent,
  runModel,
  runResearchEngine,
  settleBetU,
  aggregateMetrics,
  sortChronologically,
  maxDrawdownU,
  GOLDEN_REFERENCE_CONTRACT_V1,
  CONFORMANCE_MATRIX,
  HISTORICALLY_RELEVANT_CANONICAL_SPORTS,
  NEXT_SEMANTIC_TRANSITION,
  type ResearchEngineInputEvent,
} from "../../../lib/modeling/research-engine";

const EVENT_START = "2026-06-01T18:00:00.000Z";

function row(overrides: Partial<ResearchEngineInputEvent> & { leadTimeHours?: number } = {}) {
  const leadTimeHours = overrides.leadTimeHours ?? 1;
  const decisionMs = Date.parse(EVENT_START) - leadTimeHours * 3_600_000;
  const base: ResearchEngineInputEvent = {
    physicalEventKey: overrides.physicalEventKey ?? "evt-1",
    decisionTimestamp: overrides.decisionTimestamp ?? new Date(decisionMs).toISOString(),
    eventStart: overrides.eventStart ?? EVENT_START,
    entryPrice: overrides.entryPrice ?? 0.55,
    sportFamily: overrides.sportFamily ?? "soccer",
    outcome: overrides.outcome ?? "WIN",
    ...(overrides.ref === undefined ? {} : { ref: overrides.ref }),
  };
  return base;
}

const evaluated = (o: Parameters<typeof row>[0] = {}) => evaluateEvent(row(o));

// ---------------------------------------------------------------------------
// Price band boundary conditions
// ---------------------------------------------------------------------------
test("price 0.50 passes the price band (C0)", () => {
  assert.equal(FROZEN_MODELS.C0.predicate(evaluated({ entryPrice: 0.5 })), true);
});

test("price below 0.50 fails the price band (C0)", () => {
  assert.equal(FROZEN_MODELS.C0.predicate(evaluated({ entryPrice: 0.4999 })), false);
});

test("price 0.60 fails the price band (C0)", () => {
  assert.equal(FROZEN_MODELS.C0.predicate(evaluated({ entryPrice: 0.6 })), false);
});

// ---------------------------------------------------------------------------
// C4 exact rule
// ---------------------------------------------------------------------------
test("soccer passes C4 with lead < 24h", () => {
  assert.equal(
    FROZEN_MODELS.C4.predicate(evaluated({ sportFamily: "soccer", leadTimeHours: 3 })),
    true,
  );
});

test("non-soccer fails C4 below 24h", () => {
  assert.equal(
    FROZEN_MODELS.C4.predicate(evaluated({ sportFamily: "basketball", leadTimeHours: 23.99 })),
    false,
  );
});

test("non-soccer passes C4 at exactly 24h", () => {
  assert.equal(
    FROZEN_MODELS.C4.predicate(evaluated({ sportFamily: "basketball", leadTimeHours: 24 })),
    true,
  );
});

// ---------------------------------------------------------------------------
// C1 / C5 sport-family rules
// ---------------------------------------------------------------------------
test("C1 accepts soccer only", () => {
  assert.equal(FROZEN_MODELS.C1.predicate(evaluated({ sportFamily: "soccer" })), true);
  assert.equal(FROZEN_MODELS.C1.predicate(evaluated({ sportFamily: "tennis" })), false);
  assert.equal(FROZEN_MODELS.C1.predicate(evaluated({ sportFamily: "table-tennis" })), false);
});

test("C5 excludes table-tennis and accepts everything else in band", () => {
  assert.equal(
    FROZEN_MODELS.C5.predicate(evaluated({ sportFamily: "table-tennis", leadTimeHours: 48 })),
    false,
  );
  assert.equal(FROZEN_MODELS.C5.predicate(evaluated({ sportFamily: "tennis" })), true);
});

// ---------------------------------------------------------------------------
// Physical-event exposure invariant
// ---------------------------------------------------------------------------
test("one physical-event key cannot create duplicate exposure", () => {
  const input = [
    row({ physicalEventKey: "match-x", ref: "a", entryPrice: 0.55, leadTimeHours: 5 }),
    row({ physicalEventKey: "match-x", ref: "b", entryPrice: 0.52, leadTimeHours: 10 }),
    row({ physicalEventKey: "match-y", ref: "c", entryPrice: 0.53, leadTimeHours: 5 }),
  ];
  const result = runModel("C0", input);
  assert.equal(result.INPUT_EVENT_N, 3);
  assert.equal(result.SELECTED_PHYSICAL_EVENT_N, 2);
  assert.deepEqual([...result.selectedMembership].sort(), ["match-x", "match-y"]);
  // earliest decision for match-x is ref "b" (lead 10h => earlier decisionTimestamp)
  const picked = result.selectedBets.find((b) => b.physicalEventKey === "match-x");
  assert.equal(picked?.ref, "b");
});

// ---------------------------------------------------------------------------
// Settlement formulas
// ---------------------------------------------------------------------------
test("settlement WIN/LOSS formulas", () => {
  assert.equal(settleBetU("WIN", 0.5), 1 / 0.5 - 1);
  assert.equal(settleBetU("WIN", 0.4), 1 / 0.4 - 1);
  assert.equal(settleBetU("LOSS", 0.5), -1);
  assert.equal(settleBetU("LOSS", 0.59), -1);
  assert.throws(() => settleBetU("WIN", 0), RangeError);
  assert.throws(() => settleBetU("WIN", 1), RangeError);
});

// ---------------------------------------------------------------------------
// Deterministic ordering + MaxDD
// ---------------------------------------------------------------------------
test("stable chronological ordering is independent of input order", () => {
  const a = row({ physicalEventKey: "e1", leadTimeHours: 30, entryPrice: 0.55 });
  const b = row({ physicalEventKey: "e2", leadTimeHours: 20, entryPrice: 0.55 });
  const c = row({ physicalEventKey: "e3", leadTimeHours: 10, entryPrice: 0.55 });
  const forward = runModel("C0", [a, b, c]).selectedMembership;
  const shuffled = runModel("C0", [c, a, b]).selectedMembership;
  assert.deepEqual(forward, ["e1", "e2", "e3"]); // larger lead => earlier decision => first
  assert.deepEqual(shuffled, forward);
});

test("deterministic chronological MaxDD", () => {
  const bets = [
    { outcome: "LOSS" as const, pnlU: -1 },
    { outcome: "WIN" as const, pnlU: 1 },
    { outcome: "LOSS" as const, pnlU: -1 },
    { outcome: "LOSS" as const, pnlU: -1 },
    { outcome: "WIN" as const, pnlU: 1 },
  ].map((b, i) => ({
    physicalEventKey: `k${i}`,
    decisionTimestamp: EVENT_START,
    eventStart: EVENT_START,
    leadTimeHours: 1,
    entryPrice: 0.5,
    sportFamily: "soccer",
    ...b,
  }));
  // running: -1, 0, -1, -2, -1 ; peak: 0,0,0,0,0 ; min drawdown = -2
  assert.equal(maxDrawdownU(bets), -2);
  assert.equal(aggregateMetrics(bets).MAX_DRAWDOWN_U, -2);
});

test("sortChronologically does not mutate its input", () => {
  const input = [evaluated({ physicalEventKey: "z", leadTimeHours: 1 }), evaluated({ physicalEventKey: "a", leadTimeHours: 99 })];
  const snapshot = input.map((e) => e.physicalEventKey);
  sortChronologically(input);
  assert.deepEqual(input.map((e) => e.physicalEventKey), snapshot);
});

// ---------------------------------------------------------------------------
// Structural membership relations
// ---------------------------------------------------------------------------
test("C1 predicate implies C4 across the conformance matrix", () => {
  for (const e of CONFORMANCE_MATRIX) {
    if (FROZEN_MODELS.C1.predicate(e)) {
      assert.equal(FROZEN_MODELS.C4.predicate(e), true, `C1 selected ${e.ref} but C4 did not`);
    }
  }
});

test("C4 predicate implies C5 for historically relevant sports under the documented assumption", () => {
  // Respects HISTORICAL_MEMBERSHIP_ASSUMPTIONS: table-tennis never carries lead >= 24h.
  for (const sportFamily of HISTORICALLY_RELEVANT_CANONICAL_SPORTS) {
    for (const entryPrice of [0.5, 0.55, 0.5999]) {
      for (const leadTimeHours of [0, 12, 23.9, sportFamily === "table-tennis" ? 12 : 24, sportFamily === "table-tennis" ? 20 : 72]) {
        const e = evaluated({ sportFamily, entryPrice, leadTimeHours, ref: `${sportFamily}-${leadTimeHours}` });
        if (FROZEN_MODELS.C4.predicate(e)) {
          assert.equal(
            FROZEN_MODELS.C5.predicate(e),
            true,
            `C4 selected ${sportFamily}@lead${leadTimeHours} but C5 did not`,
          );
        }
      }
    }
  }
});

test("the predicate-level C4=>C5 exception is documented, not silently assumed away", () => {
  const exception = GOLDEN_REFERENCE_CONTRACT_V1.structuralContract.knownPredicateLevelException;
  assert.equal(exception.relation, "C4 => C5");
  assert.equal(exception.historicallyObserved, false);
  assert.equal(exception.reproofDeferredTo, "CANONICAL_MODELING_DATASET_V1");
  // and it is a real predicate-level exception:
  const tt = evaluated({ sportFamily: "table-tennis", entryPrice: 0.55, leadTimeHours: 48 });
  assert.equal(FROZEN_MODELS.C4.predicate(tt), true);
  assert.equal(FROZEN_MODELS.C5.predicate(tt), false);
});

// ---------------------------------------------------------------------------
// Golden reference contract
// ---------------------------------------------------------------------------
test("golden reference contract is internally consistent", () => {
  for (const [id, m] of Object.entries(GOLDEN_REFERENCE_CONTRACT_V1.models)) {
    assert.equal(m.W + m.L, m.N, `${id}: W + L != N`);
    const impliedRoi = (m.PNL_U / m.N) * 100;
    assert.ok(Math.abs(impliedRoi - m.ROI_PCT) < 0.01, `${id}: ROI_PCT inconsistent with PNL_U/N`);
    assert.ok(m.MAX_DRAWDOWN_U <= 0, `${id}: MaxDD must be <= 0`);
  }
});

test("golden reference contract does not claim event-level regeneration in this mission", () => {
  assert.equal(GOLDEN_REFERENCE_CONTRACT_V1.regeneratedFromEventLevelDataInThisMission, false);
  assert.equal(GOLDEN_REFERENCE_CONTRACT_V1.provenance, "HISTORICAL_ACCEPTED_AGGREGATE");
});

// ---------------------------------------------------------------------------
// Engine surface / versioning
// ---------------------------------------------------------------------------
test("every frozen model exposes the required versioned metadata", () => {
  for (const id of FROZEN_MODEL_IDS) {
    const m = FROZEN_MODELS[id];
    assert.equal(m.MODEL_ID, id);
    assert.equal(m.MODEL_VERSION, MODEL_RESEARCH_ENGINE_VERSION);
    assert.ok(m.ROLE.length > 0);
    assert.ok(m.predicateDescription.length > 0);
    assert.ok(m.timeSemantics.includes("lead_time_hours"));
    assert.ok(m.economicUnit.length > 0);
    assert.ok(m.stakeSemantics.includes("1u"));
    assert.equal(typeof m.predicate, "function");
  }
});

test("runResearchEngine('all') runs exactly C0/C1/C4/C5 with no LLM", () => {
  const input = CONFORMANCE_MATRIX.map((e) => ({
    physicalEventKey: e.physicalEventKey,
    decisionTimestamp: e.decisionTimestamp,
    eventStart: e.eventStart,
    entryPrice: e.entryPrice,
    sportFamily: e.sportFamily,
    outcome: e.outcome,
  }));
  const out = runResearchEngine(input);
  assert.deepEqual(Object.keys(out.models).sort(), ["C0", "C1", "C4", "C5"]);
  assert.equal(out.engineVersion, MODEL_RESEARCH_ENGINE_VERSION);
  // C1 subset C4 subset C5 on this fixture
  const c1 = new Set(out.models.C1.selectedMembership);
  const c4 = new Set(out.models.C4.selectedMembership);
  const c5 = new Set(out.models.C5.selectedMembership);
  for (const k of c1) assert.ok(c4.has(k), `C1 ${k} missing from C4`);
  for (const k of c4) assert.ok(c5.has(k), `C4 ${k} missing from C5`);
  assert.ok(c1.size < c4.size && c4.size < c5.size, "expected strict subsets on this fixture");
});

test("next semantic transition is CANONICAL_MODELING_DATASET_V1", () => {
  assert.equal(NEXT_SEMANTIC_TRANSITION, "CANONICAL_MODELING_DATASET_V1");
});
