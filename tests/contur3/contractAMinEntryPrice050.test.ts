// RELEASE_CONTRACT_A_MIN_ENTRY_PRICE_050_V1 — loss-containment Contract A
// money-admission price floor.
//   node --import tsx --test tests/contur3/contractAMinEntryPrice050.test.ts
//
// Minimal, self-contained focused proof only. Deliberately does NOT touch or
// route through coverage / BAD_BUCKET_COV_PRICE / market taxonomy / liquidity
// / Reservation-Rebalance-Queue mechanics — those are untouched and out of
// scope for this mission.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_A_MIN_ENTRY_PRICE,
  evaluateContractAB2EventPolicy,
} from "../../lib/executor/contractAB2EventPolicy";
import { produceContractAPlanningDecisions } from "../../lib/executor/contractADecisions";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";

const PLANNING_NOW_MS = Date.parse("2026-07-27T17:00:00.000Z");

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

// Otherwise-passing row shape (score 90) so only the price gate is under test.
function passingRow(entryPrice: number, overrides: Record<string, unknown> = {}) {
  return { condition_id: "c", selected_token_id: "t", signal_confidence_num: 90, entry_price_num: entryPrice, ...overrides };
}

test("CONTRACT_A_MIN_ENTRY_PRICE is fixed at 0.50", () => {
  assert.equal(CONTRACT_A_MIN_ENTRY_PRICE, 0.5);
});

test("0.49 -> rejected, reason_code B2_PRICE_BELOW_050", () => {
  const verdict = evaluateContractAB2EventPolicy(passingRow(0.49), "MLB");
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.equal(verdict.reason_code, "B2_PRICE_BELOW_050");
});

test("0.499999 -> rejected, reason_code B2_PRICE_BELOW_050", () => {
  const verdict = evaluateContractAB2EventPolicy(passingRow(0.499999), "MLB");
  assert.equal(verdict.allowed, false);
  if (verdict.allowed) return;
  assert.equal(verdict.reason_code, "B2_PRICE_BELOW_050");
});

test("0.50 -> price gate passes through to existing downstream predicates", () => {
  const verdict = evaluateContractAB2EventPolicy(passingRow(0.5), "MLB");
  assert.equal(verdict.allowed, true);
});

test("0.55 -> price gate passes through to existing downstream predicates", () => {
  const verdict = evaluateContractAB2EventPolicy(passingRow(0.55), "MLB");
  assert.equal(verdict.allowed, true);
});

test("passing the price gate never bypasses an existing downstream predicate (score, eSports)", () => {
  const belowScore = evaluateContractAB2EventPolicy(passingRow(0.55, { signal_confidence_num: 40 }), "MLB");
  assert.equal(belowScore.allowed, false);
  if (!belowScore.allowed) assert.equal(belowScore.reason_code, "B2_SCORE_BELOW_65");

  const esports = evaluateContractAB2EventPolicy(passingRow(0.55), "ESPORT");
  assert.equal(esports.allowed, false);
  if (!esports.allowed) assert.equal(esports.reason_code, "B2_ESPORTS_EXCLUDED");
});

// ── SUB050_FALLBACK_N = 0 + one-physical-event economic invariant unchanged ──
//
// dataCoverage: 90 (outside the pre-existing, untouched BAD_BUCKET_COV_PRICE
// band of coverage 50-74) is the only fixture value chosen to let a sub-0.50
// row reach Contract A / B2 evaluation at all through the real pipeline; it
// changes no coverage/BAD_BUCKET semantics.
function pipelineRow(overrides: {
  id: string;
  conditionId: string;
  tokenId: string;
  eventSlug: string;
  entryPrice: number;
  confidence?: number;
}) {
  const gameStartIso = "2026-07-27T21:00:00.000Z";
  return {
    id: overrides.id,
    condition_id: overrides.conditionId,
    selected_token_id: overrides.tokenId,
    token_id: overrides.tokenId,
    selected_outcome: "New York Yankees",
    signal_confidence_num: overrides.confidence ?? 90,
    smart_money_score_num: null,
    entry_price_num: overrides.entryPrice,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: "2026-07-27T15:30:00.000Z",
    expires_at: "2026-07-28T04:00:00.000Z",
    signal_result: null,
    event_slug: overrides.eventSlug,
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
    diagnostics: {
      gameStartIso,
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: overrides.eventSlug,
        eventStartIso: gameStartIso,
        sportFamily: "baseball",
      },
      dataCoverage: 90,
      shadowScope: "baseball",
      eventTitle: "New York Yankees vs Philadelphia Phillies",
      marketTitle: "Yankees vs Phillies moneyline",
    },
  };
}

test("SUB050_FALLBACK_N = 0: a sub-0.50 identity is rejected pre-Reservation, never admitted as a fallback", async () => {
  const subOnly = pipelineRow({
    id: "00000000-0000-4000-8000-000000000201",
    conditionId: "cond-sub050-only",
    tokenId: "tok-sub050-only",
    eventSlug: "mlb-sub050-only-2026-07-27",
    entryPrice: 0.49,
  });

  const decisions = await at(PLANNING_NOW_MS, () => produceContractAPlanningDecisions([subOnly]));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].accepted, false);
  if (!decisions[0].accepted) assert.equal(decisions[0].rejection.reason_code, "B2_PRICE_BELOW_050");

  const plan = await at(PLANNING_NOW_MS, () =>
    buildReservationPlan(PLANNING_NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchSourceRows: async () => [subOnly],
    })
  );
  assert.equal(plan.reservations.length, 0, "zero Contract A candidates — no sub-0.50 fallback fills the slot");
});

test("one-physical-event economic invariant unchanged: a >=0.50 sibling identity for the SAME physical event still yields at most one Reservation", async () => {
  const subPrice = pipelineRow({
    id: "00000000-0000-4000-8000-000000000301",
    conditionId: "cond-sibling-sub",
    tokenId: "tok-sibling-sub",
    eventSlug: "mlb-nyy-phi-2026-07-27",
    entryPrice: 0.49,
  });
  const passPrice = pipelineRow({
    id: "00000000-0000-4000-8000-000000000302",
    conditionId: "cond-sibling-pass",
    tokenId: "tok-sibling-pass",
    eventSlug: "mlb-nyy-phi-2026-07-27",
    entryPrice: 0.6,
  });

  const plan = await at(PLANNING_NOW_MS, () =>
    buildReservationPlan(PLANNING_NOW_MS, {
      selectorMode: "CONTRACT_A_PLANNING_V1",
      fetchSourceRows: async () => [subPrice, passPrice],
    })
  );
  assert.equal(plan.reservations.length, 1, "one physical event -> at most one Reservation, unchanged");
});
