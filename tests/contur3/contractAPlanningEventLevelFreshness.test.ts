// RESTORE_FRESH_RESERVATION_EVIDENCE_V1
//   node --experimental-test-module-mocks --import tsx --test tests/contur3/contractAPlanningEventLevelFreshness.test.ts
//
// 2026-09-20 commit 01f506c (CONTRACT_A_PLANNING_EVENT_LEVEL_FRESHNESS_V1)
// removed the expires_at > snapshot admission gate from Contract A Planning
// and let PORTFOLIO_BROAD same-tier tie-breaks prefer the OLDEST
// source_created_at. Production proved this unsafe for live money: average
// source evidence age at Reservation rose from ~0.67h (6-day baseline) to
// ~5.66h (last 24h), max 17.49h. This file proves the previous-safe
// semantics are restored: expired identity evidence can no longer become a
// live-money Reservation candidate, and same-tier ties prefer the FRESHEST
// valid evidence. Every other existing Planning safety/identity/economic
// guard (signal_result null, production population, confidence>=50,
// structured sport authority, coverage>=25, future event start, market
// policy, PORTFOLIO_BROAD qualification) is untouched and unchanged here.

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
  resolvePortfolioBroadPhysicalEventAllocations,
} from "../../lib/executor/liveReservationAllocationPolicy";
import type { ContractAPlanningDecision } from "../../lib/executor/contractADecisions";

const NOW_MS = Date.parse("2026-07-27T17:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const RECENT_CREATED_AT = "2026-07-27T10:00:00.000Z"; // 7h before NOW_MS -- inside 72h lookback
const STALE_CREATED_AT = "2026-07-20T00:00:00.000Z"; // ~180h before NOW_MS -- outside 72h lookback
const FUTURE_EVENT_START = "2026-07-27T21:00:00.000Z";
const FUTURE_EXPIRES = "2026-07-27T18:00:00.000Z"; // after NOW_MS -- still valid
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
    expires_at: FUTURE_EXPIRES, // valid relative to NOW_MS unless overridden
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

// ── A: expires_at > planning snapshot, otherwise valid -> admissible ───────

test("A: a source row with expires_at > planning snapshot, otherwise valid, is Planning-admissible", async () => {
  const { candidates } = await buildPlanning([row({ expires_at: FUTURE_EXPIRES })]);
  assert.equal(candidates.length, 1, "a fresh, otherwise-valid identity must be admitted");
});

// ── B: expires_at <= planning snapshot -> excluded from live Planning ──────

test("B: a source row with expires_at <= planning snapshot is excluded from live Planning, even if otherwise valid", async () => {
  const { candidates } = await buildPlanning([row({ expires_at: PAST_EXPIRES })]);
  assert.equal(candidates.length, 0, "an expired identity must never become a live-money Reservation candidate");
});

test("B: expires_at exactly equal to the planning snapshot is excluded (strict > required)", async () => {
  const { candidates } = await buildPlanning([row({ expires_at: NOW_ISO })]);
  assert.equal(candidates.length, 0);
});

// ── C: 72h source_created_at lookback remains ───────────────────────────────

test("C: the 72h PLANNING_LOOKBACK_HOURS bound remains, independent of freshness", async () => {
  const { candidates, rawDiagnostics } = await buildPlanning([
    row({ created_at: STALE_CREATED_AT, expires_at: FUTURE_EXPIRES }),
  ]);
  assert.equal(candidates.length, 0);
  assert.equal(rawDiagnostics?.total_db_rows, 0, "a stale row never even enters the bounded Planning corpus");
});

// ── D: among two valid same-tier identities, the newer source_created_at wins ──

test("D: PORTFOLIO_BROAD same-tier tie-break prefers the freshest valid source_created_at", () => {
  const decision: ContractAPlanningDecision = {
    physical_event_id: "event-1",
    accepted: true,
    strategic_scope: "OTHER",
    source_lineage: { generated_signal_pair_id: null, observation_id: "cond-1::tok-older" },
  } as unknown as ContractAPlanningDecision;
  const decisionNewer: ContractAPlanningDecision = {
    ...decision,
    source_lineage: { generated_signal_pair_id: null, observation_id: "cond-1::tok-newer" },
  } as unknown as ContractAPlanningDecision;

  const olderRow = {
    id: "row-older",
    condition_id: "cond-1",
    selected_token_id: "tok-older",
    entry_price_num: 0.51,
    pre_event_score_num: null,
    created_at: "2026-07-27T08:00:00.000Z",
    expires_at: FUTURE_EXPIRES,
  };
  const newerRow = {
    id: "row-newer",
    condition_id: "cond-1",
    selected_token_id: "tok-newer",
    entry_price_num: 0.51,
    pre_event_score_num: null,
    created_at: "2026-07-27T12:00:00.000Z",
    expires_at: FUTURE_EXPIRES,
  };

  const resolution = resolvePortfolioBroadPhysicalEventAllocations(
    [decision, decisionNewer],
    [olderRow, newerRow],
    LIVE_RESERVATION_PORTFOLIO_BROAD_V2.policyId,
    NOW_ISO,
  );
  const allocation = resolution.qualified.get("event-1");
  assert.ok(allocation, "the physical event must qualify");
  assert.equal(
    allocation!.portfolio_token_id,
    "tok-newer",
    "the freshest valid same-tier identity must win the tie-break, not the oldest",
  );
});

// ── E: no future evidence may be used ───────────────────────────────────────
// The production DB read (fetchContractAPlanningServingRowSets) pins an
// upper bound of source_created_at <= snapshotAsOfIso via applyServingSnapshot
// -- unrelated to and unchanged by this mission's expires_at/tie-break fix,
// verified here as a still-standing guard against future-dated evidence.

test("E: the scored serving query still pins source_created_at <= snapshot (no future evidence)", async (t) => {
  const calls: { op: string; args: unknown[] }[] = [];
  const fakeAdmin = {
    from() {
      const builder: any = {
        select() { return builder; },
        in() { return builder; },
        is() { return builder; },
        gt() { return builder; },
        gte(...args: unknown[]) { calls.push({ op: "gte", args }); return builder; },
        lte(...args: unknown[]) { calls.push({ op: "lte", args }); return builder; },
        not() { return builder; },
        eq() { return builder; },
        or() { return builder; },
        order() { return builder; },
        limit(n: number) {
          const response = { data: [], error: null };
          return { ...response, abortSignal: (_signal: unknown) => Promise.resolve(response) };
        },
      };
      return builder;
    },
  };
  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: fakeAdmin },
  });
  const { loadContractAPlanningSourceRows } = await import("../../lib/executor/buildFireModelCandidates");
  await loadContractAPlanningSourceRows(NOW_MS);
  const upperBound = calls.find((c) => c.op === "lte" && c.args[0] === "source_created_at");
  assert.ok(upperBound, "the scored serving query must still pin source_created_at <= snapshotAsOfIso");
  assert.equal(upperBound!.args[1], NOW_ISO);
});

// ── F: no Ireland/Queue/stake behavior changes; live/non-Planning path unchanged ──

test("F: the non-Planning/live path still requires expires_at > now -- unchanged by this restoration", async () => {
  const { candidates } = await buildFireModelCandidates(
    50,
    "all",
    false,
    [row({ expires_at: PAST_EXPIRES })],
    "CONTUR3_CURRENT",
    NOW_MS,
  );
  assert.equal(candidates.length, 0, "an expired identity must still be excluded on the live/non-Planning path");
});

// ── I: PORTFOLIO_BROAD no longer reserves a physical event via expired model
//      evidence -- an expired identity is rejected upstream at Planning ────

test("I: PORTFOLIO_BROAD receives zero accepted decisions for an expired-only source, so nothing is reserved", async () => {
  const sourceRows = [row({ expires_at: PAST_EXPIRES })];
  const results = await produceContractAPlanningDecisions(sourceRows, 50, NOW_MS);
  assert.equal(results.filter((r) => r.accepted).length, 0, "an expired identity must not reach an accepted Planning decision");

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
  assert.equal(built.reservations.length, 0);
});

// ── J: active Reservation cap remains 30 ────────────────────────────────────

test("J: active Reservation cap remains 30", () => {
  assert.equal(LIVE_RESERVATION_PORTFOLIO_BROAD_V2.targetReservationSlots, 30);
});
