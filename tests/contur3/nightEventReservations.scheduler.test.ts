// Contur3 reservation scheduler tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Exercises the REAL reservation orchestration
// (buildReservationPlan -> persistReservationPlan -> runReservationCronWithEvidence)
// through injected in-memory candidate/repo/job-evidence ports — no live
// Supabase, no network. Proves idempotency by plan_run_id, zero writes on
// dry-run (status-only callers never invoke the write path at all), and that
// job_runs evidence is recorded for both successful and failed runs.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReservationPlan,
  persistReservationPlan,
  runReservationCronWithEvidence,
  type ReservationRepoPort,
} from "../../lib/executor/nightEventReservations";
import type { SchedulerJobEvidencePort, SchedulerJobRunInput } from "../../lib/executor/schedulerJobEvidence";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

// 2026-07-19T14:00:00Z = 17:00 Minsk (the canonical reservation anchor).
const ANCHOR_NOW_MS = Date.parse("2026-07-19T14:00:00.000Z");
const KICKOFF_ISO = "2026-07-19T19:00:00.000Z"; // T-5h from anchor, within the 18h horizon

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

function makeFakeRepo(seed: NightEventReservationRow[] = []): ReservationRepoPort & { store: NightEventReservationRow[]; insertCalls: number; deleteCalls: number } {
  const store = [...seed];
  let insertCalls = 0;
  let deleteCalls = 0;
  return {
    store,
    get insertCalls() {
      return insertCalls;
    },
    get deleteCalls() {
      return deleteCalls;
    },
    async findByPlanRunId(planRunId) {
      return store.filter((r) => r.plan_run_id === planRunId).sort((a, b) => (a.reservation_rank ?? 0) - (b.reservation_rank ?? 0));
    },
    async deleteByPlanRunId(planRunId) {
      deleteCalls += 1;
      for (let i = store.length - 1; i >= 0; i--) {
        if (store[i].plan_run_id === planRunId) store.splice(i, 1);
      }
    },
    async insert(rows) {
      insertCalls += 1;
      store.push(...rows);
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

test("A1: a planning-eligible Tier1 candidate produces a RESERVED reservation", async () => {
  const plan = await buildReservationPlan(ANCHOR_NOW_MS, {
    fetchCandidates: async () => ({ candidates: [baseCandidate()] }),
  });
  assert.equal(plan.reservations.length, 1);
  assert.equal(plan.reservations[0].status, "RESERVED");
  assert.equal(plan.reservations[0].event_tier, "TIER1");
  assert.equal(plan.reservations[0].match_family_key, "pair:argentina-vs-spain:2026-07-19");
});

test("A2: repeated persistReservationPlan for the same plan_run_id is idempotent (no duplicate insert)", async () => {
  const repo = makeFakeRepo();
  const plan = await buildReservationPlan(ANCHOR_NOW_MS, {
    fetchCandidates: async () => ({ candidates: [baseCandidate()] }),
  });

  const first = await persistReservationPlan(plan, {}, repo);
  assert.equal(first.already_exists, false);
  assert.equal(first.written_count, 1);
  assert.equal(repo.insertCalls, 1);

  const second = await persistReservationPlan(plan, {}, repo);
  assert.equal(second.already_exists, true);
  assert.equal(second.written_count, 0);
  assert.equal(repo.insertCalls, 1, "must not insert a second time for the same plan_run_id");
  assert.equal(repo.store.length, 1, "store must still contain exactly one reservation row");
});

test("A3: dry-run (buildReservationPlan alone, no persistReservationPlan call) produces zero repo writes", async () => {
  const repo = makeFakeRepo();
  await buildReservationPlan(ANCHOR_NOW_MS, {
    fetchCandidates: async () => ({ candidates: [baseCandidate()] }),
  });
  assert.equal(repo.insertCalls, 0);
  assert.equal(repo.deleteCalls, 0);
  assert.equal(repo.store.length, 0);
});

test("A4: a successful reservation cron run records job_runs evidence with the reservation source/version", async () => {
  const repo = makeFakeRepo();
  const jobEvidence = makeFakeJobEvidence();
  const { plan, persisted } = await runReservationCronWithEvidence(
    ANCHOR_NOW_MS,
    {},
    { fetchCandidates: async () => ({ candidates: [baseCandidate()] }), repo, jobEvidence }
  );
  assert.equal(persisted.written_count, 1);
  assert.equal(plan.reservations.length, 1);
  assert.equal(jobEvidence.calls.length, 1);
  const call = jobEvidence.calls[0];
  assert.equal(call.source, "night-event-reservations");
  assert.equal(call.formulaVersion, "reservation-v1");
  assert.equal(call.status, "success");
  assert.equal(call.generatedCount, 1);
  assert.equal(typeof call.startedAt, "string");
  assert.equal(typeof call.finishedAt, "string");
  assert.equal(call.errorMessage, undefined);
});

test("A5: a failed reservation cron run records sanitized failure evidence and rethrows", async () => {
  const jobEvidence = makeFakeJobEvidence();
  const failingRepo: ReservationRepoPort = {
    async findByPlanRunId() {
      throw new Error("connection failed: postgres://user:pass@host?token=SECRETVALUE123");
    },
    async deleteByPlanRunId() {},
    async insert() {},
  };

  await assert.rejects(
    () =>
      runReservationCronWithEvidence(
        ANCHOR_NOW_MS,
        {},
        { fetchCandidates: async () => ({ candidates: [baseCandidate()] }), repo: failingRepo, jobEvidence }
      ),
    /connection failed/
  );

  assert.equal(jobEvidence.calls.length, 1);
  const call = jobEvidence.calls[0];
  assert.equal(call.status, "error");
  assert.equal(call.source, "night-event-reservations");
  assert.ok(call.errorMessage, "error run must record a sanitized error message");
  assert.doesNotMatch(call.errorMessage as string, /token=SECRETVALUE123/, "secret-shaped query params must be redacted");
});

// ── Integration Phase 1: CONTRACT_A_V1 authoritative reservation provenance ──

function contractACandidate(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return baseCandidate({
    condition_id: "cond-contract-a-esp-arg",
    token_id: "tok-contract-a-esp-arg",
    side: "Spain",
    selected_outcome: "Spain",
    diagnostics: {
      executor_action: "BET_OR_PAPER_GO",
      paper_only: false,
      real_trade: false,
      score: 80,
      coverage: 100,
      smart_money: null,
      entry_price: 0.5,
      game_start_iso: KICKOFF_ISO,
      hours_to_start_now: 5,
      fire_model_alias: "ContractA",
      version: "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M",
      selector_id: "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M",
      authoritative_condition_id: "cond-contract-a-esp-arg",
      authoritative_token_id: "tok-contract-a-esp-arg",
      authoritative_side: "Spain",
      authoritative_observation_id: "obs-esp-arg-1",
      authoritative_event_key: "pair:argentina-vs-spain:2026-07-19",
    },
    ...overrides,
  });
}

test("C1: a CONTRACT_A_V1 authoritative candidate persists selector_id and the exact authoritative identity into reservation diagnostics (no schema change, no rerank)", async () => {
  const plan = await buildReservationPlan(ANCHOR_NOW_MS, {
    fetchCandidates: async () => ({ candidates: [contractACandidate()] }),
  });
  assert.equal(plan.reservations.length, 1);
  const r = plan.reservations[0];
  assert.equal(r.diagnostics.selector_id, "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M");
  assert.equal(r.diagnostics.authoritative_condition_id, "cond-contract-a-esp-arg");
  assert.equal(r.diagnostics.authoritative_token_id, "tok-contract-a-esp-arg");
  assert.equal(r.diagnostics.authoritative_side, "Spain");
  assert.equal(r.diagnostics.authoritative_observation_id, "obs-esp-arg-1");
  assert.equal(r.diagnostics.authoritative_event_key, "pair:argentina-vs-spain:2026-07-19");
  assert.match(r.selection_reason ?? "", /CONTRACT_A_AUTHORITATIVE/);
});

test("C2: repeated CONTRACT_A_V1 input produces the same reservation identity -- no duplicate reservation on re-persist", async () => {
  const repo = makeFakeRepo();
  const plan = await buildReservationPlan(ANCHOR_NOW_MS, {
    fetchCandidates: async () => ({ candidates: [contractACandidate()] }),
  });
  const first = await persistReservationPlan(plan, {}, repo);
  assert.equal(first.written_count, 1);
  const second = await persistReservationPlan(plan, {}, repo);
  assert.equal(second.already_exists, true);
  assert.equal(second.written_count, 0);
  assert.equal(repo.store.length, 1);
  assert.equal(repo.store[0].diagnostics.authoritative_condition_id, "cond-contract-a-esp-arg");
});

test("C3: default CONTUR3_CURRENT candidates (no selector_id) are unaffected -- no CONTRACT_A_AUTHORITATIVE reason, no authoritative_* diagnostics", async () => {
  const plan = await buildReservationPlan(ANCHOR_NOW_MS, {
    fetchCandidates: async () => ({ candidates: [baseCandidate()] }),
  });
  const r = plan.reservations[0];
  assert.equal(r.diagnostics.selector_id, undefined);
  assert.equal(r.diagnostics.authoritative_condition_id, undefined);
  assert.doesNotMatch(r.selection_reason ?? "", /CONTRACT_A_AUTHORITATIVE/);
});

test("A6: an empty planning universe records status=empty, not success, with zero generatedCount", async () => {
  const repo = makeFakeRepo();
  const jobEvidence = makeFakeJobEvidence();
  const { persisted } = await runReservationCronWithEvidence(
    ANCHOR_NOW_MS,
    {},
    { fetchCandidates: async () => ({ candidates: [] }), repo, jobEvidence }
  );
  assert.equal(persisted.written_count, 0);
  assert.equal(jobEvidence.calls[0].status, "empty");
  assert.equal(jobEvidence.calls[0].generatedCount, 0);
});
