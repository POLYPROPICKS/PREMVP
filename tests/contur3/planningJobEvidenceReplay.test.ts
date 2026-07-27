// R0E PLANNING JOB EVIDENCE — fixed-clock replay of the two zero-Reservation runs.
//   node --import tsx --test tests/contur3/planningJobEvidenceReplay.test.ts
//
// Production job_runs rows under investigation (source=night-event-reservations):
//
//   2026-07-25  status=empty generated_count=0 rejected_count=1 reserved_count=0
//   2026-07-26  status=empty generated_count=0 rejected_count=1 reserved_count=0
//   both: error_message=null
//
// COUNTER SEMANTICS (proved by the first test below, not assumed):
//   generated_count = persistReservationPlan().written_count  -- rows inserted
//   status          = "success" when written_count > 0 OR already_exists, else "empty"
//   rejected_count  = skipped_non_tier1_event
//                   + skipped_outside_horizon
//                   + skipped_no_executable_anchor
//
// rejected_count is therefore NOT a source-row count and NOT a total. It omits
// skipped_no_fullmatch_anchor, market_level_keys_skipped and the identity gate
// entirely, so rejected_count=1 means exactly ONE physical-event group hit one
// of those three specific counters -- while any number of other groups may have
// been dropped invisibly.
//
// The decisive consequence: rejected_count=1 proves the planning universe was
// NOT empty on either night. A genuinely empty universe produces zero groups and
// therefore rejected_count=0.
//
// Every clock is pinned to the exact production instants.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";
import {
  runReservationCronWithEvidence,
  type ReservationRepoPort,
} from "../../lib/executor/nightEventReservations";
import type { SchedulerJobEvidencePort, SchedulerJobRunInput } from "../../lib/executor/schedulerJobEvidence";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

// ── The two production run instants (UTC) ───────────────────────────────────
const RUN_1_MS = Date.parse("2026-07-25T14:00:50.000Z"); // 17:00:50 Minsk
const RUN_2_MS = Date.parse("2026-07-26T14:04:02.000Z"); // 17:04:02 Minsk

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

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { __diagnostics, ...rest } = overrides as Record<string, unknown> & {
    __diagnostics?: Record<string, unknown>;
  };
  return {
    id: "00000000-0000-4000-8000-000000000001",
    condition_id: "cond-default",
    selected_token_id: "tok-default",
    selected_outcome: "TEAM_A",
    score: 80,
    signal_confidence_num: 70,
    smart_money_score_num: null,
    entry_price_num: 0.42,
    metric_formula_version: "v2-lite-growth-safe",
    signal_result: null,
    created_at: "2026-07-25T13:00:00.000Z",
    expires_at: "2026-07-26T00:00:00.000Z",
    event_slug: "mlb-evt-default",
    market_slug: "Team A vs. Team B - Moneyline",
    diagnostics: {
      gameStartIso: "2026-07-25T21:00:00.000Z",
      dataCoverage: 60,
      shadowScope: "baseball",
      eventTitle: "Team A vs Team B",
      marketTitle: "Team A vs Team B moneyline",
      ...(__diagnostics ?? {}),
    },
    ...rest,
  };
}

// ── FIXTURE CLASS 1 ─────────────────────────────────────────────────────────
// Tonight's game: kickoff 7h after the plan instant, so its T-90 snapshot
// CANNOT exist yet. This is the inventory the night plan is supposed to reserve.
const FUTURE_EVENT_NO_T90 = sourceRow({
  id: "00000000-0000-4000-8000-00000000000f",
  condition_id: "cond-nyy-phi",
  selected_token_id: "tok-nyy-phi",
  selected_outcome: "New York Yankees",
  created_at: "2026-07-25T13:00:00.000Z",
  event_slug: "mlb-nyy-phi-2026-07-25",
  market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
  __diagnostics: {
    gameStartIso: "2026-07-25T21:00:00.000Z",
    eventTitle: "New York Yankees vs Philadelphia Phillies",
    marketTitle: "Yankees vs Phillies moneyline",
  },
});

// ── FIXTURE CLASS 4 ─────────────────────────────────────────────────────────
// YESTERDAY's game, still inside the 72h source lookback, WITH its T-90
// snapshot. Contract A's timing gate is row-relative (game_start - created_at),
// so this past game passes it and yields an identity-complete candidate -- which
// the planner then rejects as outside the 17:00->08:00 horizon. This is the
// group that shows up as rejected_count=1.
const PAST_EVENT_WITH_T90 = sourceRow({
  id: "00000000-0000-4000-8000-00000000000e",
  condition_id: "cond-past-game",
  selected_token_id: "tok-past-game",
  selected_outcome: "Chicago Cubs",
  score: 80,
  signal_confidence_num: 80,
  entry_price_num: 0.45,
  created_at: "2026-07-24T20:30:00.000Z", // exactly T-90 for a 22:00Z kickoff
  expires_at: "2026-07-24T23:00:00.000Z",
  event_slug: "mlb-chc-mil-2026-07-24",
  market_slug: "Chicago Cubs vs. Milwaukee Brewers - Moneyline",
  __diagnostics: {
    gameStartIso: "2026-07-24T22:00:00.000Z", // yesterday -> outside tonight's horizon
    eventTitle: "Chicago Cubs vs Milwaukee Brewers",
    marketTitle: "Cubs vs Brewers moneyline",
  },
});

// A supported, future event that sits beyond the 17:00->08:00 night horizon.
const OUTSIDE_HORIZON_EVENT = sourceRow({
  id: "00000000-0000-4000-8000-00000000000a",
  condition_id: "cond-far-future",
  selected_token_id: "tok-far-future",
  selected_outcome: "Seattle Mariners",
  created_at: "2026-07-25T13:00:00.000Z",
  expires_at: "2026-07-29T00:00:00.000Z",
  event_slug: "mlb-sea-hou-2026-07-28",
  market_slug: "Seattle Mariners vs. Houston Astros - Moneyline",
  __diagnostics: {
    gameStartIso: "2026-07-28T21:00:00.000Z", // three days out
    eventTitle: "Seattle Mariners vs Houston Astros",
    marketTitle: "Mariners vs Astros moneyline",
  },
});

// ── FIXTURE CLASS 2: a future event whose authoritative identity already exists.
const FUTURE_EVENT_WITH_T90 = sourceRow({
  id: "00000000-0000-4000-8000-00000000000d",
  condition_id: "cond-soon-game",
  selected_token_id: "tok-soon-game",
  selected_outcome: "Boston Red Sox",
  score: 80,
  signal_confidence_num: 80,
  entry_price_num: 0.45,
  created_at: "2026-07-25T14:00:00.000Z", // T-90 for a 15:30Z kickoff
  expires_at: "2026-07-25T16:30:00.000Z",
  event_slug: "mlb-bos-tor-2026-07-25",
  market_slug: "Boston Red Sox vs. Toronto Blue Jays - Moneyline",
  __diagnostics: {
    dataCoverage: 80,
    gameStartIso: "2026-07-25T15:30:00.000Z",
    eventTitle: "Boston Red Sox vs Toronto Blue Jays",
    marketTitle: "Red Sox vs Blue Jays moneyline",
  },
});

// ── FIXTURE CLASS 5: unsupported market/scope (no allowed full-match anchor).
const UNSUPPORTED_MARKET = sourceRow({
  id: "00000000-0000-4000-8000-00000000000c",
  condition_id: "cond-corners",
  selected_token_id: "tok-corners",
  selected_outcome: "Over",
  event_slug: "soccer-total-corners-2026-07-25",
  market_slug: "Total Corners Over 9.5",
  __diagnostics: {
    gameStartIso: "2026-07-25T21:00:00.000Z",
    eventTitle: "Total Corners",
    marketTitle: "Total corners over 9.5",
    shadowScope: "football",
  },
});

// ── FIXTURE CLASS 6: KC activity-label regression.
const KC_ACTIVITY = sourceRow({
  id: "00000000-0000-4000-8000-00000000000b",
  condition_id: "cond-kc-activity",
  selected_token_id: "tok-kc-activity",
  selected_outcome: "Kansas City Chiefs",
  event_slug: "$52K matched activity",
  market_slug: "$52K matched activity",
  __diagnostics: {
    gameStartIso: "2026-07-25T21:00:00.000Z",
    eventTitle: "$52K matched activity",
    marketTitle: "$52K matched activity",
  },
});

// ── In-memory ports ────────────────────────────────────────────────────────
function makeFakeRepo() {
  const store: NightEventReservationRow[] = [];
  const repo: ReservationRepoPort = {
    async findByPlanRunId(planRunId) {
      return store.filter((r) => r.plan_run_id === planRunId);
    },
    async deleteByPlanRunId(planRunId) {
      for (let i = store.length - 1; i >= 0; i--) if (store[i].plan_run_id === planRunId) store.splice(i, 1);
    },
    async insert(rows) {
      store.push(...rows);
    },
  };
  return { repo, store };
}

function makeFakeJobEvidence() {
  const calls: SchedulerJobRunInput[] = [];
  const jobEvidence: SchedulerJobEvidencePort = {
    async writeJobRun(input) {
      calls.push(input);
    },
  };
  return { jobEvidence, calls };
}

/** The real production cron, with the real selector, at a pinned instant. */
async function runPlanningCron(nowMs: number, rows: Record<string, unknown>[]) {
  const { repo, store } = makeFakeRepo();
  const { jobEvidence, calls } = makeFakeJobEvidence();
  const out = await at(nowMs, () =>
    runReservationCronWithEvidence(
      nowMs,
      { selectorMode: "CONTRACT_A_PLANNING_V1" },
      {
        repo,
        jobEvidence,
        fetchCandidates: async () =>
          buildFireModelCandidates(100_000, "all", true, rows, "CONTRACT_A_PLANNING_V1"),
      }
    )
  );
  return { ...out, store, jobRun: calls[0] };
}

// ── 1. Counter semantics, proved from the code path itself ─────────────────

test("JOB-1: rejected_count is exactly non_tier1 + outside_horizon + no_executable_anchor -- not a source-row count", async () => {
  const { jobRun, plan } = await runPlanningCron(RUN_1_MS, [FUTURE_EVENT_NO_T90, PAST_EVENT_WITH_T90]);
  assert.equal(
    jobRun.rejectedCount,
    plan.diagnostics.skipped_non_tier1_event +
      plan.diagnostics.skipped_outside_horizon +
      plan.diagnostics.skipped_no_executable_anchor
  );
  // Explicitly NOT the number of source rows, and not the total rejections.
  assert.notEqual(jobRun.rejectedCount, 2);
  assert.equal(jobRun.generatedCount, plan.reservations.length);
});

test("JOB-2: status=empty means zero rows were written, never 'the source was empty'", async () => {
  const empty = await runPlanningCron(RUN_1_MS, []);
  assert.equal(empty.jobRun.status, "empty");
  assert.equal(empty.jobRun.generatedCount, 0);
  // A genuinely empty universe cannot produce a nonzero rejected_count: there
  // are no physical-event groups to reject. This is what makes the production
  // rejected_count=1 informative.
  assert.equal(empty.jobRun.rejectedCount, 0);
});

// ── 2. The production signature ────────────────────────────────────────────

test("JOB-3 (production RED): tonight's game is reserved even though only a PAST game carries a T-90 identity", async () => {
  // The exact production shape: one future game (no T-90 snapshot yet) plus one
  // past game inside the 72h lookback whose T-90 snapshot does exist.
  const { jobRun, store } = await runPlanningCron(RUN_1_MS, [FUTURE_EVENT_NO_T90, PAST_EVENT_WITH_T90]);

  // On 4405637 this exact input reproduces the production row byte for byte:
  // generated_count=0, rejected_count=1 (the stale past game, rejected as
  // outside horizon), status=empty. Here, tonight's game must be reserved --
  // its executable identity does not exist yet and is resolved at the
  // T-70..T-3 rebalance -- and the stale past game must not reach the planner
  // at all, so it can no longer masquerade as the run's only "rejection".
  assert.equal(jobRun.generatedCount, 1, "a future physical event must not be lost for lacking a T-90 identity");
  assert.equal(jobRun.rejectedCount, 0, "a game that already finished is excluded at the source, not counted as a planning rejection");
  assert.equal(jobRun.status, "success");
  assert.equal(store.length, 1);
  assert.equal(store[0].match_family_key.length > 0, true);
});

test("JOB-4: the second production run instant behaves identically (not a one-off)", async () => {
  // Same shapes, shifted one day: tonight's game (no T-90 snapshot) plus the
  // stale past game that main mistook for the entire universe.
  const tomorrowsGame = sourceRow({
    id: "00000000-0000-4000-8000-0000000000bb",
    condition_id: "cond-nyy-phi",
    selected_token_id: "tok-nyy-phi",
    selected_outcome: "New York Yankees",
    created_at: "2026-07-26T13:00:00.000Z",
    expires_at: "2026-07-27T00:00:00.000Z",
    event_slug: "mlb-nyy-phi-2026-07-26",
    market_slug: "New York Yankees vs. Philadelphia Phillies - Moneyline",
    __diagnostics: {
      gameStartIso: "2026-07-26T21:00:00.000Z",
      eventTitle: "New York Yankees vs Philadelphia Phillies",
      marketTitle: "Yankees vs Phillies moneyline",
    },
  });
  const { jobRun } = await runPlanningCron(RUN_2_MS, [tomorrowsGame, PAST_EVENT_WITH_T90]);
  assert.equal(jobRun.generatedCount, 1);
  assert.equal(jobRun.status, "success");
});

// ── 3. Honest-empty accounting ─────────────────────────────────────────────

test("JOB-5: a zero plan persists its first zero-count stage into job_runs.diagnostics", async () => {
  const { jobRun } = await runPlanningCron(RUN_1_MS, []);
  const d = jobRun.diagnostics as Record<string, unknown>;
  assert.equal(d.first_zero_stage, "SOURCE_ROWS");
  assert.equal(d.source_rows, 0);
  assert.equal(d.reservations_created, 0);
});

test("JOB-6: job_runs.diagnostics carries the whole planning funnel, so status=empty explains itself from one row", async () => {
  const { jobRun } = await runPlanningCron(RUN_1_MS, [FUTURE_EVENT_NO_T90, PAST_EVENT_WITH_T90, KC_ACTIVITY]);
  const d = jobRun.diagnostics as Record<string, unknown>;
  for (const field of [
    "plan_run_id",
    "source_rows",
    "rows_after_horizon",
    "normalized_physical_events",
    "physical_event_groups",
    "authoritative_candidates",
    "planning_eligible_events",
    "reservations_created",
    "rejected_count",
    "rejection_counts_by_code",
    "first_zero_stage",
    "first_rejection_code",
  ]) {
    assert.ok(field in d, `job_runs.diagnostics must persist ${field}`);
  }
  assert.equal(d.reservations_created, 1);
  assert.equal(typeof d.rejection_counts_by_code, "object");
  // No secrets, no provider payloads, no env values.
  const serialized = JSON.stringify(d);
  assert.doesNotMatch(serialized, /SUPABASE|SERVICE_ROLE|authorization|api[_-]?key|secret/i);
});

test("JOB-7: a rejected candidate is reported with an explicit rejection code", async () => {
  // FIXTURE CLASS 4: a real, supported event that simply sits outside the
  // configured 17:00->08:00 horizon.
  const { jobRun } = await runPlanningCron(RUN_1_MS, [OUTSIDE_HORIZON_EVENT]);
  const d = jobRun.diagnostics as Record<string, unknown>;
  assert.equal(jobRun.generatedCount, 0);
  assert.equal(jobRun.status, "empty");
  assert.equal(d.first_rejection_code, "OUTSIDE_HORIZON");
  assert.equal(d.first_zero_stage, "RESERVATIONS_CREATED");
  assert.equal((d.rejection_counts_by_code as Record<string, number>).OUTSIDE_HORIZON, 1);
});

// ── 4. Fixture classes 2, 5, 6 ─────────────────────────────────────────────

test("JOB-8: a future event that ALREADY has its authoritative identity is reserved too", async () => {
  const { jobRun } = await runPlanningCron(RUN_1_MS, [FUTURE_EVENT_WITH_T90]);
  assert.equal(jobRun.generatedCount, 1);
  assert.equal(jobRun.status, "success");
});

test("JOB-9: an unsupported market (corners) is rejected with an explicit anchor code, never reserved", async () => {
  const { jobRun, store } = await runPlanningCron(RUN_1_MS, [UNSUPPORTED_MARKET]);
  assert.equal(store.length, 0);
  const d = jobRun.diagnostics as Record<string, unknown>;
  const byCode = d.rejection_counts_by_code as Record<string, number>;
  assert.ok(
    (byCode.NO_EXECUTABLE_ANCHOR ?? 0) +
      (byCode.NO_FULLMATCH_ANCHOR ?? 0) +
      (byCode.MARKET_LEVEL_KEY_SKIPPED ?? 0) >
      0,
    "an unsupported market must be attributable to an explicit rejection code"
  );
  assert.equal(typeof d.first_rejection_code, "string");
});

test("JOB-10 (KC regression): an activity-label market is never reserved", async () => {
  const { store } = await runPlanningCron(RUN_1_MS, [KC_ACTIVITY]);
  assert.equal(store.length, 0);
});

test("JOB-11: one physical event produces at most one Reservation, even with duplicate representations", async () => {
  const duplicate = {
    ...FUTURE_EVENT_NO_T90,
    id: "00000000-0000-4000-8000-0000000000aa",
    condition_id: "cond-nyy-phi-dup",
    selected_token_id: "tok-nyy-phi-dup",
  };
  const { jobRun, store } = await runPlanningCron(RUN_1_MS, [FUTURE_EVENT_NO_T90, duplicate]);
  assert.equal(jobRun.generatedCount, 1);
  assert.equal(store.length, 1);
});
