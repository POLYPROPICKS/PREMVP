// CONTRACT_A_PLANNING_EVENT_LEVEL_FRESHNESS_V1
//   node --import tsx --test tests/contur3/contractAPlanningEventLevelFreshness.test.ts
//
// Contract A Planning reserves a PHYSICAL EVENT from bounded model evidence,
// not a live-executable identity. An expired source identity snapshot (still
// within the unchanged 72h PLANNING_LOOKBACK_HOURS bound) remains valid
// Planning evidence; every other existing Planning safety/identity/economic
// guard is untouched. Executable-identity freshness stays owned exclusively
// by Final Identity / rebalance -- never re-derived or re-selected here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFireModelCandidates,
} from "../../lib/executor/buildFireModelCandidates";
import { produceContractAPlanningDecisions } from "../../lib/executor/contractADecisions";
import { buildReservationsFromPlanningDecisions } from "../../lib/executor/nightEventReservations";
import { buildPlanRunId, resolveNightWindow } from "../../lib/executor/nightWindow";
import {
  LIVE_RESERVATION_PORTFOLIO_BROAD_V2,
  classifyPortfolioBroadTier,
} from "../../lib/executor/liveReservationAllocationPolicy";

const NOW_MS = Date.parse("2026-07-27T17:00:00.000Z");
const RECENT_CREATED_AT = "2026-07-27T10:00:00.000Z"; // 7h before NOW_MS -- inside 72h lookback
const STALE_CREATED_AT = "2026-07-20T00:00:00.000Z"; // ~180h before NOW_MS -- outside 72h lookback
const FUTURE_EVENT_START = "2026-07-27T21:00:00.000Z";
const PAST_EVENT_START = "2026-07-27T10:00:00.000Z"; // before NOW_MS -- already started
const PAST_EXPIRES = "2026-07-27T16:00:00.000Z"; // before NOW_MS -- already expired

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "row-1",
    condition_id: "cond-1",
    selected_token_id: "tok-1",
    selected_outcome: "New York Yankees",
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
    event_slug: "mlb-nyy-phi-2026-07-27",
    entry_price_num: 0.51,
    signal_confidence_num: 90,
    smart_money_score_num: null,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: RECENT_CREATED_AT,
    expires_at: PAST_EXPIRES, // already expired relative to NOW_MS
    signal_result: null,
    diagnostics: {
      gameStartIso: FUTURE_EVENT_START,
      dataCoverage: 90,
      shadowScope: "baseball",
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: "mlb-nyy-phi-2026-07-27",
        eventStartIso: FUTURE_EVENT_START,
        sportFamily: "baseball",
      },
    },
    ...overrides,
  };
}

function buildPlanning(rows: Record<string, unknown>[]) {
  return buildFireModelCandidates(50, "all", true, rows, "CONTRACT_A_PLANNING_V1", NOW_MS);
}

// ── A/H: expired identity, otherwise fully valid -> admitted ───────────────

test("A/H: an expired identity within the 72h lookback, otherwise fully valid, remains Planning-admissible via the injected-row path", async () => {
  const { candidates, rawDiagnostics } = await buildPlanning([row()]);
  assert.equal(candidates.length, 1, "an expired-but-otherwise-valid identity must be admitted");
  assert.equal(rawDiagnostics?.planning_expired_source_row_n, 1);
});

// ── B: source_created_at older than PLANNING_LOOKBACK_HOURS -> still excluded ──

test("B: a row older than the 72h PLANNING_LOOKBACK_HOURS bound is still excluded, expired or not", async () => {
  const { candidates, rawDiagnostics } = await buildPlanning([row({ created_at: STALE_CREATED_AT })]);
  assert.equal(candidates.length, 0);
  assert.equal(rawDiagnostics?.total_db_rows, 0, "a stale row never even enters the bounded Planning corpus");
});

// ── C: signal_result non-null -> still excluded ─────────────────────────────

test("C: a resolved row (signal_result non-null) is still excluded", async () => {
  const { candidates } = await buildPlanning([row({ signal_result: "WIN" })]);
  assert.equal(candidates.length, 0);
});

// ── D: signal_confidence < 50 -> still excluded ─────────────────────────────

test("D: signal_confidence_num below 50 is still excluded", async () => {
  const { candidates } = await buildPlanning([row({ signal_confidence_num: 40 })]);
  assert.equal(candidates.length, 0);
});

// ── E: event already started -> still rejected downstream ──────────────────

test("E: an event that has already started is still rejected (GAME_STARTED_OR_INVALID), expired identity or not", async () => {
  const { candidates, rawDiagnostics } = await buildPlanning([
    row({ diagnostics: { gameStartIso: PAST_EVENT_START, dataCoverage: 90, shadowScope: "baseball" } }),
  ]);
  assert.equal(candidates.length, 0);
  assert.equal(rawDiagnostics?.rejected_before_planning_by_reason.GAME_STARTED_OR_INVALID, 1);
});

// ── F: coverage < 25 -> still rejected ──────────────────────────────────────

test("F: coverage below 25 is still rejected (LOW_COVERAGE), expired identity or not", async () => {
  const { candidates, rawDiagnostics } = await buildPlanning([
    row({ diagnostics: { gameStartIso: FUTURE_EVENT_START, dataCoverage: 20, shadowScope: "baseball" } }),
  ]);
  assert.equal(candidates.length, 0);
  assert.equal(rawDiagnostics?.rejected_before_planning_by_reason.LOW_COVERAGE, 1);
});

// ── G: non-Planning selector with expires_at < now -> still excluded exactly as before ──

test("G: the non-Planning/live path still requires expires_at > now -- unchanged", async () => {
  const { candidates } = await buildFireModelCandidates(50, "all", false, [row()], "CONTUR3_CURRENT", NOW_MS);
  assert.equal(candidates.length, 0, "an expired identity must still be excluded on the live/non-Planning path");
});

// ── I: PORTFOLIO_BROAD may reserve an event via expired model evidence, but ──
//      selects no new final executable identity at Reservation ─────────────

test("I: PORTFOLIO_BROAD reserves the physical event from expired model evidence, with no final executable identity selected at Reservation", async () => {
  const sourceRows = [row()];
  const results = await produceContractAPlanningDecisions(sourceRows, 50, NOW_MS);
  assert.equal(results.length, 1);
  assert.ok(results[0].accepted, "the Contract A Planning decision must be accepted despite the expired identity");

  const window = resolveNightWindow(NOW_MS);
  const built = buildReservationsFromPlanningDecisions(
    results,
    { planRunId: buildPlanRunId(NOW_MS), window, nowMs: NOW_MS },
    [],
    {
      allocationPolicy: LIVE_RESERVATION_PORTFOLIO_BROAD_V2,
      sourceRowsForCandidateManifest: sourceRows,
    },
  );
  assert.equal(built.reservations.length, 1);
  assert.equal(built.portfolioBroadFromExpiredSourceEventN, 1);
  const diagnostics = built.reservations[0].diagnostics as Record<string, unknown>;
  assert.equal(diagnostics.portfolio_tier, 2); // price 0.51, non-tennis, no pre_event_score -> Tier 2
  // Reservation performs no NEW identity selection: any identity evidence
  // present is exactly the original Planning decision's own evidence,
  // verbatim -- never a freshly re-selected "current" identity.
  const finalIdentityEvidence = diagnostics.planning_final_identity_evidence as
    | { condition_id: string; token_id: string }
    | null;
  if (finalIdentityEvidence !== null) {
    assert.equal(finalIdentityEvidence.condition_id, "cond-1");
    assert.equal(finalIdentityEvidence.token_id, "tok-1");
  }
});

// ── J: active Reservation cap remains 30 ────────────────────────────────────

test("J: active Reservation cap remains 30", () => {
  assert.equal(LIVE_RESERVATION_PORTFOLIO_BROAD_V2.targetReservationSlots, 30);
});

// ── K: no price >= 0.54 becomes PORTFOLIO_BROAD-qualified ──────────────────

test("K: no price >= 0.54 becomes PORTFOLIO_BROAD-qualified, expired identity or not", async () => {
  assert.equal(classifyPortfolioBroadTier(0.54, 90, "TENNIS"), null);
  const { candidates } = await produceContractAPlanningDecisions([row({ entry_price_num: 0.6 })], 50, NOW_MS).then(
    async (results) => {
      const window = resolveNightWindow(NOW_MS);
      const built = buildReservationsFromPlanningDecisions(
        results,
        { planRunId: buildPlanRunId(NOW_MS), window, nowMs: NOW_MS },
        [],
        { allocationPolicy: LIVE_RESERVATION_PORTFOLIO_BROAD_V2, sourceRowsForCandidateManifest: [row({ entry_price_num: 0.6 })] },
      );
      return { candidates: built.reservations };
    },
  );
  assert.equal(candidates.length, 0, "a price outside every Broad tier must never be reserved, expired or not");
});
