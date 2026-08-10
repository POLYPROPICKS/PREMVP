import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import {
  ACTIVE_REBALANCE_RESERVATION_STATUSES,
  classifyActiveReservationDue,
  isActiveReservationForRebalance,
} from "../../lib/executor/reservationRebalanceContract.mjs";

const START = "2026-08-06T18:00:00.000Z";
const NOW = Date.parse("2026-08-06T17:00:00.000Z");
const EVENT_ID = "exact-event-17";
const PHYSICAL_ID = "provider:polymarket:exact-event-17:2026-08-06";

function row(id: string, score: number, conditionId: string, extra: Record<string, unknown> = {}) {
  return {
    id, condition_id: conditionId, selected_token_id: `token-${conditionId}`, selected_outcome: "YES",
    // Real production carriers only. `score`/`stake_usd`/`max_entry_price` are
    // not columns on generated_signal_pairs and must never appear in a fixture.
    signal_confidence_num: score, entry_price_num: 0.62,
    metric_formula_version: "shadow-firemodel1_1_research_v0",
    market_slug: `market-${conditionId}`,
    diagnostics: { providerEventContext: { v: "v1", provider: "polymarket", eventId: EVENT_ID, eventStartIso: START }, ...extra },
  };
}

function reservation(): NightEventReservationRow {
  return {
    id: "reservation-minimal", physical_event_id: PHYSICAL_ID, event_start_iso: START,
    plan_run_id: "night-plan:2026-08-06:1700-minsk", plan_date_minsk: "2026-08-06",
    window_start_iso: "2026-08-06T14:00:00.000Z", window_end_iso: "2026-08-07T05:00:00.000Z",
    match_family_key: PHYSICAL_ID, event_slug: null, event_title: null, sport: "esports", league: null,
    strategic_scope: "ESPORT", game_start_iso: START, event_tier: "TIER1", event_score: 71,
    best_snapshot_id: "pair-anchor", reservation_rank: 1, status: "RESERVED", selection_reason: null,
    diagnostics: { contract_a_stage: "PLANNING", source_lineage: { generated_signal_pair_id: "pair-anchor" } },
  };
}

test("minimal due path selects max signal_score with stable exact-ID tie-break and creates one Queue row", async () => {
  const r = reservation();
  const rows = [row("pair-low", 12, "cond-low"), row("pair-b", 91, "cond-b"), row("pair-a", 91, "cond-a"),
    { ...row("other-event", 99, "cond-other"), diagnostics: { providerEventContext: { v: "v1", provider: "polymarket", eventId: "other", eventStartIso: START } } }];
  const queue: EventExecutionQueueRow[] = [];
  const repo: RebalanceRepoPort = {
    async loadActiveReservations() { return [r]; },
    async loadQueuedReservationIds() { return new Set(queue.map((q) => q.reservation_id).filter((v): v is string => v !== null)); },
    async markReservationsExpired() {}, async markReservationSkipped() {}, async markReservationQueued() {},
    async insertQueueRow(value) { queue.push(value); },
  };
  const deps = {
    repo,
    fetchFinalIdentitySourceRows: async () => rows,
    fetchCandidates: async () => { throw new Error("broad/model candidates must not be called in due write path"); },
  };
  const first = await runEventRebalance(NOW, { write: true }, deps);
  assert.equal(first.queued_count, 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].condition_id, "cond-a", "tie-break is condition_id, then token/side/id");
  assert.equal(queue[0].score, 91);
  assert.equal((queue[0].diagnostics as Record<string, unknown>).selected_signal_pair_id, "pair-a");
  const second = await runEventRebalance(NOW, { write: true }, deps);
  assert.equal(second.queued_count, 0);
  assert.equal(second.already_queued_count, 1);
  assert.equal(queue.length, 1);
});

test("PostgreSQL-equivalent identical idempotency conflict returns ALREADY_QUEUED", async () => {
  const r = reservation();
  const existing: EventExecutionQueueRow[] = [];
  const repo: RebalanceRepoPort = {
    async loadActiveReservations() { return [r]; }, async loadQueuedReservationIds() { return new Set(); },
    async markReservationsExpired() {}, async markReservationSkipped() {}, async markReservationQueued() {},
    async insertQueueRow(value) { existing.push(value); const e = new Error("duplicate") as Error & { code: string }; e.code = "23505"; throw e; },
    async findQueueRowsByIdempotencyKey() { return existing; },
  };
  const result = await runEventRebalance(NOW, { write: true }, { repo, fetchFinalIdentitySourceRows: async () => [row("pair-a", 80, "cond-a")] });
  assert.equal(result.already_queued_count, 1);
  assert.equal(result.outcomes[0]?.reason, "IDEMPOTENCY_CONFLICT_RECOVERED");
});

test("persisted lifecycle parity: one frozen UTC asOf gives the same active/due set to audit and real entry", async () => {
  const active = reservation();
  const terminal = { ...reservation(), id: "reservation-terminal", status: "SKIPPED" as const, selection_reason: "EXACT_PROVIDER_EVENT_IDENTITY_MISSING" };
  const expired = { ...reservation(), id: "reservation-expired", game_start_iso: "2026-08-06T17:02:00.000Z", event_start_iso: "2026-08-06T17:02:00.000Z" };
  const persisted = [active, terminal, expired];
  const activeRows = persisted.filter((r) => isActiveReservationForRebalance(r.status));
  assert.deepEqual(ACTIVE_REBALANCE_RESERVATION_STATUSES, ["RESERVED", "REBALANCE_PENDING"]);
  assert.equal(classifyActiveReservationDue(active, NOW).state, "DUE_NOW");
  assert.equal(classifyActiveReservationDue(terminal, NOW).state, "DUE_NOW", "timing alone never reactivates a terminal row");
  assert.equal(classifyActiveReservationDue(expired, NOW).state, "EXPIRED");
  assert.deepEqual(activeRows.map((r) => r.id), ["reservation-minimal", "reservation-expired"]);

  const queue: EventExecutionQueueRow[] = [];
  const repo: RebalanceRepoPort = {
    async loadActiveReservations() { return activeRows; },
    async loadQueuedReservationIds() { return new Set<string>(); },
    async markReservationsExpired() {}, async markReservationSkipped() {}, async markReservationQueued() {},
    async insertQueueRow(value) { queue.push(value); },
  };
  const result = await runEventRebalance(NOW, { write: true }, {
    repo,
    fetchFinalIdentitySourceRows: async () => [row("pair-low", 22, "cond-low"), row("pair-high", 91, "cond-high")],
    fetchCandidates: async () => { throw new Error("model/Contract A/order-book path must not run"); },
  });
  assert.equal(result.active_reservations_count, 2);
  assert.equal(result.due_count, 1);
  assert.equal(result.expired_count, 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].condition_id, "cond-high");

  const auditSource = readFileSync("scripts/contur3/funnel-trace-audit.mjs", "utf8");
  assert.match(auditSource, /ACTIVE_REBALANCE_RESERVATION_STATUSES/);
  assert.match(auditSource, /\.in\('status', ACTIVE_REBALANCE_RESERVATION_STATUSES\)/);
  assert.match(auditSource, /classifyActiveReservationDue/);
  assert.doesNotMatch(auditSource, /function classifyDueWindowState/);
});
