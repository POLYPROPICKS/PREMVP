// Contur3 PREMVP READY Queue deadline-expiry sweep tests
//   node --import tsx --test tests/contur3/eventExecutionQueue.readyQueueDeadlineExpiry.test.ts
//
// Proves the PREMVP-owned READY -> EXPIRED lifecycle:
//   * READY past latest_entry_iso with no order evidence -> EXPIRED + audit
//   * READY still inside its window                       -> untouched
//   * READY past window WITH executor_order_events evidence -> protected
//   * CLAIMED / SENT / terminal rows past window          -> never touched
//   * the sweep is invoked automatically from runEventRebalance, BEFORE the
//     active-Queue blocking/dedupe population (loadQueuedReservationIds)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planReadyQueueDeadlineExpiry,
  sweepExpiredReadyQueueRows,
  runEventRebalance,
  READY_QUEUE_EXPIRY_REASON,
  type RebalanceRepoPort,
  type ReadyQueueExpiryPlanEntry,
} from "../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow, NightEventReservationRow, QueueStatus } from "../../lib/executor/executorQueueTypes";

const NOW_ISO = "2026-08-29T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const PAST_ISO = "2026-08-29T11:00:00.000Z"; // latest_entry already passed
const FUTURE_ISO = "2026-08-29T13:00:00.000Z"; // latest_entry still ahead
const RUN_ID = "rebalance:2026-08-29T12:00:00Z";

function queueRow(overrides: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    id: overrides.id ?? "q-1",
    reservation_id: "res-1",
    plan_run_id: "plan-1",
    rebalance_run_id: "rb-old",
    match_family_key: "pair:a-vs-b:2026-08-29",
    event_title: "A vs B",
    event_slug: "a-vs-b",
    sport: "soccer",
    league: null,
    game_start_iso: "2026-08-29T12:10:00.000Z",
    condition_id: "cond-1",
    token_id: "tok-1",
    side: "A",
    market_slug: "a-vs-b-ml",
    market_title: "a-vs-b-ml",
    market_family: null,
    score: 80,
    coverage: null,
    tier: "TIER1",
    stake_usd: 1.1,
    preferred_entry_iso: "2026-08-29T10:00:00.000Z",
    latest_entry_iso: PAST_ISO,
    selection_rank: 1,
    selection_reason: "REBALANCE_SINGLE_BEST_MARKET",
    status: "READY",
    order_key: "cond-1:tok-1:A",
    idempotency_key: "idem-1",
    diagnostics: { max_entry_price: 0.6 },
    ...overrides,
  };
}

// ── pure planner ───────────────────────────────────────────────────────────

test("READY past latest_entry_iso with no order evidence is planned for EXPIRED with an auditable reason", () => {
  const rows = [queueRow({ id: "q-past", latest_entry_iso: PAST_ISO })];
  const plan = planReadyQueueDeadlineExpiry(rows, NOW_MS, new Set(), RUN_ID);
  assert.equal(plan.expired_count, 1);
  assert.equal(plan.expired_entries[0].id, "q-past");
  const diag = plan.expired_entries[0].diagnostics.premvp_deadline_expiry as Record<string, unknown>;
  assert.equal(diag.reason, READY_QUEUE_EXPIRY_REASON);
  assert.equal(diag.reason, "LATEST_ENTRY_WINDOW_PASSED");
  assert.equal(diag.rebalance_run_id, RUN_ID);
  assert.equal(diag.order_evidence_present, false);
  assert.equal(diag.previous_status, "READY");
  assert.equal(diag.latest_entry_iso, PAST_ISO);
  // original diagnostics preserved
  assert.equal((plan.expired_entries[0].diagnostics as Record<string, unknown>).max_entry_price, 0.6);
});

test("READY still inside its entry window is left READY", () => {
  const rows = [queueRow({ id: "q-future", latest_entry_iso: FUTURE_ISO })];
  const plan = planReadyQueueDeadlineExpiry(rows, NOW_MS, new Set(), RUN_ID);
  assert.equal(plan.expired_count, 0);
  assert.equal(plan.skipped_deadline_not_passed_count, 1);
});

test("READY past window WITH matching order evidence is NOT expired", () => {
  const rows = [queueRow({ id: "q-executed", latest_entry_iso: PAST_ISO })];
  const plan = planReadyQueueDeadlineExpiry(rows, NOW_MS, new Set(["q-executed"]), RUN_ID);
  assert.equal(plan.expired_count, 0);
  assert.equal(plan.protected_by_order_evidence_count, 1);
});

test("CLAIMED / SENT / terminal rows past window are never planned for expiry", () => {
  const statuses: QueueStatus[] = ["CLAIMED", "SENT", "EXECUTED", "FAILED", "SKIPPED", "EXPIRED", "CANCELLED"];
  const rows = statuses.map((status, i) => queueRow({ id: `q-${status}-${i}`, status, latest_entry_iso: PAST_ISO }));
  const plan = planReadyQueueDeadlineExpiry(rows, NOW_MS, new Set(), RUN_ID);
  assert.equal(plan.expired_count, 0);
  assert.equal(plan.skipped_non_ready_count, statuses.length);
});

// ── sweep orchestration against a fake repo ────────────────────────────────

function makeSweepRepo(rows: EventExecutionQueueRow[], evidenceIds: Set<string> = new Set()) {
  const store = rows.map((r) => ({ ...r }));
  const calls: string[] = [];
  const repo: RebalanceRepoPort = {
    async loadActiveReservations() { return []; },
    async loadQueuedReservationIds() {
      calls.push("loadQueuedReservationIds");
      return new Set(store.filter((r) => ["READY", "CLAIMED", "SENT"].includes(r.status)).map((r) => r.reservation_id).filter((v): v is string => Boolean(v)));
    },
    async markReservationsExpired() {},
    async markReservationSkipped() {},
    async insertQueueRow() {},
    async markReservationQueued() {},
    async loadDeadlinePassedReadyQueueRows(nowIso) {
      calls.push("loadDeadlinePassedReadyQueueRows");
      return store.filter((r) => r.status === "READY" && Date.parse(r.latest_entry_iso) < Date.parse(nowIso)).map((r) => ({ ...r }));
    },
    async hasExecutorOrderEventEvidence(row) {
      calls.push("hasExecutorOrderEventEvidence");
      return Boolean(row.id && evidenceIds.has(row.id));
    },
    async markReadyQueueRowsExpired(entries: ReadyQueueExpiryPlanEntry[]) {
      calls.push("markReadyQueueRowsExpired");
      for (const entry of entries) {
        const target = store.find((r) => r.id === entry.id && r.status === "READY");
        if (target) {
          target.status = "EXPIRED";
          target.selection_reason = READY_QUEUE_EXPIRY_REASON;
          target.diagnostics = entry.diagnostics;
        }
      }
    },
  };
  return { repo, store, calls };
}

test("sweep in write mode transitions eligible READY rows to EXPIRED and records the reason", async () => {
  const { repo, store } = makeSweepRepo([
    queueRow({ id: "q-past", latest_entry_iso: PAST_ISO }),
    queueRow({ id: "q-future", latest_entry_iso: FUTURE_ISO }),
    queueRow({ id: "q-claimed", status: "CLAIMED", latest_entry_iso: PAST_ISO }),
    queueRow({ id: "q-sent", status: "SENT", latest_entry_iso: PAST_ISO }),
  ]);
  const result = await sweepExpiredReadyQueueRows(repo, NOW_MS, RUN_ID, { write: true });
  assert.equal(result.expired_count, 1);
  assert.equal(result.wrote, true);
  assert.equal(store.find((r) => r.id === "q-past")!.status, "EXPIRED");
  assert.equal(store.find((r) => r.id === "q-past")!.selection_reason, "LATEST_ENTRY_WINDOW_PASSED");
  assert.equal(store.find((r) => r.id === "q-future")!.status, "READY");
  assert.equal(store.find((r) => r.id === "q-claimed")!.status, "CLAIMED");
  assert.equal(store.find((r) => r.id === "q-sent")!.status, "SENT");
});

test("sweep in dry-run mode writes nothing", async () => {
  const { repo, store } = makeSweepRepo([queueRow({ id: "q-past", latest_entry_iso: PAST_ISO })]);
  const result = await sweepExpiredReadyQueueRows(repo, NOW_MS, RUN_ID, { write: false });
  assert.equal(result.expired_count, 1);
  assert.equal(result.wrote, false);
  assert.equal(store.find((r) => r.id === "q-past")!.status, "READY");
});

test("sweep protects a deadline-passed READY row that already has executor_order_events evidence", async () => {
  const { repo, store } = makeSweepRepo(
    [queueRow({ id: "q-executed", latest_entry_iso: PAST_ISO })],
    new Set(["q-executed"]),
  );
  const result = await sweepExpiredReadyQueueRows(repo, NOW_MS, RUN_ID, { write: true });
  assert.equal(result.expired_count, 0);
  assert.equal(result.protected_by_order_evidence_count, 1);
  assert.equal(store.find((r) => r.id === "q-executed")!.status, "READY");
});

test("sweep no-ops silently for a repo without the deadline-sweep methods", async () => {
  const legacyRepo: RebalanceRepoPort = {
    async loadActiveReservations() { return []; },
    async loadQueuedReservationIds() { return new Set(); },
    async markReservationsExpired() {},
    async markReservationSkipped() {},
    async insertQueueRow() {},
    async markReservationQueued() {},
  };
  const result = await sweepExpiredReadyQueueRows(legacyRepo, NOW_MS, RUN_ID, { write: true });
  assert.equal(result.scanned, 0);
  assert.equal(result.expired_count, 0);
});

// ── lifecycle integration ─────────────────────────────────────────────────

function reservation(overrides: Partial<NightEventReservationRow> = {}): NightEventReservationRow {
  return {
    id: "res-due",
    plan_run_id: "plan-1",
    plan_date_minsk: "2026-08-29",
    window_start_iso: "2026-08-29T00:00:00.000Z",
    window_end_iso: "2026-08-30T00:00:00.000Z",
    match_family_key: "pair:c-vs-d:2026-08-29",
    event_slug: "c-vs-d",
    event_title: "C vs D",
    sport: "soccer",
    league: null,
    strategic_scope: "WC",
    game_start_iso: "2026-08-29T12:40:00.000Z", // T-40m from NOW -> inside T-70..T-3 window
    event_tier: "TIER1",
    event_score: 80,
    best_snapshot_id: null,
    reservation_rank: 1,
    status: "RESERVED",
    selection_reason: null,
    diagnostics: {},
    ...overrides,
  };
}

test("runEventRebalance invokes the READY sweep automatically, BEFORE the Queue dedupe population", async () => {
  const { repo, store, calls } = makeSweepRepo([
    queueRow({ id: "q-stale", reservation_id: "res-old", latest_entry_iso: PAST_ISO }),
  ]);
  repo.loadActiveReservations = async () => [reservation()];

  const result = await runEventRebalance(NOW_MS, { write: true }, { repo });

  // sweep ran and expired the stale READY row
  assert.equal(result.ready_queue_expiry?.expired_count, 1);
  assert.equal(store.find((r) => r.id === "q-stale")!.status, "EXPIRED");

  // ordering: the expiry write happened before the blocking/dedupe population
  const idxExpiry = calls.indexOf("markReadyQueueRowsExpired");
  const idxDedupe = calls.indexOf("loadQueuedReservationIds");
  assert.ok(idxExpiry >= 0, "expiry write must have run");
  assert.ok(idxDedupe >= 0, "dedupe population must have run");
  assert.ok(idxExpiry < idxDedupe, "READY expiry must precede the active-Queue dedupe population");
});

test("canary identity-targeted rebalance does not run the global READY sweep", async () => {
  const { repo, calls } = makeSweepRepo([queueRow({ id: "q-stale", latest_entry_iso: PAST_ISO })]);
  repo.loadActiveReservations = async () => [reservation()];
  const result = await runEventRebalance(NOW_MS, { write: true, targetReservationId: "res-due" }, { repo });
  assert.equal(result.ready_queue_expiry, undefined);
  assert.equal(calls.includes("markReadyQueueRowsExpired"), false);
});
