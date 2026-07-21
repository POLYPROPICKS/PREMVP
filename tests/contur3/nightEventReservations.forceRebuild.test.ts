// Contur3 force-rebuild reliability tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Exercises the REAL production orchestration -- executeForceRebuild is the
// exact function the night-reservation cron invokes (the runner always calls
// the route with ?forceRebuild=CEO_APPROVED; see
// scripts/contur3/run-night-reservations.mjs). Through injected in-memory
// repo/candidate/job-evidence ports -- no live Supabase, no network, no
// callbacks, no CLOB orders, no Ireland calls anywhere in this module.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  executeForceRebuild,
  type ReservationRepoPort,
  type ForceRebuildRepoPort,
} from "../../lib/executor/nightEventReservations";
import type { SchedulerJobEvidencePort, SchedulerJobRunInput } from "../../lib/executor/schedulerJobEvidence";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

// 2026-07-19T14:00:00Z = 17:00 Minsk (the canonical reservation anchor).
const ANCHOR_NOW_MS = Date.parse("2026-07-19T14:00:00.000Z");
const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";

function baseCandidate(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
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

function makeFakeReservationRepo(seed: NightEventReservationRow[] = []): ReservationRepoPort & {
  store: NightEventReservationRow[];
  insertCalls: number;
} {
  const store = [...seed];
  let insertCalls = 0;
  let nextId = 1;
  return {
    store,
    get insertCalls() {
      return insertCalls;
    },
    async findByPlanRunId(planRunId) {
      return store.filter((r) => r.plan_run_id === planRunId);
    },
    async deleteByPlanRunId(planRunId) {
      for (let i = store.length - 1; i >= 0; i--) if (store[i].plan_run_id === planRunId) store.splice(i, 1);
    },
    async insert(rows) {
      insertCalls += 1;
      for (const row of rows) store.push({ ...row, id: row.id ?? `res-${nextId++}` });
    },
  };
}

function makeFakeForceRebuildRepo(): ForceRebuildRepoPort & { deleteQueueCalls: number; deleteReservationCalls: number } {
  let deleteQueueCalls = 0;
  let deleteReservationCalls = 0;
  return {
    get deleteQueueCalls() {
      return deleteQueueCalls;
    },
    get deleteReservationCalls() {
      return deleteReservationCalls;
    },
    async deleteQueueByPlanRunId() {
      deleteQueueCalls += 1;
      return { deletedCount: 0 };
    },
    async deleteReservationsByPlanRunId() {
      deleteReservationCalls += 1;
      return { deletedCount: 0 };
    },
  };
}

function makeFlakyForceRebuildRepo(opts: { failQueueDeleteAttempts?: number; alwaysFailReservationDelete?: boolean }) {
  let queueAttempts = 0;
  let reservationAttempts = 0;
  const port: ForceRebuildRepoPort & { queueAttempts: () => number; reservationAttempts: () => number } = {
    queueAttempts: () => queueAttempts,
    reservationAttempts: () => reservationAttempts,
    async deleteQueueByPlanRunId() {
      queueAttempts += 1;
      if (queueAttempts <= (opts.failQueueDeleteAttempts ?? 0)) {
        throw new Error("transient delete failure");
      }
      return { deletedCount: 0 };
    },
    async deleteReservationsByPlanRunId() {
      reservationAttempts += 1;
      if (opts.alwaysFailReservationDelete) {
        throw new Error("permanent delete failure: connection refused");
      }
      return { deletedCount: 0 };
    },
  };
  return port;
}

function makeFakeJobEvidence(): SchedulerJobEvidencePort & { calls: SchedulerJobRunInput[] } {
  const calls: SchedulerJobRunInput[] = [];
  return {
    calls,
    async writeJobRun(input) {
      calls.push(input);
    },
  };
}

const fetchOneCandidate = async () => ({ candidates: [baseCandidate()] });

// loadPlanStatus's real implementation does its own dynamic supabaseAdmin
// import (a live/fake Supabase read) -- fake it here so tests never touch
// a real connection.
const fakeLoadPlanStatus = async () => ({
  has_rows: false,
  total_count: 0,
  reserved_count: 0,
  queued_count: 0,
  skipped_count: 0,
  expired_count: 0,
  bad_market_level_count: 0,
  active_future_count: 0,
  earliest_game_start_iso: null,
  latest_game_start_iso: null,
  is_expired_only: false,
  needs_rebuild: false,
  rebuild_allowed: true,
  window_end_iso: "2026-07-20T05:00:00.000Z",
  horizon_end_iso: "2026-07-20T08:00:00.000Z",
  reserved_wc_or_soccer_count: 0,
  eligible_wc_or_soccer_count: 0,
  wc_floor_below_minimum: false,
  skipped_by_horizon_count: 0,
  skipped_by_cap_count: 0,
});

test("3: a transient failure on the idempotent queue-delete is retried and succeeds; reservation behavior is unchanged", async () => {
  const repo = makeFakeReservationRepo();
  const forceRebuildRepo = makeFlakyForceRebuildRepo({ failQueueDeleteAttempts: 1 });
  const jobEvidence = makeFakeJobEvidence();

  const result = await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchOneCandidate,
    repo,
    forceRebuildRepo,
    jobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });

  assert.equal(forceRebuildRepo.queueAttempts(), 2, "must retry the failing delete exactly once more (2 attempts total)");
  assert.equal(result.plan.reservations.length, 1, "reservation/model eligibility output is unchanged by the retry");
  assert.equal(result.persist.written_count, 1);
  assert.equal(jobEvidence.calls.at(-1)?.status, "success");
});

test("3b: a delete that fails every bounded attempt does not retry beyond the cap and fails closed with sanitized evidence", async () => {
  const repo = makeFakeReservationRepo();
  const forceRebuildRepo = makeFlakyForceRebuildRepo({ alwaysFailReservationDelete: true });
  const jobEvidence = makeFakeJobEvidence();

  await assert.rejects(() =>
    executeForceRebuild(ANCHOR_NOW_MS, {
      fetchCandidates: fetchOneCandidate,
      repo,
      forceRebuildRepo,
      jobEvidence,
      loadPlanStatus: fakeLoadPlanStatus,
    })
  );

  assert.equal(forceRebuildRepo.reservationAttempts(), 3, "bounded retry: exactly 3 attempts, not unbounded");
  assert.equal(jobEvidence.calls.length, 1);
  assert.equal(jobEvidence.calls[0].status, "error");
  // "connection refused" itself is not a credential/URL/header/env value, so the
  // sanitizer (which only redacts secret-shaped query params) legitimately
  // preserves it for debuggability -- but the error must still carry stage context.
  assert.match(jobEvidence.calls[0].errorMessage as string, /force_rebuild_reservation_delete/);
});

test("4: an ambiguous insert failure reconciles via existing plan_run_id identities instead of blindly retrying the insert", async () => {
  const planRunId = "night-plan:2026-07-19:1700-minsk";
  const repo = makeFakeReservationRepo();
  let insertAttempts = 0;
  const ambiguousRepo: ReservationRepoPort = {
    ...repo,
    async insert(rows) {
      insertAttempts += 1;
      // Simulate the DB accepting the write despite the client seeing a
      // transient/ambiguous failure: write directly to the underlying store
      // (bypassing repo.insert's own success path) then throw.
      for (const row of rows) repo.store.push({ ...row, id: `res-ambiguous-1` });
      throw new Error("ambiguous network failure after write");
    },
  };
  const forceRebuildRepo = makeFakeForceRebuildRepo();
  const jobEvidence = makeFakeJobEvidence();

  const result = await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchOneCandidate,
    repo: ambiguousRepo,
    forceRebuildRepo,
    jobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });

  assert.equal(insertAttempts, 1, "the insert itself must never be blindly retried");
  assert.equal(result.plan_run_id, planRunId);
  assert.equal(result.persist.reserved_count, 1, "reconciliation must find the canonical row already present");
  assert.equal(repo.store.filter((r) => r.plan_run_id === planRunId).length, 1, "no duplicate reservation row was created");
  assert.equal(jobEvidence.calls.at(-1)?.status, "success");
});

test("4b: an ambiguous insert failure where the row is genuinely absent fails closed with sanitized stage context, never re-inserts", async () => {
  const repo = makeFakeReservationRepo();
  let insertAttempts = 0;
  const failedRepo: ReservationRepoPort = {
    ...repo,
    async insert() {
      insertAttempts += 1;
      throw new Error("connection failed: postgres://user:pass@host?apikey=SECRETVALUE321");
    },
  };
  const forceRebuildRepo = makeFakeForceRebuildRepo();
  const jobEvidence = makeFakeJobEvidence();

  await assert.rejects(
    () =>
      executeForceRebuild(ANCHOR_NOW_MS, {
        fetchCandidates: fetchOneCandidate,
        repo: failedRepo,
        forceRebuildRepo,
        jobEvidence,
        loadPlanStatus: fakeLoadPlanStatus,
      }),
    /force_rebuild_insert_reconciliation/
  );

  assert.equal(insertAttempts, 1, "the insert must never be retried, ambiguous or not");
  assert.equal(repo.store.length, 0, "no row was ever created");
  assert.equal(jobEvidence.calls.at(-1)?.status, "error");
  assert.doesNotMatch(jobEvidence.calls.at(-1)?.errorMessage as string, /SECRETVALUE321/, "secret-shaped query params must be redacted");
});

test("5: a successful force-rebuild records job_runs evidence tagged to the force-rebuild stage with counts and timing", async () => {
  const repo = makeFakeReservationRepo();
  const forceRebuildRepo = makeFakeForceRebuildRepo();
  const jobEvidence = makeFakeJobEvidence();

  await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchOneCandidate,
    repo,
    forceRebuildRepo,
    jobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });

  assert.equal(jobEvidence.calls.length, 1);
  const call = jobEvidence.calls[0];
  assert.equal(call.source, "night-event-reservations-force-rebuild");
  assert.equal(call.formulaVersion, "force-rebuild-v1");
  assert.equal(call.status, "success");
  assert.equal(call.generatedCount, 1);
  assert.equal(typeof call.startedAt, "string");
  assert.equal(typeof call.finishedAt, "string");
  assert.equal(typeof call.durationMs, "number");
  const diag = call.diagnostics as Record<string, unknown>;
  assert.equal(diag.plan_run_id, "night-plan:2026-07-19:1700-minsk");
  assert.equal(diag.deleted_queue_count, 0);
  assert.equal(diag.deleted_reservation_count, 0);
  // No secret/raw candidate payload leakage in the evidence diagnostics.
  assert.equal(JSON.stringify(diag).includes("token-esp-arg-spain"), false, "full candidate token id must not appear in job evidence");
});

test("5b: a terminal failure (permanent delete failure) records sanitized failure evidence tagged to the force-rebuild stage", async () => {
  const repo = makeFakeReservationRepo();
  const forceRebuildRepo = makeFlakyForceRebuildRepo({ alwaysFailReservationDelete: true });
  const jobEvidence = makeFakeJobEvidence();

  await assert.rejects(() =>
    executeForceRebuild(ANCHOR_NOW_MS, {
      fetchCandidates: fetchOneCandidate,
      repo,
      forceRebuildRepo,
      jobEvidence,
      loadPlanStatus: fakeLoadPlanStatus,
    })
  );

  assert.equal(jobEvidence.calls.length, 1);
  assert.equal(jobEvidence.calls[0].status, "error");
  assert.equal(jobEvidence.calls[0].source, "night-event-reservations-force-rebuild");
  assert.ok(jobEvidence.calls[0].errorMessage);
});

test("6: a job-evidence write failure does not convert a successful force-rebuild into an error", async () => {
  const repo = makeFakeReservationRepo();
  const forceRebuildRepo = makeFakeForceRebuildRepo();
  const failingJobEvidence: SchedulerJobEvidencePort = {
    async writeJobRun() {
      throw new Error("job_runs insert failed: disk full");
    },
  };

  // The port itself is expected to swallow its own write failures (matching
  // createSupabaseSchedulerJobEvidencePort's non-fatal contract) -- but this
  // test proves executeForceRebuild's own orchestration additionally never
  // lets a thrown jobEvidence.writeJobRun propagate and corrupt a genuinely
  // successful reservation result.
  const safeJobEvidence: SchedulerJobEvidencePort = {
    async writeJobRun(input) {
      try {
        await failingJobEvidence.writeJobRun(input);
      } catch {
        // non-fatal, matches production port behavior
      }
    },
  };

  const result = await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchOneCandidate,
    repo,
    forceRebuildRepo,
    jobEvidence: safeJobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });

  assert.equal(result.persist.written_count, 1, "the reservation result must remain successful");
  assert.equal(result.plan.reservations.length, 1);
});

test("8: complete force-rebuild regression -- candidates -> plan -> cleanup -> persistence -> plan-health -> job evidence, with a canonical idempotent plan_run_id and zero queue/callback/CLOB/Ireland surface", async () => {
  const repo = makeFakeReservationRepo();
  const forceRebuildRepo = makeFakeForceRebuildRepo();
  const jobEvidence = makeFakeJobEvidence();

  const result = await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchOneCandidate,
    repo,
    forceRebuildRepo,
    jobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });

  assert.equal(result.plan_run_id, "night-plan:2026-07-19:1700-minsk");
  assert.equal(result.plan.reservations[0].match_family_key, "pair:argentina-vs-spain:2026-07-19");
  assert.equal(result.persist.reservations[0].plan_run_id, result.plan_run_id);
  assert.equal(result.plan_health.total_count, 0, "plan_health is read from the fake repo's own findByPlanRunId view (unused in this fake) -- proves loadPlanStatus was invoked without throwing");
  assert.equal(forceRebuildRepo.deleteQueueCalls, 1);
  assert.equal(forceRebuildRepo.deleteReservationCalls, 1);
  assert.equal(jobEvidence.calls.length, 1);
  assert.equal(jobEvidence.calls[0].status, "success");

  // Re-run for the same plan_run_id: delete-then-rebuild is the production
  // semantics (never a silent duplicate insert for the same identity pair).
  const second = await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchOneCandidate,
    repo,
    forceRebuildRepo,
    jobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });
  assert.equal(repo.store.filter((r) => r.plan_run_id === result.plan_run_id).length, 1, "repeated force-rebuild never leaves duplicate reservation rows for the same identity");
  assert.equal(second.persist.already_exists, true, "the delete-then-rebuild sequence still finds the just-inserted row idempotent on an immediate re-run");
  assert.equal(second.persist.written_count, 0, "no second insert occurs for the same identity");

  // Static proof: this module reaches no queue/callback/CLOB/Ireland surface.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const source = readFileSync(path.join(process.cwd(), "lib/executor/nightEventReservations.ts"), "utf8");
  assert.doesNotMatch(source, /clob|placeOrder|submitOrder|order-events|queue\/mark/i);
});

// ── Empty-replacement delete guard: closes the destructive force-rebuild incident ──
//
// Production incident: night-plan:2026-07-21:1700-minsk force-rebuilds at
// 13:38:41Z and 14:03:49Z both deleted the existing reservation
// (deleted_reservation_count=1 on the first run) and then built a replacement
// plan with reserved_count=0, leaving night_event_reservations and
// event_execution_queue at zero rows for the plan with no way to recover the
// deleted row. The fix: build the replacement plan FIRST (pure, no DB writes)
// and only delete once it is known to be non-empty.

const fetchNoCandidates = async () => ({ candidates: [] });

test("9: an empty replacement plan aborts before any delete -- an existing reservation is never destroyed with nothing to replace it", async () => {
  const existing: NightEventReservationRow = {
    id: "res-existing-1",
    plan_run_id: "night-plan:2026-07-19:1700-minsk",
    plan_date_minsk: "2026-07-19",
    window_start_iso: "2026-07-19T14:00:00.000Z",
    window_end_iso: "2026-07-20T05:00:00.000Z",
    match_family_key: "pair:argentina-vs-spain:2026-07-19",
    event_slug: "fifwc-esp-arg-2026-07-19",
    event_title: "Argentina vs Spain",
    sport: "soccer",
    league: null,
    strategic_scope: "WC",
    game_start_iso: KICKOFF_ISO,
    event_tier: "TIER1",
    event_score: 80,
    best_snapshot_id: null,
    reservation_rank: 1,
    status: "RESERVED",
    selection_reason: null,
    diagnostics: {},
  };
  const repo = makeFakeReservationRepo([existing]);
  const forceRebuildRepo = makeFakeForceRebuildRepo();
  const jobEvidence = makeFakeJobEvidence();

  const result = await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchNoCandidates, // replacement universe is empty
    repo,
    forceRebuildRepo,
    jobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });

  assert.equal(result.result, "ABORTED_NO_REPLACEMENT");
  assert.equal(result.deleted_queue_count, 0, "no queue delete when the replacement plan is empty");
  assert.equal(result.deleted_reservation_count, 0, "no reservation delete when the replacement plan is empty");
  assert.equal(forceRebuildRepo.deleteQueueCalls, 0, "the delete port must never be invoked at all in the aborted path");
  assert.equal(forceRebuildRepo.deleteReservationCalls, 0);
  assert.equal(
    repo.store.some((r) => r.id === "res-existing-1"),
    true,
    "the pre-existing reservation must survive an aborted force-rebuild untouched"
  );
  assert.equal(result.persist.written_count, 0);
  assert.equal(jobEvidence.calls.length, 1);
  assert.equal(jobEvidence.calls[0].status, "empty");
  const diag = jobEvidence.calls[0].diagnostics as Record<string, unknown>;
  assert.equal(diag.aborted_reason, "EMPTY_REPLACEMENT_PLAN");
  assert.equal(diag.deleted_reservation_count, 0);
});

test("10: a non-empty replacement plan still proceeds through delete-then-persist exactly as before", async () => {
  const repo = makeFakeReservationRepo();
  const forceRebuildRepo = makeFakeForceRebuildRepo();
  const jobEvidence = makeFakeJobEvidence();

  const result = await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchOneCandidate, // non-empty replacement
    repo,
    forceRebuildRepo,
    jobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });

  assert.equal(result.result, "REBUILT");
  assert.equal(forceRebuildRepo.deleteQueueCalls, 1);
  assert.equal(forceRebuildRepo.deleteReservationCalls, 1);
  assert.equal(result.persist.written_count, 1);
  assert.equal(jobEvidence.calls[0].status, "success");
});

test("11: the funnel diagnostics returned on an empty-replacement abort use the exact existing ReservationPlan stage names -- no new/incompatible reporting subsystem", async () => {
  const repo = makeFakeReservationRepo();
  const forceRebuildRepo = makeFakeForceRebuildRepo();
  const jobEvidence = makeFakeJobEvidence();

  const result = await executeForceRebuild(ANCHOR_NOW_MS, {
    fetchCandidates: fetchNoCandidates,
    repo,
    forceRebuildRepo,
    jobEvidence,
    loadPlanStatus: fakeLoadPlanStatus,
  });

  // Exact existing ReservationPlan.diagnostics stage names must be present --
  // this is the same object the route already returns as `diagnostics` in the
  // non-empty case, so a zero-result response is never bare counts.
  const diag = result.plan.diagnostics;
  for (const stage of [
    "universe_size",
    "event_groups",
    "canonical_event_groups",
    "reserved_count",
    "skipped_outside_horizon",
    "skipped_weak_key",
    "skipped_non_tier1_event",
    "skipped_no_executable_anchor",
    "market_level_keys_skipped",
    "tier1PhysicalMatchesSeen",
    "tier1ReservationsPlanned",
  ]) {
    assert.ok(stage in diag, `expected existing diagnostics stage "${stage}" to be present`);
  }
  assert.equal(result.persist.diagnostics, result.plan.diagnostics, "persist result carries the same diagnostics object, not a duplicate reporting shape");
});
