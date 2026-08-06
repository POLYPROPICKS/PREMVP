import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";
import { produceContractAPlanningDecisions } from "../../lib/executor/contractADecisions";
import {
  buildReservationsFromPlanningDecisions,
  persistReservationPlan,
  type ReservationRepoPort,
  type ReservationPlan,
} from "../../lib/executor/nightEventReservations";
import { resolveNightWindow } from "../../lib/executor/nightWindow";
import {
  planningDecisionFromReservation,
  runEventRebalance,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

const PLAN_NOW = Date.parse("2026-08-06T14:00:00.000Z");
const START = "2026-08-06T19:00:00.000Z";
const REBALANCE_NOW = Date.parse("2026-08-06T18:00:00.000Z");
const EVENT_ID = "provider-event-987";

function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(value?: string | number | Date) { super(value ?? ms); }
    static now() { return ms; }
  }
  globalThis.Date = FrozenDate as DateConstructor;
  return fn().finally(() => { globalThis.Date = RealDate; });
}

function source(id: string, score: number, conditionId: string, eventId = EVENT_ID, eventStartIso = START) {
  return {
    id,
    source: "polymarket",
    formula_version: "v2-lite-growth-safe",
    metric_formula_version: "v2-lite-growth-safe",
    condition_id: conditionId,
    selected_token_id: `token-${conditionId}`,
    token_id: `token-${conditionId}`,
    selected_outcome: "YES",
    score,
    signal_confidence_num: score,
    smart_money_score_num: 50,
    entry_price_num: 0.42,
    stake_usd: 1.1,
    max_entry_price: 0.55,
    created_at: "2026-08-06T13:30:00.000Z",
    expires_at: START,
    signal_result: null,
    event_slug: "display-only-event-slug",
    market_slug: "Provider event moneyline",
    diagnostics: {
      gameStartIso: eventStartIso,
      dataCoverage: 60,
      shadowScope: "baseball",
      providerEventContext: {
        v: "v1", provider: "polymarket", eventId, eventStartIso,
        sportFamily: "baseball", league: "MLB",
      },
    },
  };
}

test("full link: exact Signal Pair -> Planning -> persisted Reservation -> max-score Queue is deterministic and idempotent", async () => {
  const anchor = source("00000000-0000-4000-8000-000000000101", 75, "cond-anchor");
  const siblingLow = source("00000000-0000-4000-8000-000000000102", 80, "cond-low");
  const siblingHigh = source("00000000-0000-4000-8000-000000000103", 91, "cond-high");
  const otherEvent = source("00000000-0000-4000-8000-000000000104", 99, "cond-other", "provider-event-other");

  const decisions = await at(PLAN_NOW, () => produceContractAPlanningDecisions([anchor]));
  assert.equal(decisions[0]?.accepted, true);
  if (!decisions[0]?.accepted) return;
  const built = buildReservationsFromPlanningDecisions(decisions, {
    planRunId: "night-plan:2026-08-06:1700-minsk",
    window: resolveNightWindow(PLAN_NOW),
    nowMs: PLAN_NOW,
  });
  assert.equal(built.reservations.length, 1);
  const reservation = built.reservations[0];
  const lineage = reservation.diagnostics.source_lineage as Record<string, unknown>;
  assert.equal(reservation.physical_event_id, "provider:polymarket:provider-event-987:2026-08-06");
  assert.equal(reservation.event_start_iso, START);
  assert.equal(lineage.generated_signal_pair_id, anchor.id);
  assert.equal(lineage.provider_event_id, EVENT_ID);
  assert.equal(lineage.provider_event_start_iso, START);
  assert.equal(lineage.provider_sport, "baseball");
  assert.equal(reservation.event_score, decisions[0].decision.planning_score);
  assert.deepEqual(
    planningDecisionFromReservation(reservation)?.source_lineage,
    decisions[0].decision.source_lineage,
    "database-shaped Reservation reconstruction preserves exact provider lineage"
  );
  const legacyWithoutProviderIdentity = structuredClone(reservation);
  delete (legacyWithoutProviderIdentity.diagnostics.source_lineage as Record<string, unknown>).provider_event_id;
  assert.equal(
    planningDecisionFromReservation(legacyWithoutProviderIdentity),
    null,
    "legacy Reservations without exact provider identity remain fail-closed"
  );

  const persisted: NightEventReservationRow[] = [];
  const reservationRepo: ReservationRepoPort = {
    async findByPlanRunId() { return []; },
    async findByPhysicalEventId() { return null; },
    async deleteByPlanRunId() {},
    async insert(rows) { persisted.push(...rows.map((row) => ({ ...row, id: "reservation-exact" }))); },
  };
  const planForPersist = {
    plan_run_id: reservation.plan_run_id,
    reservations: [reservation],
    diagnostics: {},
  } as unknown as ReservationPlan;
  const persistence = await persistReservationPlan(planForPersist, {}, reservationRepo);
  assert.equal(persistence.written_count, 1);

  const queues: EventExecutionQueueRow[] = [];
  const rebalanceRepo: RebalanceRepoPort = {
    async loadActiveReservations() { return persisted; },
    async loadQueuedReservationIds() { return new Set(queues.map((q) => q.reservation_id).filter((id): id is string => id !== null)); },
    async markReservationsExpired() {}, async markReservationSkipped() {}, async markReservationQueued() {},
    async insertQueueRow(row) { queues.push({ ...row, id: "queue-exact" }); },
  };
  const deps = {
    repo: rebalanceRepo,
    fetchFinalIdentitySourceRows: async () => [anchor, siblingLow, siblingHigh, otherEvent],
    fetchCandidates: async () => { throw new Error("no model/Contract A/order-book/price policy may run after Reservation"); },
  };
  const first = await runEventRebalance(REBALANCE_NOW, { write: true }, deps);
  assert.equal(first.due_count, 1);
  assert.equal(first.queued_count, 1);
  assert.equal(queues.length, 1);
  assert.equal(queues[0].condition_id, "cond-high");
  assert.equal(queues[0].token_id, "token-cond-high");
  assert.equal(queues[0].side, "YES");
  assert.equal(queues[0].diagnostics.selected_signal_pair_id, siblingHigh.id);
  assert.ok(queues[0].idempotency_key);
  const second = await runEventRebalance(REBALANCE_NOW, { write: true }, deps);
  assert.equal(second.already_queued_count, 1);
  assert.equal(queues.length, 1);
});
