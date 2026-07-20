// Contur3 complete funnel regression (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Exercises the REAL end-to-end orchestration:
//   planning-eligible generated_signal_pairs candidates (injected fake, at the
//   exact boundary buildFireModelCandidates normally reads from)
//   -> runReservationCronWithEvidence (real buildReservationPlan + persistReservationPlan)
//   -> runEventRebalanceWithEvidence at a simulated T-60 tick (real runEventRebalance)
//   -> one canonical READY event_execution_queue row.
//
// No live Supabase, no network, no callbacks, no CLOB orders, no Ireland calls
// -- this module never imports or reaches any of those surfaces.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runReservationCronWithEvidence, type ReservationRepoPort } from "../../lib/executor/nightEventReservations";
import { runEventRebalanceWithEvidence, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import type { SchedulerJobEvidencePort, SchedulerJobRunInput } from "../../lib/executor/schedulerJobEvidence";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

// 17:00 Minsk = 14:00Z, canonical reservation anchor.
const RESERVATION_NOW_MS = Date.parse("2026-07-19T14:00:00.000Z");
const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
// T-60m from a 19:00Z kickoff, inside the T-70..T-3 rebalance window.
const REBALANCE_NOW_MS = Date.parse("2026-07-19T18:00:00.000Z");

function esaCandidate(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return {
    signal_id: "sig-esp-arg",
    strategy: "TIER1_CORE_STRICT_72_COV50",
    market_slug: "spain-vs-argentina-moneyline",
    match_family_key: "pair:argentina-vs-spain:2026-07-19",
    match_family_key_source: "event_slug",
    match_family_key_is_weak: false,
    event_slug: "fifwc-esp-arg-2026-07-19",
    condition_id: "cond-esp-arg",
    token_id: "token-esp-arg-spain",
    side: "Spain",
    selected_outcome: "Spain",
    inferred_sport: "soccer",
    market_family: "allowed_fullmatch_moneyline",
    strategic_scope: "WC",
    timing_bucket: "T_2_6H",
    identity_quality: "STRONG",
    identity_warning_codes: [],
    canonical_event_key: "pair:argentina-vs-spain:2026-07-19",
    canonical_market_key: "cond-esp-arg",
    activity_label_detected: false,
    sport_classification_confidence: "HIGH",
    live_eligible: true,
    live_rejection_reason: null,
    side_mapping_status: "PROVEN_BY_TOKEN_ID",
    live_block_reason: null,
    live_policy_version: "v1",
    paper_eligible: true,
    max_entry_price: 0.55,
    stake_usd: 7,
    max_order_usd: 7,
    max_spread: 0.03,
    one_order_only: true,
    executor_mode_allowed: "dry_run_only",
    first_live_test_allowed: true,
    stale_after: KICKOFF_ISO,
    no_trade_after: KICKOFF_ISO,
    idempotency_key: "candidate-idem-esp-arg",
    model_rule_id: "v1:P0C_DRAWDOWN_PROTECT_STAKE_GUARD_V1",
    created_at: "2026-07-19T12:00:00.000Z",
    source: "FireModel1_private_executor_2026_06_15",
    diagnostics: {
      executor_action: "BET_OR_PAPER_GO",
      paper_only: false,
      real_trade: false,
      score: 80,
      coverage: 60,
      smart_money: null,
      entry_price: 0.5,
      game_start_iso: KICKOFF_ISO,
      hours_to_start_now: 5,
      fire_model_alias: "FireModel1",
      version: "v2-lite-growth-safe",
    },
    ...overrides,
  } as FireModelCandidate;
}

let nextReservationId = 1;

function makeReservationRepo(): ReservationRepoPort & { store: NightEventReservationRow[] } {
  const store: NightEventReservationRow[] = [];
  return {
    store,
    async findByPlanRunId(planRunId) {
      return store.filter((r) => r.plan_run_id === planRunId);
    },
    async deleteByPlanRunId(planRunId) {
      for (let i = store.length - 1; i >= 0; i--) if (store[i].plan_run_id === planRunId) store.splice(i, 1);
    },
    async insert(rows) {
      // Simulate DB-assigned primary key, matching Supabase's gen_random_uuid() default.
      for (const row of rows) store.push({ ...row, id: row.id ?? `res-${nextReservationId++}` });
    },
  };
}

let nextQueueId = 1;

function makeRebalanceRepo(reservationStore: NightEventReservationRow[]): RebalanceRepoPort & { queueRows: EventExecutionQueueRow[] } {
  const queueRows: EventExecutionQueueRow[] = [];
  const queuedReservationIds = new Set<string>();
  return {
    queueRows,
    async loadActiveReservations() {
      return reservationStore.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING");
    },
    async loadQueuedReservationIds() {
      return new Set(queuedReservationIds);
    },
    async markReservationsExpired(ids) {
      for (const r of reservationStore) if (ids.includes(r.id as string)) r.status = "EXPIRED";
    },
    async markReservationSkipped(id, reason) {
      const r = reservationStore.find((x) => x.id === id);
      if (r) { r.status = "SKIPPED"; r.selection_reason = reason; }
    },
    async insertQueueRow(row) {
      // Simulate DB-assigned primary key, matching Supabase's gen_random_uuid() default.
      const withId: EventExecutionQueueRow = { ...row, id: `queue-${nextQueueId++}` };
      queueRows.push(withId);
      if (row.reservation_id) queuedReservationIds.add(row.reservation_id);
    },
    async markReservationQueued(id, reason) {
      const r = reservationStore.find((x) => x.id === id);
      if (r) { r.status = "QUEUED"; r.selection_reason = reason; }
    },
  };
}

function makeJobEvidence(): SchedulerJobEvidencePort & { calls: SchedulerJobRunInput[] } {
  const calls: SchedulerJobRunInput[] = [];
  return { calls, async writeJobRun(input) { calls.push(input); } };
}

test("C1: full funnel -- planning-eligible candidate -> reservation -> T-60 rebalance -> one canonical READY queue row", async () => {
  const candidates = [esaCandidate()];
  const fetchCandidates = async () => ({ candidates });

  const reservationRepo = makeReservationRepo();
  const reservationJobEvidence = makeJobEvidence();

  // Stage 1: reservation run at 17:00 Minsk anchor.
  const { plan, persisted } = await runReservationCronWithEvidence(
    RESERVATION_NOW_MS,
    {},
    { fetchCandidates, repo: reservationRepo, jobEvidence: reservationJobEvidence }
  );
  assert.equal(persisted.written_count, 1);
  assert.equal(plan.reservations[0].status, "RESERVED");
  assert.equal(reservationJobEvidence.calls.length, 1);
  assert.equal(reservationJobEvidence.calls[0].status, "success");

  // Stage 2: rebalance tick at T-60, using the persisted reservation store as the
  // live reservation table and the SAME candidate universe as the live market read.
  const rebalanceRepo = makeRebalanceRepo(reservationRepo.store);
  const rebalanceJobEvidence = makeJobEvidence();
  const rebalanceResult = await runEventRebalanceWithEvidence(
    REBALANCE_NOW_MS,
    { write: true },
    { repo: rebalanceRepo, fetchCandidates, jobEvidence: rebalanceJobEvidence }
  );

  assert.equal(rebalanceResult.due_count, 1);
  assert.equal(rebalanceResult.queued_count, 1);
  assert.equal(rebalanceRepo.queueRows.length, 1);
  assert.equal(rebalanceJobEvidence.calls.length, 1);
  assert.equal(rebalanceJobEvidence.calls[0].status, "success");
  assert.equal(rebalanceJobEvidence.calls[0].source, "event-rebalance");

  const row = rebalanceRepo.queueRows[0];

  // Full canonical queue-row contract.
  assert.ok(row.id, "queue row must have an id");
  assert.ok(row.idempotency_key, "queue row must have an idempotency_key");
  assert.equal(row.condition_id, "cond-esp-arg");
  assert.equal(row.token_id, "token-esp-arg-spain");
  assert.equal(row.side, "Spain");
  assert.equal(row.stake_usd, 7);
  assert.equal((row.diagnostics as Record<string, unknown>).max_entry_price, 0.55);
  assert.ok(row.preferred_entry_iso, "queue row must have preferred_entry_iso");
  assert.ok(row.latest_entry_iso, "queue row must have latest_entry_iso");
  assert.equal(row.status, "READY");

  // Reservation is now QUEUED (not left RESERVED), so the plan_run_id is idempotently closed.
  assert.equal(reservationRepo.store[0].status, "QUEUED");
});

test("C2: full funnel performs zero callbacks, zero CLOB orders, zero Ireland calls -- this module reaches no network/order surface", async () => {
  // Static proof: neither lib/executor/nightEventReservations.ts nor
  // lib/executor/eventExecutionQueue.ts imports anything from the callback,
  // CLOB, or Ireland-facing surfaces. Runtime proof: the fake repos/candidate
  // fetchers used above are the ONLY I/O boundary exercised end-to-end, and
  // none of them make an HTTP call or touch an order-placement API.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const root = process.cwd();
  for (const rel of ["lib/executor/nightEventReservations.ts", "lib/executor/eventExecutionQueue.ts"]) {
    const source = readFileSync(path.join(root, rel), "utf8");
    assert.doesNotMatch(source, /clob|placeOrder|submitOrder|order-events|queue\/mark/i);
  }
});

test("C3: rerunning the full funnel for the same plan_run_id + reservation is idempotent end-to-end (no duplicate reservation or queue row)", async () => {
  const candidates = [esaCandidate()];
  const fetchCandidates = async () => ({ candidates });
  const reservationRepo = makeReservationRepo();
  const jobEvidence1 = makeJobEvidence();

  await runReservationCronWithEvidence(RESERVATION_NOW_MS, {}, { fetchCandidates, repo: reservationRepo, jobEvidence: jobEvidence1 });
  // Second reservation cron tick for the same plan_run_id (e.g. cron retry).
  const second = await runReservationCronWithEvidence(RESERVATION_NOW_MS, {}, { fetchCandidates, repo: reservationRepo, jobEvidence: jobEvidence1 });
  assert.equal(second.persisted.already_exists, true);
  assert.equal(reservationRepo.store.length, 1);

  const rebalanceRepo = makeRebalanceRepo(reservationRepo.store);
  const jobEvidence2 = makeJobEvidence();
  await runEventRebalanceWithEvidence(REBALANCE_NOW_MS, { write: true }, { repo: rebalanceRepo, fetchCandidates, jobEvidence: jobEvidence2 });
  // Second rebalance tick a minute later, same due reservation set (now QUEUED, so
  // loadActiveReservations no longer returns it -- but re-run anyway to prove no crash/dup).
  await runEventRebalanceWithEvidence(REBALANCE_NOW_MS + 60_000, { write: true }, { repo: rebalanceRepo, fetchCandidates, jobEvidence: jobEvidence2 });

  assert.equal(rebalanceRepo.queueRows.length, 1, "must not create a second queue row across repeated rebalance ticks");
});
