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
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  runEventRebalance,
  runEventRebalanceWithEvidence,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import type { SchedulerJobEvidencePort, SchedulerJobRunInput } from "../../lib/executor/schedulerJobEvidence";
import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

const root = process.cwd();

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

// ── Canonical source-signal lineage: end-to-end through runEventRebalance ──

test("D8: a CONTRACT_A_V1 authoritative queue row carries diagnostics.source_signal_id from the candidate's generated_signal_pair_id, never from the observationId-shaped signal_id", async () => {
  const repo = makeFakeRepo([contractAReservation()]);
  const realUuid = "22222222-2222-4222-8222-222222222222";
  await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    {
      repo,
      fetchCandidates: async () => ({
        candidates: [marketA({ signal_id: "cond-market-A::tok-market-A", generated_signal_pair_id: realUuid }), marketB()],
      }),
    }
  );
  const row = repo.queueRows[0];
  assert.equal(row.diagnostics.source_signal_id, realUuid);
  assert.notEqual(row.diagnostics.source_signal_id, "cond-market-A::tok-market-A");
});

test("D9: a non-Contract-A queue row carries diagnostics.source_signal_id when the candidate's signal_id is already a real UUID (legacy rebalance path)", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const realUuid = "33333333-3333-4333-8333-333333333333";
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate({ signal_id: realUuid, generated_signal_pair_id: realUuid })] }) }
  );
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows[0].diagnostics.source_signal_id, realUuid);
});

// ── Contract A candidate builder: explicit UUID lineage, separate from signal_id ──
//
// buildContractAV1Candidates (internal to buildFireModelCandidates.ts) maps
// produceFrozenModelV2ShadowDecisions's acceptedDecisions into candidates
// whose signal_id is observationId (condition_id::token_id, per
// getStrictDedupKeyForExportRow) -- never the source row's real
// generated_signal_pairs.id. generated_signal_pair_id must carry that real
// id separately so buildQueueRow can safely stamp
// diagnostics.source_signal_id without ever writing a composite key into it.

test("Lineage-CA1: a CONTRACT_A_V1 candidate carries generated_signal_pair_id = sourceRow.id, distinct from signal_id = observationId", async () => {
  const sourceRow = {
    id: "44444444-4444-4444-8444-444444444444",
    condition_id: "cond-ca-lineage",
    token_id: "tok-ca-lineage",
    selected_outcome: "TEAM_A",
    score: 70,
    entry_price_num: 0.4,
    created_at: "2026-07-20T11:30:00.000Z", // T-90 boundary for a 13:00Z kickoff
    event_slug: "nba-team-a-vs-team-b",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
  };
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.generated_signal_pair_id, "44444444-4444-4444-8444-444444444444");
  assert.notEqual(c.signal_id, c.generated_signal_pair_id, "signal_id (observationId) must remain condition_id::token_id, never overloaded with the row UUID");
  assert.match(c.signal_id, /^cond-ca-lineage::/);
});

test("Stake-CA1: a canonical CONTRACT_A_V1 candidate carries stake_usd = 1.10 (frozen-model live contour), sourced from EXECUTABLE_STAKE_USD", async () => {
  const sourceRow = {
    id: "55555555-5555-4555-8555-555555555555",
    condition_id: "cond-ca-stake",
    token_id: "tok-ca-stake",
    selected_outcome: "TEAM_A",
    score: 70,
    entry_price_num: 0.4,
    created_at: "2026-07-20T11:30:00.000Z", // T-90 boundary for a 13:00Z kickoff
    event_slug: "nba-team-a-vs-team-b",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
  };
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].stake_usd, 1.1, "canonical Contract A stake must be the $1.10 live-contour stake, not $7");
  assert.equal(candidates[0].max_order_usd, 1.1, "canonical Contract A max_order_usd must also track the $1.10 stake");
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

// ── Phase 1 canonical safety cap: maxQueueWrites (default branch only) ─────
//
// Preflight audit finding: the default canonical rebalance branch has no
// code-level per-run cap -- if more than 1-2 reservations are due, it
// queues all of them. maxQueueWrites closes that gap for a controlled
// Phase 1 batch, fail-closed (no partial writes over the cap), and must
// never apply to founderBattleBatch or controlledLiveIntent (separate
// functions entirely -- not touched by this change).

function multiEventFixture(n: number): { reservations: NightEventReservationRow[]; candidates: FireModelCandidate[] } {
  const reservations: NightEventReservationRow[] = [];
  const candidates: FireModelCandidate[] = [];
  for (let i = 1; i <= n; i++) {
    const key = `pair:team-a${i}-vs-team-b${i}:2026-07-19`;
    reservations.push(
      baseReservation({
        id: `res-${i}`,
        match_family_key: key,
        event_slug: `team-a${i}-vs-team-b${i}`,
      })
    );
    candidates.push(
      baseCandidate({
        match_family_key: key,
        event_slug: `team-a${i}-vs-team-b${i}`,
        condition_id: `cond-${i}`,
        token_id: `token-${i}`,
      })
    );
  }
  return { reservations, candidates };
}

test("Cap-1: dry-run reports a would-be cap breach without writing anything", async () => {
  const { reservations, candidates } = multiEventFixture(3);
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false, maxQueueWrites: 2 },
    { repo, fetchCandidates: async () => ({ candidates }) }
  );
  assert.equal(result.wrote, false);
  assert.equal(repo.queueRows.length, 0, "dry-run must never write");
  assert.equal(result.planned_queue_writes, 3);
  assert.equal(result.max_queue_writes, 2);
  assert.equal(result.blocked_by_max_queue_writes, true);
});

test("Cap-2: write mode blocks before any queue rows are created when planned writes exceed the cap", async () => {
  const { reservations, candidates } = multiEventFixture(3);
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 2 },
    { repo, fetchCandidates: async () => ({ candidates }) }
  );
  assert.equal(result.blocked_by_max_queue_writes, true);
  assert.equal(result.queued_count, 0, "MAX_QUEUE_WRITES_EXCEEDED must block all writes, not partially write");
  assert.equal(repo.queueRows.length, 0);
  assert.equal(repo.skippedCalls.length, 0, "no reservation should even be marked skipped when the whole run is blocked");
  assert.equal(repo.queuedStatusCalls.length, 0);
  assert.equal(result.wrote, false);
});

test("Cap-3: write mode allows and writes exactly the planned rows when within the cap", async () => {
  const { reservations, candidates } = multiEventFixture(2);
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 2 },
    { repo, fetchCandidates: async () => ({ candidates }) }
  );
  assert.equal(result.blocked_by_max_queue_writes, false);
  assert.equal(result.queued_count, 2);
  assert.equal(repo.queueRows.length, 2);
  assert.equal(result.planned_queue_writes, 2);
});

test("Cap-4: omitting maxQueueWrites preserves current unlimited behavior", async () => {
  const { reservations, candidates } = multiEventFixture(3);
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates }) }
  );
  assert.equal(result.max_queue_writes, null);
  assert.equal(result.blocked_by_max_queue_writes, false);
  assert.equal(result.queued_count, 3);
  assert.equal(repo.queueRows.length, 3);
});

test("Cap-5 (route-level validation): the event-rebalance route rejects maxQueueWrites=0, 6, and non-numeric values with 400, and never invokes the rebalance function", async () => {
  const routeSource = readFileSync(path.join(root, "app/api/cron/event-rebalance/route.ts"), "utf8");
  assert.match(routeSource, /parseMaxQueueWrites/, "route must validate maxQueueWrites before calling runEventRebalanceWithEvidence");
  assert.match(routeSource, /status:\s*400/, "an invalid maxQueueWrites must be rejected with 400");
  assert.match(routeSource, /MAX_QUEUE_WRITES_MIN\s*=\s*1/);
  assert.match(routeSource, /MAX_QUEUE_WRITES_MAX\s*=\s*5/);
});

test("Cap-6: founderBattleBatch is structurally unaffected -- the route never threads maxQueueWrites into runFounderBattleBatch", () => {
  const routeSource = readFileSync(path.join(root, "app/api/cron/event-rebalance/route.ts"), "utf8");
  const founderBlockMatch = routeSource.match(/if \(founderBattleBatch\) \{[\s\S]*?\n  \}\n/);
  assert.ok(founderBlockMatch, "expected to find the founderBattleBatch branch");
  assert.doesNotMatch(founderBlockMatch![0], /maxQueueWrites/);
});

test("Cap-7: controlledLiveIntent is structurally unaffected -- the route never threads maxQueueWrites into runControlledLiveIntent", () => {
  const routeSource = readFileSync(path.join(root, "app/api/cron/event-rebalance/route.ts"), "utf8");
  const controlledBlockMatch = routeSource.match(/if \(controlledLiveIntent !== null\) \{[\s\S]*?\n  \}\n/);
  assert.ok(controlledBlockMatch, "expected to find the controlledLiveIntent branch");
  assert.doesNotMatch(controlledBlockMatch![0], /maxQueueWrites/);
});
