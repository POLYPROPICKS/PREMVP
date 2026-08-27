// PRE-RESERVATION Contract A B2 EVENT-POLICY binding (roadmap step 3/5)
//   node --import tsx --test tests/contur3/contractAB2EventPolicy.preReservation.test.ts
//
// B2 is the selected pre-Reservation Contract A model. This suite pins the
// smallest pre-Reservation B2 event-policy binding compatible with the existing
// two-stage architecture (17:00 broad planning -> Contract A event decision ->
// Reservation -> mechanical Final Identity / Rebalance -> Queue):
//
//   1. persisted canonical Signal Score >= 65   -> passes; below -> rejects pre-Reservation
//   2. entry / signal price             >= 0.30 -> passes; below -> rejects pre-Reservation
//   3. eSports                                   -> rejects pre-Reservation
//   4. an event > 120 minutes from the 17:00 planning instant is NOT rejected
//      solely because of the old frozen B2 wall-clock <120m predicate
//   5. future / post-cutoff evidence cannot contaminate the Contract A model decision
//   6. a B2 rejection can never become Reservation input
//   7. the existing broad 17:00 planning horizon is unchanged
//   8. post-Reservation Final Identity / Rebalance does not re-evaluate B2 eligibility
//   9. the production population boundary stays v2-lite-growth-safe + canonical persisted score
//
// Every fixture uses fixed timestamps; no test reads the wall clock.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  produceContractAPlanningDecisions,
  produceContractAFinalIdentityDecision,
} from "../../lib/executor/contractADecisions";
import {
  B2_SCORE_THRESHOLD,
  B2_PRICE_FLOOR,
  evaluateContractAB2EventPolicy,
  resolveContractAAsOfSnapshots,
} from "../../lib/executor/contractAB2EventPolicy";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";

// 17:00 Minsk-equivalent planning instant. Kickoffs are hours later, so the
// old frozen B2 <120m predicate would reject the whole broad inventory.
const PLANNING_NOW_MS = Date.parse("2026-07-27T17:00:00.000Z");
const KICKOFF_FAR = "2026-07-27T21:00:00.000Z"; // T-240 — well beyond 120 minutes
const FINAL_NOW_MS = Date.parse("2026-07-27T19:50:00.000Z");

async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SnapshotDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(value?: any) {
      super(value ?? ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = SnapshotDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** A production-shaped, scored v2-lite-growth-safe generated_signal_pairs row. */
function row(overrides: {
  id?: string;
  conditionId?: string;
  tokenId?: string;
  eventSlug?: string;
  providerEventId?: string;
  gameStartIso?: string;
  confidence?: number | null;
  entryPrice?: number;
  createdAt?: string;
  sportFamily?: string;
  metricFormulaVersion?: string;
} = {}): Record<string, unknown> {
  const gameStartIso = overrides.gameStartIso ?? KICKOFF_FAR;
  const conditionId = overrides.conditionId ?? "cond-nyy-phi";
  const eventSlug = overrides.eventSlug ?? "mlb-nyy-phi-2026-07-27";
  const providerEventId = overrides.providerEventId ?? eventSlug;
  const sportFamily = overrides.sportFamily ?? "baseball";
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000001",
    condition_id: conditionId,
    selected_token_id: overrides.tokenId ?? "tok-nyy-phi-yankees",
    token_id: overrides.tokenId ?? "tok-nyy-phi-yankees",
    selected_outcome: "New York Yankees",
    // NOTE: production Contract A planning source rows (SIGNAL_SELECT_COLS) carry
    // signal_confidence_num as the ONLY score field — no `score` column — so the
    // persisted canonical Signal Score is exactly signal_confidence_num here.
    signal_confidence_num: overrides.confidence === undefined ? 70 : overrides.confidence,
    smart_money_score_num: null,
    entry_price_num: overrides.entryPrice ?? 0.42,
    metric_formula_version: overrides.metricFormulaVersion ?? "v2-lite-growth-safe",
    created_at: overrides.createdAt ?? "2026-07-27T15:30:00.000Z",
    expires_at: "2026-07-28T04:00:00.000Z",
    signal_result: null,
    event_slug: eventSlug,
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
    diagnostics: {
      gameStartIso,
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: providerEventId,
        eventStartIso: gameStartIso,
        sportFamily,
      },
      dataCoverage: 60,
      shadowScope: sportFamily,
      eventTitle: "New York Yankees vs Philadelphia Phillies",
      marketTitle: "Yankees vs Phillies moneyline",
    },
  };
}

async function planningOf(rows: readonly Record<string, unknown>[]) {
  return at(PLANNING_NOW_MS, () => produceContractAPlanningDecisions(rows));
}

function onlyResult(rows: readonly Record<string, unknown>[]) {
  return planningOf(rows).then((results) => {
    assert.equal(results.length, 1, "fixture must resolve to exactly one decision");
    return results[0];
  });
}

// ── 1. Score gate ────────────────────────────────────────────────────────────

test("B2-1a: persisted canonical Signal Score exactly 65 passes the pre-Reservation gate", async () => {
  assert.equal(B2_SCORE_THRESHOLD, 65);
  const result = await onlyResult([row({ confidence: 65 })]);
  assert.equal(result.accepted, true);
});

test("B2-1b: persisted canonical Signal Score below 65 rejects before Reservation", async () => {
  const result = await onlyResult([row({ confidence: 64 })]);
  assert.equal(result.accepted, false);
  if (result.accepted) return;
  assert.equal(result.rejection.reason_code, "B2_SCORE_BELOW_65");
  assert.equal(result.rejection.stage, "PLANNING");
  assert.equal(result.rejection.contract_a_version, "CONTRACT_A_PLANNING_V1");
});

// ── 2. Price gate ────────────────────────────────────────────────────────────

test("B2-2a: entry/signal price exactly 0.30 passes the pre-Reservation gate", async () => {
  assert.equal(B2_PRICE_FLOOR, 0.3);
  const result = await onlyResult([row({ entryPrice: 0.3 })]);
  assert.equal(result.accepted, true);
});

test("B2-2b: entry/signal price below 0.30 rejects before Reservation", async () => {
  const result = await onlyResult([row({ entryPrice: 0.29 })]);
  assert.equal(result.accepted, false);
  if (result.accepted) return;
  assert.equal(result.rejection.reason_code, "B2_PRICE_BELOW_030");
});

// ── 3. eSports exclusion ─────────────────────────────────────────────────────

test("B2-3: an eSports event never produces an accepted planning decision before Reservation", async () => {
  const results = await planningOf([
    row({ conditionId: "cond-cs2", tokenId: "tok-cs2", eventSlug: "cs2-navi-faze-2026-07-27", sportFamily: "cs2" }),
  ]);
  assert.equal(results.filter((r) => r.accepted).length, 0);
  // Any decision that is emitted for an eSports row is a B2 rejection.
  for (const result of results) {
    if (!result.accepted) assert.equal(result.rejection.reason_code, "B2_ESPORTS_EXCLUDED");
  }
});

test("B2-3b: evaluateContractAB2EventPolicy excludes eSports on the resolved scope even with clean text", () => {
  const verdict = evaluateContractAB2EventPolicy(
    { condition_id: "c", selected_token_id: "t", signal_confidence_num: 90, entry_price_num: 0.7 },
    "ESPORT"
  );
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.equal(verdict.reason_code, "B2_ESPORTS_EXCLUDED");
});

// ── 4. Timing ruling: no <120m wall-clock rejection at 17:00 planning ────────

test("B2-4: an event >120 minutes from the 17:00 planning instant is NOT rejected for timing", async () => {
  // game_start - planning_now = 240 minutes -> the old frozen B2 predicate
  // passesTimingWithin120m would reject this as OUTSIDE_120M. It must not here.
  const results = await planningOf([row({ gameStartIso: KICKOFF_FAR, confidence: 70 })]);
  assert.equal(results.length, 1);
  assert.equal(results[0].accepted, true, "a >120m event with passing B2 gates is accepted at planning");

  const plan = await at(PLANNING_NOW_MS, () =>
    buildReservationPlan(PLANNING_NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchSourceRows: async () => [row({ gameStartIso: KICKOFF_FAR, confidence: 70 })],
    })
  );
  assert.equal(plan.reservations.length, 1, "the >120m event is reserved");
  const codes = new Set(Object.keys(plan.diagnostics.rejection_counts_by_code));
  assert.ok(!codes.has("OUTSIDE_120M"), "no OUTSIDE_120M rejection code is produced");
  assert.ok(!codes.has("B2_OUTSIDE_120M"), "no B2 timing rejection code exists");
});

// ── 5. Future / post-cutoff evidence cannot contaminate ─────────────────────

test("B2-5: a later post-cutoff snapshot cannot displace the valid at-or-before-cutoff snapshot", async () => {
  const identity = { conditionId: "cond-asof", tokenId: "tok-asof", eventSlug: "mlb-asof-2026-07-27" };
  const atCutoff = row({
    ...identity,
    id: "00000000-0000-4000-8000-0000000000a1",
    confidence: 60, // fails B2 as of the planning cutoff
    createdAt: "2026-07-27T16:00:00.000Z", // <= planning now
  });
  const postCutoff = row({
    ...identity,
    id: "00000000-0000-4000-8000-0000000000a2",
    confidence: 90, // would pass — but it is future evidence
    createdAt: "2026-07-27T18:00:00.000Z", // > planning now
  });

  // as-of resolution keeps only the at-or-before-cutoff snapshot
  const resolved = resolveContractAAsOfSnapshots([postCutoff, atCutoff], PLANNING_NOW_MS);
  assert.deepEqual(resolved, [atCutoff]);

  // future snapshot listed first -> without as-of resolution the builder's
  // first-wins dedup would have picked the 90. It must not contaminate.
  const results = await planningOf([postCutoff, atCutoff]);
  assert.equal(results.length, 1);
  assert.equal(results[0].accepted, false);
  if (results[0].accepted) return;
  assert.equal(results[0].rejection.reason_code, "B2_SCORE_BELOW_65");
});

// ── 6. A B2 rejection can never become Reservation input ────────────────────

test("B2-6: a B2-rejected planning decision is excluded from the Reservation plan", async () => {
  const good = row({ confidence: 70 });
  const belowScore = row({
    id: "00000000-0000-4000-8000-000000000002",
    conditionId: "cond-bos-tor",
    tokenId: "tok-bos-tor",
    eventSlug: "mlb-bos-tor-2026-07-27",
    confidence: 55,
  });
  const plan = await at(PLANNING_NOW_MS, () =>
    buildReservationPlan(PLANNING_NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchSourceRows: async () => [good, belowScore],
    })
  );
  assert.equal(plan.reservations.length, 1, "only the B2-passing event is reserved");
  assert.equal(plan.reservations[0].event_slug, "mlb-nyy-phi-2026-07-27");
  assert.ok(
    (plan.diagnostics.planning_decisions_rejected ?? 0) >= 1,
    "the B2 rejection is accounted, never reserved"
  );
  const reservedSlugs = plan.reservations.map((r) => r.event_slug);
  assert.ok(!reservedSlugs.includes("mlb-bos-tor-2026-07-27"));
});

// ── 7. Broad 17:00 planning horizon unchanged ──────────────────────────────

test("B2-7: the broad 17:00 planning horizon is unchanged — a mid-horizon B2-passing event still reserves", async () => {
  const midHorizon = row({ gameStartIso: "2026-07-27T20:20:00.000Z", confidence: 72 }); // T-200
  const plan = await at(PLANNING_NOW_MS, () =>
    buildReservationPlan(PLANNING_NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchSourceRows: async () => [midHorizon],
    })
  );
  assert.equal(plan.reservations.length, 1);
  assert.equal(plan.diagnostics.reservation_authority, "CONTRACT_A_PLANNING_DECISION");
});

// ── 8. Post-Reservation Final Identity / Rebalance does not re-evaluate B2 ───

test("B2-8: Final Identity accepts a reserved identity whose later snapshot would fail every B2 gate", async () => {
  const planningRow = row({ confidence: 70, entryPrice: 0.42 });
  const [planning] = await planningOf([planningRow]);
  assert.equal(planning.accepted, true);
  if (!planning.accepted) return;

  // Same physical event + exact identity, but a snapshot that fails the B2
  // score gate (60 < 65) and the B2 price floor (0.20 < 0.30). It still clears
  // the upstream selector (confidence >= 50, entry price present), so this
  // isolates whether Final Identity re-runs B2 — it must not.
  const failingSnapshot = row({ confidence: 60, entryPrice: 0.2 });
  const finalViaProducer = await at(FINAL_NOW_MS, () =>
    produceContractAFinalIdentityDecision(planning.decision, [failingSnapshot])
  );
  assert.equal(finalViaProducer.accepted, true, "Final Identity must not re-run score/price/eSports");
  if (!finalViaProducer.accepted) return;
  assert.equal(finalViaProducer.decision.contract_a_version, "CONTRACT_A_V1");
  assert.equal(finalViaProducer.decision.physical_event_id, planning.decision.physical_event_id);
});

// ── 9. Production population boundary ───────────────────────────────────────

test("B2-9a: a v2-lite-growth-safe row with a canonical persisted score >= 65 flows the live contour", async () => {
  const result = await onlyResult([row({ metricFormulaVersion: "v2-lite-growth-safe", confidence: 66 })]);
  assert.equal(result.accepted, true);
});

test("B2-9b: a score-null shadow-strategic-sports-v1 row cannot satisfy 'persisted canonical Signal Score >= 65'", async () => {
  const shadow = row({
    conditionId: "cond-shadow",
    tokenId: "tok-shadow",
    eventSlug: "mlb-shadow-2026-07-27",
    metricFormulaVersion: "shadow-strategic-sports-v1",
    confidence: null,
  });
  const results = await planningOf([shadow]);
  for (const result of results) {
    assert.equal(result.accepted, false);
    if (!result.accepted) assert.equal(result.rejection.reason_code, "B2_SCORE_BELOW_65");
  }
});
