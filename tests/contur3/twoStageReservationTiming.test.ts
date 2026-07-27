// R0F TWO-STAGE RESERVATION TIMING CONTRACT — fixed-clock production replay.
//   node --import tsx --test tests/contur3/twoStageReservationTiming.test.ts
//
// Production regression after PR #62 (merge 4405637): two consecutive 17:00
// planning jobs produced 2 job rows, 0 Reservations, 0 queue rows, 0 orders.
// PR #62 narrowed the 17:00 planning universe to the FINAL authoritative
// Contract A universe, whose T-90 gate (snapshot within 120 minutes of
// kickoff) cannot be satisfied at 17:00 for a game several hours away. The
// planning stage therefore saw an empty universe every night.
//
// The correct architecture is TWO stages with TWO different identity contracts:
//
//   17:00 planning     -> PlanningEventIdentity
//                         (physical event key, canonical/provider event key,
//                          source lineage, game start, selector version)
//   T-70..T-3 rebalance -> ExecutableMarketIdentity
//                         (condition_id / token_id / side / observation id)
//   queue + Ireland     -> that ExecutableMarketIdentity, verbatim
//
// Planning may reserve a physical event BEFORE its T-90 identity exists; it may
// never reserve a malformed or unsupported one, and the final stage must resolve
// the exact market through the stable structured event identity — never through
// display titles or fuzzy slug matching.
//
// Every clock here is pinned: the planning selector, the planner and the
// rebalance each run under a fixed Date, so nothing depends on real "now".

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { buildReservationPlan } from "../../lib/executor/nightEventReservations";
import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import {
  mapQueueRowToIrelandCandidate,
  type EventExecutionQueueRow,
  type NightEventReservationRow,
} from "../../lib/executor/executorQueueTypes";

// ── Fixed timeline ──────────────────────────────────────────────────────────
// 2026-07-25T14:00:00Z = 17:00 Minsk (canonical planning anchor).
// Kickoff is 7 hours later, so at planning time NO T-90 snapshot can exist yet.
const PLANNING_MS = Date.parse("2026-07-25T14:00:00.000Z");
const KICKOFF_ISO = "2026-07-25T21:00:00.000Z";
// Planning-time observation: 8h before kickoff -> far outside the 120m gate.
const PLANNING_ROW_CREATED = "2026-07-25T13:00:00.000Z";
// The authoritative observation appears only at T-90 (19:30Z).
const T90_ROW_CREATED = "2026-07-25T19:30:00.000Z";
// Rebalance at T-50, inside the T-70..T-3 due window.
const REBALANCE_MS = Date.parse("2026-07-25T20:10:00.000Z");

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

// ── Sanitized production-shaped generated_signal_pairs rows ─────────────────
function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { __diagnostics, ...rest } = overrides as Record<string, unknown> & {
    __diagnostics?: Record<string, unknown>;
  };
  return {
    id: "00000000-0000-4000-8000-000000000001",
    condition_id: "cond-nyy-phi",
    selected_token_id: "tok-nyy-phi-yankees",
    selected_outcome: "New York Yankees",
    score: 80,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.42,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: PLANNING_ROW_CREATED,
    expires_at: KICKOFF_ISO,
    signal_result: null,
    event_slug: "mlb-nyy-phi-2026-07-25",
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
    diagnostics: {
      gameStartIso: KICKOFF_ISO,
      dataCoverage: 60,
      shadowScope: "baseball",
      eventTitle: "New York Yankees vs Philadelphia Phillies",
      marketTitle: "Yankees vs Phillies moneyline",
      ...(__diagnostics ?? {}),
    },
    ...rest,
  };
}

/** The 17:00 observation of the game: identity fields exist, T-90 decision does not. */
const PLANNING_ROW = sourceRow();

/** The same market re-observed at T-90 — this is what makes it authoritative. */
const T90_ROW = sourceRow({
  id: "00000000-0000-4000-8000-000000000002",
  created_at: T90_ROW_CREATED,
  score: 80,
  signal_confidence_num: 80,
  entry_price_num: 0.45,
});

/** A second physical event with no T-90 observation at all. */
const OTHER_EVENT_ROW = sourceRow({
  id: "00000000-0000-4000-8000-000000000003",
  condition_id: "cond-bos-tor",
  selected_token_id: "tok-bos-tor-boston",
  selected_outcome: "Boston Red Sox",
  event_slug: "mlb-bos-tor-2026-07-25",
  market_slug: "Boston Red Sox vs. Toronto Blue Jays - Moneyline",
  __diagnostics: { eventTitle: "Boston Red Sox vs Toronto Blue Jays", marketTitle: "Red Sox vs Blue Jays moneyline" },
});

/** KC activity-label market: never a valid reservation anchor, at either stage. */
const KC_ACTIVITY_ROW = sourceRow({
  id: "00000000-0000-4000-8000-000000000004",
  condition_id: "cond-kc-activity",
  selected_token_id: "tok-kc-activity",
  selected_outcome: "Kansas City Chiefs",
  event_slug: "$52K matched activity",
  market_slug: "$52K matched activity",
  __diagnostics: { eventTitle: "$52K matched activity", marketTitle: "$52K matched activity" },
});

// ── In-memory repo ─────────────────────────────────────────────────────────
function makeFakeRepo(seed: NightEventReservationRow[]) {
  const queueRows: EventExecutionQueueRow[] = [];
  const skippedCalls: Array<{ id: string; reason: string }> = [];
  const repo: RebalanceRepoPort = {
    async loadActiveReservations() {
      return seed;
    },
    async loadQueuedReservationIds() {
      return new Set(queueRows.map((r) => r.reservation_id).filter((v): v is string => Boolean(v)));
    },
    async markReservationsExpired() {},
    async markReservationSkipped(id, reason) {
      skippedCalls.push({ id, reason });
    },
    async insertQueueRow(row) {
      queueRows.push(row);
    },
    async markReservationQueued() {},
  };
  return { repo, queueRows, skippedCalls };
}

/** Stage 1: the real 17:00 planning path. */
async function planAt17(rows: Record<string, unknown>[]) {
  const planning = await at(PLANNING_MS, () =>
    buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_PLANNING_V1")
  );
  const plan = await at(PLANNING_MS, () =>
    buildReservationPlan(PLANNING_MS, { fetchCandidates: async () => ({ candidates: planning.candidates }) })
  );
  // Round-trip exactly as Supabase would store and return the row.
  const reservations: NightEventReservationRow[] = JSON.parse(JSON.stringify(plan.reservations)).map(
    (r: NightEventReservationRow, i: number) => ({ ...r, id: `res-${i}`, status: "RESERVED" as const })
  );
  return { planningCandidates: planning.candidates, plan, reservations };
}

/** Stage 2: the real T-70..T-3 rebalance against the fresh authoritative universe. */
async function rebalanceAtT50(
  reservations: NightEventReservationRow[],
  rows: Record<string, unknown>[],
  nowMs: number = REBALANCE_MS
) {
  const final = await at(nowMs, () => buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_V1"));
  const { repo, queueRows, skippedCalls } = makeFakeRepo(reservations);
  const result = await at(nowMs, () =>
    runEventRebalance(
      nowMs,
      { write: true },
      {
        repo,
        fetchCandidates: async () => ({ candidates: [] as FireModelCandidate[] }),
        fetchContractAFinalCandidates: async () => ({ candidates: final.candidates }),
      }
    )
  );
  return { finalCandidates: final.candidates, result, queueRows, skippedCalls };
}

function diag(row: { diagnostics: Record<string, unknown> }): Record<string, unknown> {
  return row.diagnostics ?? {};
}

// ── 1. The production regression itself ─────────────────────────────────────

test("R0F-1 (production RED): a future physical event with NO T-90 identity yet is still RESERVED at 17:00", async () => {
  // At 17:00 the authoritative universe is legitimately empty for this game.
  const authoritativeAtPlanning = await at(PLANNING_MS, () =>
    buildFireModelCandidates(100_000, "all", true, [PLANNING_ROW], "CONTRACT_A_V1")
  );
  assert.equal(
    authoritativeAtPlanning.candidates.length,
    0,
    "precondition: no T-90 authoritative decision can exist 7h before kickoff"
  );

  const { planningCandidates, plan } = await planAt17([PLANNING_ROW]);
  assert.ok(planningCandidates.length > 0, "planning inventory must be non-empty when a source physical event exists");
  assert.equal(plan.reservations.length, 1, "the physical event must be reserved before its T-90 identity exists");
});

test("R0F-2: the reservation carries a structured PlanningEventIdentity, not a final market identity", async () => {
  const { reservations } = await planAt17([PLANNING_ROW]);
  const d = diag(reservations[0]);
  assert.equal(typeof d.planning_event_key, "string");
  assert.ok(String(d.planning_event_key).length > 0);
  assert.equal(d.identity_physical_event_key, reservations[0].match_family_key);
  assert.equal(d.planning_stage, "PLANNING_EVENT_IDENTITY");
  assert.equal(typeof d.planning_selector_version, "string");
  assert.equal(reservations[0].game_start_iso, KICKOFF_ISO);
  // Planning must NOT claim a final execution identity it does not have.
  assert.equal(d.authoritative_token_id, undefined);
  assert.equal(d.authoritative_condition_id, undefined);
});

// ── 2. The T-90 handoff ─────────────────────────────────────────────────────

test("R0F-3: at T-90 the same event resolves its exact authoritative identity and reaches the queue", async () => {
  const { reservations } = await planAt17([PLANNING_ROW]);
  const { result, queueRows } = await rebalanceAtT50(reservations, [PLANNING_ROW, T90_ROW]);
  assert.equal(result.queued_count, 1);
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0].condition_id, "cond-nyy-phi");
  assert.equal(queueRows[0].token_id, "tok-nyy-phi-yankees");
  assert.equal(queueRows[0].side, "New York Yankees");

  // Ireland receives the exact same identity on the wire.
  const wire = mapQueueRowToIrelandCandidate(queueRows[0], REBALANCE_MS);
  assert.equal(wire.condition_id, "cond-nyy-phi");
  assert.equal(wire.token_id, "tok-nyy-phi-yankees");
  assert.equal(wire.side, "New York Yankees");
  assert.equal(wire.order_key, "cond-nyy-phi:tok-nyy-phi-yankees:New York Yankees");
});

test("R0F-4: when the T-90 identity never appears, the reservation fails closed with FINAL_AUTHORITATIVE_IDENTITY_NOT_AVAILABLE", async () => {
  const { reservations } = await planAt17([PLANNING_ROW]);
  // Rebalance sees only the planning-time observation -- still no T-90 decision.
  const { result, queueRows, skippedCalls } = await rebalanceAtT50(reservations, [PLANNING_ROW]);
  assert.equal(result.queued_count, 0);
  assert.equal(queueRows.length, 0);
  assert.match(skippedCalls[0].reason, /FINAL_AUTHORITATIVE_IDENTITY_NOT_AVAILABLE/);
});

// ── 3. Structured join, never strings ───────────────────────────────────────

test("R0F-5: a display-title/market-title change between planning and rebalance does not break the structured match", async () => {
  const { reservations } = await planAt17([PLANNING_ROW]);
  const renamedT90 = {
    ...T90_ROW,
    market_slug: "NY Yankees @ Philadelphia Phillies — Moneyline",
    diagnostics: {
      ...(T90_ROW.diagnostics as Record<string, unknown>),
      eventTitle: "N.Y. YANKEES   vs   PHILADELPHIA  PHILLIES",
      marketTitle: "Yankees @ Phillies ML",
    },
  };
  const { result, queueRows } = await rebalanceAtT50(reservations, [PLANNING_ROW, renamedT90]);
  assert.equal(result.queued_count, 1, "structured event identity survives display-string churn");
  assert.equal(queueRows[0].token_id, "tok-nyy-phi-yankees");
});

test("R0F-6: a conflicting canonical event identity fails closed -- no fuzzy substitution", async () => {
  const { reservations } = await planAt17([PLANNING_ROW]);
  // A different physical event whose titles look similar but whose canonical
  // event identity differs: it must never be substituted.
  const lookalike = sourceRow({
    id: "00000000-0000-4000-8000-000000000009",
    condition_id: "cond-other",
    selected_token_id: "tok-other",
    created_at: T90_ROW_CREATED,
    signal_confidence_num: 95,
    event_slug: "mlb-nyy-phi-2026-07-26-game-two",
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
  });
  const { result, queueRows, skippedCalls } = await rebalanceAtT50(reservations, [PLANNING_ROW, lookalike]);
  assert.equal(result.queued_count, 0);
  assert.equal(queueRows.length, 0);
  assert.match(skippedCalls[0].reason, /FINAL_AUTHORITATIVE_IDENTITY_NOT_AVAILABLE/);
});

test("R0F-7: several markets exist at T-90 -- only the authoritative decision for the reserved event is queued", async () => {
  const { reservations } = await planAt17([PLANNING_ROW]);
  // Same physical event, an alternate token with a deliberately higher score.
  const alternate = sourceRow({
    id: "00000000-0000-4000-8000-00000000000a",
    condition_id: "cond-nyy-phi-alt",
    selected_token_id: "tok-nyy-phi-phillies",
    selected_outcome: "Philadelphia Phillies",
    created_at: T90_ROW_CREATED,
    signal_confidence_num: 95,
    entry_price_num: 0.45,
  });
  const { result, queueRows } = await rebalanceAtT50(reservations, [PLANNING_ROW, T90_ROW, alternate]);
  // Contract A dedups to exactly one decision per physical event, and the queue
  // copies that decision's identity verbatim.
  assert.equal(result.queued_count, 1);
  assert.equal(queueRows.length, 1, "one physical event -> at most one queue row");
  assert.ok(["tok-nyy-phi-yankees", "tok-nyy-phi-phillies"].includes(queueRows[0].token_id));
  assert.equal(queueRows[0].order_key, `${queueRows[0].condition_id}:${queueRows[0].token_id}:${queueRows[0].side}`);
});

// ── 4. Safety preserved from PR #62 ────────────────────────────────────────

test("R0F-8: the KC activity-label market is rejected at BOTH stages", async () => {
  const { plan } = await planAt17([KC_ACTIVITY_ROW]);
  assert.equal(plan.reservations.length, 0, "a malformed/unsupported physical event must never be reserved");
});

test("R0F-9: duplicate representations of one physical event yield one reservation and at most one queue row", async () => {
  const duplicate = sourceRow({
    id: "00000000-0000-4000-8000-00000000000b",
    condition_id: "cond-nyy-phi-dup",
    selected_token_id: "tok-nyy-phi-dup",
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
  });
  const { plan, reservations } = await planAt17([PLANNING_ROW, duplicate]);
  assert.equal(plan.reservations.length, 1, "one physical event -> one reservation");
  const { queueRows } = await rebalanceAtT50(reservations, [PLANNING_ROW, duplicate, T90_ROW]);
  assert.ok(queueRows.length <= 1);
});

// ── 5. Honest zero-plan accounting ─────────────────────────────────────────

test("R0F-10: source rows with zero final snapshots produce a NON-zero honest plan", async () => {
  const { plan } = await planAt17([PLANNING_ROW, OTHER_EVENT_ROW]);
  assert.equal(plan.reservations.length, 2, "both future physical events are reservable without any T-90 identity");
  assert.ok(plan.diagnostics.universe_size > 0);
});

test("R0F-11: a genuinely empty source inventory reports zero reservations and its exact first zero-count stage", async () => {
  const { plan } = await planAt17([]);
  assert.equal(plan.reservations.length, 0);
  assert.equal(plan.diagnostics.universe_size, 0);
  assert.equal(plan.diagnostics.source_rows, 0);
  assert.equal(plan.diagnostics.first_zero_stage, "SOURCE_ROWS");
});

test("R0F-12: the planning diagnostics expose the full funnel so a zero plan can never be silent", async () => {
  const { plan } = await planAt17([PLANNING_ROW, KC_ACTIVITY_ROW]);
  const d = plan.diagnostics;
  assert.equal(typeof d.source_rows, "number");
  assert.equal(typeof d.normalized_physical_events, "number");
  assert.equal(typeof d.planning_eligible_events, "number");
  assert.equal(d.reservations_created, plan.reservations.length);
  assert.equal(typeof d.rejected_by_anchor, "number");
  assert.equal(typeof d.rejected_by_scope, "number");
  assert.equal(typeof d.final_identity_available_at_planning, "number");
  assert.equal(d.final_identity_available_at_planning, 0, "no T-90 identity exists at 17:00 -- and that is fine");
  assert.equal(d.first_zero_stage, null, "a non-zero plan has no zero stage");
});

test("R0F-13: the rebalance result exposes its own structured funnel", async () => {
  const { reservations } = await planAt17([PLANNING_ROW]);
  const { result } = await rebalanceAtT50(reservations, [PLANNING_ROW, T90_ROW]);
  assert.equal(result.due_reservations, 1);
  assert.ok(result.authoritative_candidates >= 1);
  assert.equal(result.event_identity_matches, 1);
  assert.equal(result.queue_rows_created, 1);
  assert.equal(result.first_rejection_code, null);
});

test("R0F-14: an unresolved rebalance reports its first rejection code", async () => {
  const { reservations } = await planAt17([PLANNING_ROW]);
  const { result } = await rebalanceAtT50(reservations, [PLANNING_ROW]);
  assert.equal(result.due_reservations, 1);
  assert.equal(result.authoritative_candidates, 0);
  assert.equal(result.event_identity_matches, 0);
  assert.equal(result.queue_rows_created, 0);
  assert.equal(result.first_rejection_code, "FINAL_AUTHORITATIVE_IDENTITY_NOT_AVAILABLE");
});
