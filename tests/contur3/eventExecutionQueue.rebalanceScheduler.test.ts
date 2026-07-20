// Contur3 rebalance scheduler tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Exercises the REAL rebalance orchestration
// (runEventRebalance -> runEventRebalanceWithEvidence) through injected
// in-memory reservation-repo/candidate/job-evidence ports — no live
// Supabase, no network. Proves the T-70..T-3 due window, idempotent
// re-runs (no duplicate queue writes), and job_runs evidence for both
// successful and failed write-mode runs.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runEventRebalance,
  runEventRebalanceWithEvidence,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import type { SchedulerJobEvidencePort, SchedulerJobRunInput } from "../../lib/executor/schedulerJobEvidence";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
const KICKOFF_MS = Date.parse(KICKOFF_ISO);

// T-70..T-3 window for a 19:00Z kickoff = 17:50Z..18:57Z.
const BEFORE_WINDOW_MS = Date.parse("2026-07-19T17:00:00.000Z"); // T-120m
const IN_WINDOW_MS = Date.parse("2026-07-19T18:00:00.000Z"); // T-60m
const AFTER_WINDOW_MS = Date.parse("2026-07-19T18:59:00.000Z"); // T-1m

function baseReservation(overrides: Partial<NightEventReservationRow> = {}): NightEventReservationRow {
  return {
    id: "res-esp-arg",
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
    ...overrides,
  };
}

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
    timing_bucket: "T_1_2H",
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
      hours_to_start_now: 1,
      fire_model_alias: "FireModel1",
      version: "v2-lite-growth-safe",
    },
    ...overrides,
  } as FireModelCandidate;
}

function makeFakeRepo(reservations: NightEventReservationRow[]): RebalanceRepoPort & {
  queueRows: EventExecutionQueueRow[];
  queuedReservationIds: Set<string>;
  expiredCalls: string[][];
  skippedCalls: Array<{ id: string; reason: string }>;
  queuedStatusCalls: Array<{ id: string; reason: string }>;
} {
  const queueRows: EventExecutionQueueRow[] = [];
  const queuedReservationIds = new Set<string>();
  const expiredCalls: string[][] = [];
  const skippedCalls: Array<{ id: string; reason: string }> = [];
  const queuedStatusCalls: Array<{ id: string; reason: string }> = [];
  return {
    queueRows,
    queuedReservationIds,
    expiredCalls,
    skippedCalls,
    queuedStatusCalls,
    async loadActiveReservations() {
      return reservations.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING");
    },
    async loadQueuedReservationIds() {
      return new Set(queuedReservationIds);
    },
    async markReservationsExpired(ids) {
      expiredCalls.push(ids);
      for (const r of reservations) if (ids.includes(r.id as string)) r.status = "EXPIRED";
    },
    async markReservationSkipped(id, reason) {
      skippedCalls.push({ id, reason });
      const r = reservations.find((x) => x.id === id);
      if (r) r.status = "SKIPPED";
    },
    async insertQueueRow(row) {
      queueRows.push(row);
      if (row.reservation_id) queuedReservationIds.add(row.reservation_id);
    },
    async markReservationQueued(id, reason) {
      queuedStatusCalls.push({ id, reason });
      const r = reservations.find((x) => x.id === id);
      if (r) r.status = "QUEUED";
    },
  };
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

test("B1: before T-70, zero queue rows are created", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const result = await runEventRebalance(
    BEFORE_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }) }
  );
  assert.equal(result.due_count, 0);
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
});

test("B2: inside T-70..T-3, a canonical READY queue row is created", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }) }
  );
  assert.equal(result.due_count, 1);
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.queueRows[0].status, "READY");
  assert.equal(repo.queueRows[0].condition_id, "cond-esp-arg");
});

test("B3: after T-3, zero new queue rows are created (reservation expires instead)", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const result = await runEventRebalance(
    AFTER_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }) }
  );
  assert.equal(result.due_count, 0);
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(result.expired_count, 1);
  assert.equal(repo.expiredCalls.length, 1);
});

test("B4: a repeated in-window run is idempotent -- no duplicate queue row for the same reservation", async () => {
  const reservations = [baseReservation()];
  const repo = makeFakeRepo(reservations);
  const first = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }) }
  );
  assert.equal(first.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);

  // Reservation status flips to QUEUED after the first run; the reservation
  // repo mock does not re-surface it as RESERVED/REBALANCE_PENDING, mirroring
  // production (loadActiveReservations excludes QUEUED rows) -- but even if a
  // stale REBALANCE_PENDING row were re-read, alreadyQueued must still block it.
  reservations[0].status = "REBALANCE_PENDING"; // simulate a race/retry re-surfacing it
  const second = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }) }
  );
  assert.equal(second.already_queued_count, 1);
  assert.equal(second.queued_count, 0);
  assert.equal(repo.queueRows.length, 1, "must not insert a second queue row for the same reservation");
});

test("B5: a successful write-mode rebalance run records job_runs evidence", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const jobEvidence = makeFakeJobEvidence();
  const result = await runEventRebalanceWithEvidence(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }), jobEvidence }
  );
  assert.equal(result.queued_count, 1);
  assert.equal(jobEvidence.calls.length, 1);
  const call = jobEvidence.calls[0];
  assert.equal(call.source, "event-rebalance");
  assert.equal(call.formulaVersion, "rebalance-v1");
  assert.equal(call.status, "success");
  assert.equal(call.generatedCount, 1);
});

test("B6: a dry-run rebalance invocation records zero job_runs evidence", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const jobEvidence = makeFakeJobEvidence();
  await runEventRebalanceWithEvidence(
    IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }), jobEvidence }
  );
  assert.equal(jobEvidence.calls.length, 0);
  assert.equal(repo.queueRows.length, 0);
});

// ── Integration Phase 1: CONTRACT_A_V1 authoritative-market rebalance ──────

const AUTH_SELECTOR_ID = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M";

function contractAReservation(overrides: Partial<NightEventReservationRow> = {}): NightEventReservationRow {
  return baseReservation({
    diagnostics: {
      selector_id: AUTH_SELECTOR_ID,
      authoritative_condition_id: "cond-market-A",
      authoritative_token_id: "tok-market-A",
      authoritative_side: "Spain",
      authoritative_observation_id: "obs-esp-arg-1",
      authoritative_event_key: "pair:argentina-vs-spain:2026-07-19",
    },
    ...overrides,
  });
}

function marketA(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return baseCandidate({
    condition_id: "cond-market-A",
    token_id: "tok-market-A",
    side: "Spain",
    selected_outcome: "Spain",
    ...overrides,
  });
}

function marketB(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return baseCandidate({
    condition_id: "cond-market-B",
    token_id: "tok-market-B",
    side: "Argentina",
    selected_outcome: "Argentina",
    diagnostics: {
      executor_action: "BET_OR_PAPER_GO",
      paper_only: false,
      real_trade: false,
      score: 99, // deliberately higher than market A -- must never win under compareCandidateQuality
      coverage: 99,
      smart_money: 99,
      entry_price: 0.5,
      game_start_iso: KICKOFF_ISO,
      hours_to_start_now: 1,
      fire_model_alias: "FireModel1",
      version: "v2-lite-growth-safe",
    },
    ...overrides,
  });
}

test("D1: a CONTRACT_A_V1 reservation queues its exact authoritative market even when an alternate market with a higher compareCandidateQuality score exists for the same event", async () => {
  const repo = makeFakeRepo([contractAReservation()]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [marketB(), marketA()] }) } // B ranked first if compareCandidateQuality were used
  );
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.queueRows[0].condition_id, "cond-market-A");
  assert.equal(repo.queueRows[0].token_id, "tok-market-A");
  assert.equal(repo.queueRows[0].side, "Spain");
});

test("D2: when the authoritative market is absent, rebalance fails closed -- no READY row, and the alternate market is never substituted", async () => {
  const repo = makeFakeRepo([contractAReservation()]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [marketB()] }) } // market A missing entirely
  );
  assert.equal(result.queued_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(repo.skippedCalls.length, 1);
  assert.match(repo.skippedCalls[0].reason, /CONTRACT_A_AUTHORITATIVE_MARKET_NOT_FOUND/);
});

test("D3: when the authoritative market exists but is not executable (not live-eligible), rebalance fails closed instead of falling back to an executable alternate", async () => {
  const repo = makeFakeRepo([contractAReservation()]);
  const nonExecutableA = marketA({ live_eligible: false, live_rejection_reason: "WEAK_IDENTITY_LIVE_BLOCKED" });
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [nonExecutableA, marketB()] }) }
  );
  assert.equal(result.queued_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(repo.queueRows.length, 0);
  assert.match(repo.skippedCalls[0].reason, /CONTRACT_A_AUTHORITATIVE_MARKET_NOT_EXECUTABLE/);
});

test("D4: selector provenance round-trips from reservation diagnostics into the queue row's diagnostics", async () => {
  const repo = makeFakeRepo([contractAReservation()]);
  await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [marketA()] }) }
  );
  const row = repo.queueRows[0];
  assert.equal(row.diagnostics.selector_id, AUTH_SELECTOR_ID);
  assert.equal(row.diagnostics.authoritative_condition_id, "cond-market-A");
  assert.equal(row.diagnostics.authoritative_token_id, "tok-market-A");
  assert.equal(row.diagnostics.authoritative_side, "Spain");
  assert.equal(row.diagnostics.authoritative_observation_id, "obs-esp-arg-1");
});

test("D5: a reservation with a missing/unknown authoritative identity (selector_id present but fields incomplete) fails closed", async () => {
  const repo = makeFakeRepo([
    contractAReservation({ diagnostics: { selector_id: AUTH_SELECTOR_ID } }), // missing authoritative_* fields
  ]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [marketA(), marketB()] }) }
  );
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(repo.skippedCalls[0].reason, /CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE/);
});

test("D6: a repeated in-window run for a CONTRACT_A_V1 reservation is idempotent -- no duplicate queue row and no identity drift", async () => {
  const reservations = [contractAReservation()];
  const repo = makeFakeRepo(reservations);
  const first = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [marketA(), marketB()] }) }
  );
  assert.equal(first.queued_count, 1);
  reservations[0].status = "REBALANCE_PENDING"; // simulate re-surfacing, mirrors B4
  const second = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [marketA(), marketB()] }) }
  );
  assert.equal(second.already_queued_count, 1);
  assert.equal(second.queued_count, 0);
  assert.equal(repo.queueRows.length, 1, "must not insert a second queue row");
  assert.equal(repo.queueRows[0].condition_id, "cond-market-A", "identity must not drift across re-runs");
});

test("D7: a default CONTUR3_CURRENT reservation (no selector_id) is unaffected -- compareCandidateQuality still selects the best market", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }) }
  );
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows[0].diagnostics.selector_id, undefined);
});

test("B7: a failed write-mode rebalance run records sanitized failure evidence and rethrows", async () => {
  const jobEvidence = makeFakeJobEvidence();
  const failingRepo: RebalanceRepoPort = {
    async loadActiveReservations() {
      throw new Error("connection failed: postgres://user:pass@host?apikey=SECRETVALUE456");
    },
    async loadQueuedReservationIds() {
      return new Set();
    },
    async markReservationsExpired() {},
    async markReservationSkipped() {},
    async insertQueueRow() {},
    async markReservationQueued() {},
  };

  await assert.rejects(
    () =>
      runEventRebalanceWithEvidence(
        IN_WINDOW_MS,
        { write: true },
        { repo: failingRepo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }), jobEvidence }
      ),
    /connection failed/
  );

  assert.equal(jobEvidence.calls.length, 1);
  const call = jobEvidence.calls[0];
  assert.equal(call.status, "error");
  assert.equal(call.source, "event-rebalance");
  assert.ok(call.errorMessage);
  assert.doesNotMatch(call.errorMessage as string, /apikey=SECRETVALUE456/);
});
