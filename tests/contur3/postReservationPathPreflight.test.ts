import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReservationPlan,
  persistReservationPlan,
  type ReservationRepoPort,
} from "../../lib/executor/nightEventReservations";
import {
  loadExactProviderSiblingRowsFromAnchor,
  runEventRebalance,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import type {
  EventExecutionQueueRow,
  NightEventReservationRow,
} from "../../lib/executor/executorQueueTypes";
import {
  GeneratedSignalPairsTable,
  producerShapedRow,
} from "./helpers/generatedSignalPairsSchemaHarness";

const PROVIDER_EVENT_ID = "preflight-822471";
const EVENT_START = "2026-08-11T18:30:00.000Z";
const PHYSICAL_EVENT_ID = "provider:polymarket:preflight-822471:2026-08-11";
const ANCHOR_ID = "00000000-0000-4000-8000-000000008221";
const SIBLING_ID = "00000000-0000-4000-8000-000000008222";
const CONDITION_ID = "0xpreflight-condition";
const SCORE_CONTRACT = "shadow-firemodel1_1_research_v0";
const PLANNING_NOW = Date.parse("2026-08-11T14:00:00.000Z");
const T70_NOW = Date.parse("2026-08-11T17:20:00.000Z");

function scoredRow(input: {
  id: string;
  token: string;
  outcome: string;
  score: number;
  price: number;
}): Record<string, unknown> {
  const row = producerShapedRow({
    id: input.id,
    conditionId: CONDITION_ID,
    selectedTokenId: input.token,
    selectedOutcome: input.outcome,
    signalConfidenceNum: input.score,
    entryPriceNum: input.price,
    metricFormulaVersion: SCORE_CONTRACT,
    providerEventId: PROVIDER_EVENT_ID,
    providerEventStartIso: EVENT_START,
  });
  return {
    ...row,
    market_slug: "Home vs Away - Moneyline",
    diagnostics: {
      ...(row.diagnostics as Record<string, unknown>),
      providerEventContext: {
        ...((row.diagnostics as Record<string, unknown>).providerEventContext as Record<string, unknown>),
        sportFamily: "soccer",
      },
      gameStartIso: EVENT_START,
      dataCoverage: 60,
      shadowScope: "soccer",
      eventTitle: "display only",
      marketTitle: "display only",
    },
  };
}

test("PRE17: allocated Contract-A Reservation persists, reloads, resolves exact siblings, and queues once", async () => {
  const anchor = scoredRow({ id: ANCHOR_ID, token: "token-anchor", outcome: "HOME", score: 64, price: 0.41 });
  const sibling = scoredRow({ id: SIBLING_ID, token: "token-sibling", outcome: "AWAY", score: 63, price: 0.59 });

  const plan = await buildReservationPlan(PLANNING_NOW, {
    selectorMode: "CONTRACT_A_PLANNING_V1",
    fetchSourceRows: async () => [anchor],
  });
  assert.equal(plan.reservations.length, 1);
  assert.equal(plan.reservations[0].physical_event_id, PHYSICAL_EVENT_ID);
  assert.equal(plan.reservations[0].diagnostics.allocation_policy_id, "LIVE_RESERVATION_ALLOCATION_V1");

  const stored: NightEventReservationRow[] = [];
  const reservationRepo: ReservationRepoPort = {
    async findByPlanRunId(planRunId) { return stored.filter((row) => row.plan_run_id === planRunId); },
    async findByPhysicalEventId(id) { return stored.find((row) => row.physical_event_id === id) ?? null; },
    async deleteByPlanRunId() { stored.length = 0; },
    async insert(rows) {
      for (const row of rows) {
        const serialized = JSON.parse(JSON.stringify(row)) as NightEventReservationRow;
        serialized.id = "00000000-0000-4000-8000-000000009999";
        serialized.event_start_iso = serialized.event_start_iso.replace(/Z$/, "+00:00");
        serialized.game_start_iso = serialized.game_start_iso.replace(/Z$/, "+00:00");
        stored.push(serialized);
      }
    },
  };
  const persisted = await persistReservationPlan(plan, {}, reservationRepo);
  assert.equal(persisted.written_count, 1);
  const reloaded = (await reservationRepo.findByPlanRunId(plan.plan_run_id))[0];
  assert.equal(Date.parse(reloaded.event_start_iso), Date.parse(EVENT_START));
  assert.equal(reloaded.physical_event_id, PHYSICAL_EVENT_ID);
  const lineage = reloaded.diagnostics.source_lineage as Record<string, unknown>;
  assert.equal(lineage.provider_event_id, PROVIDER_EVENT_ID);
  assert.equal(lineage.generated_signal_pair_id, ANCHOR_ID);

  const signalPairs = new GeneratedSignalPairsTable();
  signalPairs.insertAll([anchor, sibling]);
  const queue: EventExecutionQueueRow[] = [];
  const rebalanceRepo: RebalanceRepoPort = {
    async loadActiveReservations() { return [reloaded]; },
    async loadQueuedReservationIds() {
      return new Set(queue.map((row) => row.reservation_id).filter((id): id is string => id !== null));
    },
    async markReservationsExpired() {},
    async markReservationSkipped() { throw new Error("preflight Reservation must not skip"); },
    async markReservationQueued() {},
    async insertQueueRow(row) { queue.push(JSON.parse(JSON.stringify(row)) as EventExecutionQueueRow); },
  };
  const deps = {
    repo: rebalanceRepo,
    fetchFinalIdentitySourceRows: (reservation: NightEventReservationRow) =>
      loadExactProviderSiblingRowsFromAnchor(
        reservation,
        (id) => signalPairs.queryById(id),
        (identity) => signalPairs.queryByProviderEvent(identity),
      ),
  };

  const first = await runEventRebalance(T70_NOW, { write: true }, deps);
  assert.equal(first.queued_count, 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].reservation_id, reloaded.id);
  assert.equal(queue[0].condition_id, CONDITION_ID);
  assert.equal(queue[0].token_id, "token-anchor");
  assert.equal(queue[0].side, "HOME");
  assert.equal(queue[0].score, 64);
  assert.equal((queue[0].diagnostics as Record<string, unknown>).max_entry_price, 0.41);
  assert.ok(queue[0].idempotency_key);

  const second = await runEventRebalance(T70_NOW + 60_000, { write: true }, deps);
  assert.equal(second.already_queued_count, 1);
  assert.equal(second.queued_count, 0);
  assert.equal(queue.length, 1);
});
