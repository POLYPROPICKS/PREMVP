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
import { fileURLToPath } from "node:url";

import {
  loadFinalIdentitySourceRowsByGeneratedSignalPairId,
  loadExactProviderSiblingRowsFromAnchor,
  runEventRebalance,
  runEventRebalanceWithEvidence,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import type { SchedulerJobEvidencePort, SchedulerJobRunInput } from "../../lib/executor/schedulerJobEvidence";
import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import { mapQueueRowToIrelandCandidate, type EventExecutionQueueRow, type NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import { createQueueAuthorityFixture } from "./helpers/queueAuthorityFixtures";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
const KICKOFF_MS = Date.parse(KICKOFF_ISO);

// T-70..T-3 window for a 19:00Z kickoff = 17:50Z..18:57Z.
const BEFORE_WINDOW_MS = Date.parse("2026-07-19T17:00:00.000Z"); // T-120m
const IN_WINDOW_MS = Date.parse("2026-07-19T18:00:00.000Z"); // T-60m
const AFTER_WINDOW_MS = Date.parse("2026-07-19T18:59:00.000Z"); // T-1m

const PARITY_RESERVATION_START = "2026-07-29T16:35:00Z";
const PARITY_IN_WINDOW_MS = Date.parse("2026-07-29T15:35:00Z");
const STALE_CANDIDATE_START = "2026-07-27T22:40:00Z";
const EQUIVALENT_CANDIDATE_START = "2026-07-29T18:35:00+02:00";

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

test("Final Identity source loader uses only the persisted generated_signal_pair_id UUID", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation(), baseCandidate());
  const queriedIds: string[] = [];
  const row = { ...authority.sourceRow, event_slug: "DIFFERENT-SLUG-WITH-CASE-MISMATCH" };
  const rows = await loadFinalIdentitySourceRowsByGeneratedSignalPairId(authority.reservation, async (id) => {
    queriedIds.push(id);
    return [row, { ...row, id: "22222222-2222-4222-8222-222222222222" }];
  });
  assert.deepEqual(queriedIds, [authority.sourceRow.id], "the lineage UUID remains authoritative when slug differs");
  assert.equal(rows.length, 1, "the loader may expose at most one exact source row");
  assert.equal(rows[0].id, authority.sourceRow.id);
});

test("Final Identity source loader fails closed with bounded reasons", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation(), baseCandidate());
  const cases: Array<{ reservation: NightEventReservationRow; query: () => Promise<Record<string, unknown>[]>; reason: string }> = [
    { reservation: { ...authority.reservation, diagnostics: { ...authority.reservation.diagnostics, source_lineage: {} } }, query: async () => [authority.sourceRow], reason: "FINAL_IDENTITY_SOURCE_LINEAGE_ID_MISSING" },
    { reservation: { ...authority.reservation, diagnostics: { ...authority.reservation.diagnostics, source_lineage: { ...(authority.reservation.diagnostics?.source_lineage as object), generated_signal_pair_id: "not-a-uuid" } } }, query: async () => [authority.sourceRow], reason: "FINAL_IDENTITY_SOURCE_LINEAGE_ID_INVALID" },
    { reservation: authority.reservation, query: async () => [], reason: "FINAL_IDENTITY_SOURCE_ROW_NOT_FOUND" },
    { reservation: authority.reservation, query: async () => { throw { code: "42p01", message: "do not disclose" }; }, reason: "FINAL_IDENTITY_SOURCE_QUERY_FAILED_42P01" },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => loadFinalIdentitySourceRowsByGeneratedSignalPairId(item.reservation, item.query),
      (error: Error) => error.message === item.reason,
      item.reason
    );
  }
});

test("Final Identity production loader has no slug fallback query", () => {
  const source = readFileSync(path.join(root, "lib/executor/eventExecutionQueue.ts"), "utf8");
  const start = source.indexOf("async loadFinalIdentitySourceRows(reservation)");
  const end = source.indexOf("async findQueueRowsByRebalanceRunId", start);
  assert.ok(start >= 0 && end > start, "expected the production Final Identity source loader");
  const loader = source.slice(start, end);
  assert.match(loader, /\.eq\("id", generatedSignalPairId\)/);
  assert.match(loader, /\.limit\(1\)/);
  assert.match(loader, /\.eq\("condition_id", conditionId\)/);
  assert.doesNotMatch(loader, /\.contains\("diagnostics"/, "the first-stage sibling lookup must never scan broad JSON");
  assert.doesNotMatch(loader, /event_slug|\.order\(/, "slug and recency must never become source identity fallbacks");
});

test("production-scale exact sibling lookup is condition-bounded before residual provider validation", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation(), baseCandidate());
  const anchor = { ...authority.sourceRow, condition_id: "cond-exact", diagnostics: { providerEventContext: { v: "v1", provider: "polymarket", eventId: "event-a", eventStartIso: KICKOFF_ISO } } };
  const siblingHigh = { ...anchor, id: "pair-high", score: 91, selected_token_id: "token-high", selected_outcome: "YES" };
  const siblingTie = { ...anchor, id: "pair-z", score: 91, selected_token_id: "token-z", selected_outcome: "NO" };
  const wrongStart = { ...anchor, id: "pair-other-start", diagnostics: { providerEventContext: { v: "v1", provider: "polymarket", eventId: "event-a", eventStartIso: "2026-07-20T19:00:00.000Z" } } };
  const broadPopulation = Array.from({ length: 50_000 }, (_, i) => ({ ...anchor, id: `unrelated-${i}`, condition_id: `other-${i}`, diagnostics: { providerEventContext: { v: "v1", provider: "polymarket", eventId: `other-${i}`, eventStartIso: KICKOFF_ISO } } }));
  let queriedCondition: string | null = null;
  const rows = await loadExactProviderSiblingRowsFromAnchor(
    authority.reservation,
    async () => [anchor],
    async (conditionId) => {
      queriedCondition = conditionId;
      return [anchor, siblingHigh, siblingTie, wrongStart];
    },
  );
  assert.equal(broadPopulation.length, 50_000, "fixture represents a production-scale unrelated population");
  assert.equal(queriedCondition, "cond-exact", "only the scalar anchor condition reaches the sibling read");
  assert.deepEqual(rows.map((r) => r.id).sort(), ["pair-high", "pair-z", anchor.id].sort(), "different occurrence is excluded after the bounded read");
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.id === "pair-high").length, 1, "the bounded set retains the max-score candidate consumed by the established queue selector");
});

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
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation(), baseCandidate());
  const repo = makeFakeRepo([authority.reservation]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
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
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation(), baseCandidate());
  const reservations = [authority.reservation];
  const repo = makeFakeRepo(reservations);
  const first = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
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
    { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
  );
  assert.equal(second.already_queued_count, 1);
  assert.equal(second.queued_count, 0);
  assert.equal(repo.queueRows.length, 1, "must not insert a second queue row for the same reservation");
});

test("B5: write-mode scheduler records the first exact per-Reservation rejection, not the generic due aggregate", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const jobEvidence = makeFakeJobEvidence();
  const result = await runEventRebalanceWithEvidence(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => { throw new Error("legacy broad candidate loading must be unreachable"); }, jobEvidence }
  );
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /RESERVATION_REQUIRED_USE_EVENT_REBALANCE/);
  assert.equal(jobEvidence.calls.length, 1);
  const call = jobEvidence.calls[0];
  assert.equal(call.source, "event-rebalance");
  assert.equal(call.formulaVersion, "rebalance-v1");
  assert.equal(call.status, "error");
  assert.equal(call.generatedCount, 0);
  assert.equal(call.errorMessage, "RESERVATION_REQUIRED_USE_EVENT_REBALANCE");
  assert.equal((call.diagnostics as Record<string, unknown>).first_rejection_code, "RESERVATION_REQUIRED_USE_EVENT_REBALANCE");
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

test("P0 queue-start parity: a stale-only candidate is skipped instead of creating READY", async () => {
  const reservation = baseReservation({
    id: "97e7766c-75d4-4d52-9894-196e1f334d22",
    game_start_iso: PARITY_RESERVATION_START,
  });
  const staleCandidate = baseCandidate({
    diagnostics: { ...baseCandidate().diagnostics, game_start_iso: STALE_CANDIDATE_START },
  });
  const repo = makeFakeRepo([reservation]);
  const result = await runEventRebalance(
    PARITY_IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [staleCandidate] }) }
  );

  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /EXECUTION_EVENT_START_MISMATCH/);
});

test("P0 queue-start parity: a stale higher-ranked candidate is excluded before the correct occurrence is selected", async () => {
  const reservation = baseReservation({ game_start_iso: PARITY_RESERVATION_START });
  const staleHigherRanked = baseCandidate({
    condition_id: "cond-stale",
    diagnostics: { ...baseCandidate().diagnostics, game_start_iso: STALE_CANDIDATE_START, score: 99 },
  });
  const correctCandidate = baseCandidate({
    condition_id: "cond-correct",
    diagnostics: { ...baseCandidate().diagnostics, game_start_iso: PARITY_RESERVATION_START, score: 80 },
  });
  const repo = makeFakeRepo([reservation]);
  const result = await runEventRebalance(
    PARITY_IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [staleHigherRanked, correctCandidate] }) }
  );

  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 0, "legacy ranking remains read-only");
  assert.equal(result.outcomes[0]?.queue_row?.condition_id, "cond-correct");
});

test("P0 queue-start parity: an equivalent ISO instant queues with timing derived from the Reservation", async () => {
  const reservation = baseReservation({ game_start_iso: PARITY_RESERVATION_START });
  const equivalentCandidate = baseCandidate({
    diagnostics: { ...baseCandidate().diagnostics, game_start_iso: EQUIVALENT_CANDIDATE_START },
  });
  const repo = makeFakeRepo([reservation]);
  const result = await runEventRebalance(
    PARITY_IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [equivalentCandidate] }) }
  );

  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 0, "legacy timing selection remains read-only");
  assert.equal(result.outcomes[0]?.queue_row?.game_start_iso, PARITY_RESERVATION_START);
  assert.equal(result.outcomes[0]?.queue_row?.preferred_entry_iso, "2026-07-29T15:50:00.000Z");
  assert.equal(result.outcomes[0]?.queue_row?.latest_entry_iso, "2026-07-29T16:32:00.000Z");
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
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [marketB(), marketA()] }) } // B ranked first if compareCandidateQuality were used
  );
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 0, "legacy authoritative selection remains read-only");
  assert.equal(result.outcomes[0]?.queue_row?.condition_id, "cond-market-A");
  assert.equal(result.outcomes[0]?.queue_row?.token_id, "tok-market-A");
  assert.equal(result.outcomes[0]?.queue_row?.side, "Spain");
});

test("D2: when the authoritative market is absent, rebalance fails closed -- no READY row, and the alternate market is never substituted", async () => {
  const repo = makeFakeRepo([contractAReservation()]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [marketB()] }) } // market A missing entirely
  );
  assert.equal(result.queued_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /CONTRACT_A_AUTHORITATIVE_MARKET_NOT_FOUND/);
});

test("D3: when the authoritative market exists but is not executable (not live-eligible), rebalance fails closed instead of falling back to an executable alternate", async () => {
  const repo = makeFakeRepo([contractAReservation()]);
  const nonExecutableA = marketA({ live_eligible: false, live_rejection_reason: "WEAK_IDENTITY_LIVE_BLOCKED" });
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [nonExecutableA, marketB()] }) }
  );
  assert.equal(result.queued_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /CONTRACT_A_AUTHORITATIVE_MARKET_NOT_EXECUTABLE/);
});

test("P0 queue-start parity: the authoritative selection path also rejects a mismatched occurrence", async () => {
  const reservation = contractAReservation({ game_start_iso: PARITY_RESERVATION_START });
  const staleAuthoritativeCandidate = marketA({
    diagnostics: { ...marketA().diagnostics, game_start_iso: STALE_CANDIDATE_START },
  });
  const repo = makeFakeRepo([reservation]);
  const result = await runEventRebalance(
    PARITY_IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [staleAuthoritativeCandidate] }) }
  );

  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /EXECUTION_EVENT_START_MISMATCH/);
});

test("D4: selector provenance round-trips from reservation diagnostics into the queue row's diagnostics", async () => {
  const repo = makeFakeRepo([contractAReservation()]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [marketA()] }) }
  );
  assert.equal(repo.queueRows.length, 0, "legacy selector provenance remains read-only");
  const row = result.outcomes[0]?.queue_row!;
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
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [marketA(), marketB()] }) }
  );
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE/);
});

test("D6: a repeated in-window run for a CONTRACT_A_V1 reservation is idempotent -- no duplicate queue row and no identity drift", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, contractAReservation(), marketA());
  const reservations = [authority.reservation];
  const repo = makeFakeRepo(reservations);
  const first = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
  );
  assert.equal(first.queued_count, 1);
  reservations[0].status = "REBALANCE_PENDING"; // simulate re-surfacing, mirrors B4
  const second = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
  );
  assert.equal(second.already_queued_count, 1);
  assert.equal(second.queued_count, 0);
  assert.equal(repo.queueRows.length, 1, "must not insert a second queue row");
  assert.equal(repo.queueRows[0].condition_id, "cond-market-A", "identity must not drift across re-runs");
});

test("D7: a default CONTUR3_CURRENT reservation has zero Queue-write authority without Planning inputs", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  let broadCandidateLoads = 0;
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => { broadCandidateLoads += 1; return { candidates: [baseCandidate()] }; } }
  );
  assert.equal(broadCandidateLoads, 0, "legacy broad ranking must be unreachable in write mode");
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /RESERVATION_REQUIRED_USE_EVENT_REBALANCE/);
});

// ── Canonical source-signal lineage: end-to-end through runEventRebalance ──

test("D8: a CONTRACT_A_V1 authoritative queue row carries diagnostics.source_signal_id from the candidate's generated_signal_pair_id, never from the observationId-shaped signal_id", async () => {
  const realUuid = "22222222-2222-4222-8222-222222222222";
  const candidate = marketA({ signal_id: "cond-market-A::tok-market-A", generated_signal_pair_id: realUuid });
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, contractAReservation(), candidate, realUuid);
  const repo = makeFakeRepo([authority.reservation]);
  await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    {
      repo,
      fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows,
      fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook,
    }
  );
  const row = repo.queueRows[0];
  const lineage = row.diagnostics.source_lineage as { generated_signal_pair_id: string };
  assert.equal(lineage.generated_signal_pair_id, realUuid);
  assert.notEqual(lineage.generated_signal_pair_id, "cond-market-A::tok-market-A");
});

test("D9: a non-Contract-A UUID lineage candidate has zero Queue-write authority", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const realUuid = "33333333-3333-4333-8333-333333333333";
  let broadCandidateLoads = 0;
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => { broadCandidateLoads += 1; return { candidates: [baseCandidate({ signal_id: realUuid, generated_signal_pair_id: realUuid })] }; } }
  );
  assert.equal(broadCandidateLoads, 0);
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /RESERVATION_REQUIRED_USE_EVENT_REBALANCE/);
});

test("C1-RED: a non-Planning reservation cannot invoke broad candidate ranking or persist a Queue row", async () => {
  const repo = makeFakeRepo([baseReservation({ diagnostics: { contract_a_stage: "FINAL" } })]);
  let broadCandidateLoads = 0;

  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    {
      repo,
      fetchCandidates: async () => {
        broadCandidateLoads += 1;
        return { candidates: [baseCandidate()] };
      },
    }
  );

  assert.equal(broadCandidateLoads, 0, "a non-Planning reservation must fail before broad candidate loading");
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /RESERVATION_REQUIRED_USE_EVENT_REBALANCE/);
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

// ── R0E: fail closed on malformed final Contract A markets ────────────────
//
// Production regression: a Contract A candidate whose market_slug/market_title
// is an activity/volume label ("$52K matched activity") and whose event_slug
// is a non-full-match submarket ("Game Handicap: KC (-1.5) vs Team Vitality
// (+1.5)") reached READY in event_execution_queue with sport=unknown,
// league=null. buildContractAV1Candidates must fail closed on this shape
// before the row is queue-eligible (live_eligible=false), reusing the same
// canonical helpers (isActivityLabelText, fullMatchAnchorDecision) the
// planning path already uses -- not a parallel classifier.

test("Anchor-CA1: the production KC handicap / activity-label candidate is not queue-eligible (live_eligible=false)", async () => {
  const sourceRow = {
    id: "66666666-6666-4666-8666-666666666666",
    condition_id: "cond-ca-kc-handicap",
    token_id: "tok-ca-kc-handicap",
    selected_outcome: "Karmine Corp",
    score: 82,
    entry_price_num: 0.4,
    created_at: "2026-07-24T13:30:00.000Z", // T-90 boundary for a 15:00Z kickoff
    event_slug: "Game Handicap: KC (-1.5) vs Team Vitality (+1.5)",
    market_slug: "$52K matched activity",
    diagnostics: { gameStartIso: "2026-07-24T15:00:00.000Z" },
  };
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.live_eligible, false, "the KC handicap / activity-label row must fail closed, never queue-eligible");
  assert.equal(c.activity_label_detected, true, "$52K matched activity must be detected as an activity label");
  assert.match(
    c.live_rejection_reason ?? "",
    /^CONTRACT_A_ACTIVITY_LABEL_MARKET$/,
    "rejection reason must identify the activity-label failure mode"
  );
});

test("Anchor-CA2: an activity-label market_slug is rejected even when event_slug alone would look like a clean full-match anchor", async () => {
  const sourceRow = {
    id: "77777777-7777-4777-8777-777777777777",
    condition_id: "cond-ca-activity-only",
    token_id: "tok-ca-activity-only",
    selected_outcome: "TEAM_A",
    score: 82,
    entry_price_num: 0.4,
    created_at: "2026-07-20T11:30:00.000Z",
    event_slug: "nba-team-a-vs-team-b-moneyline",
    market_slug: "$52K matched activity",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
  };
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false, "market_title/market_slug must never be populated from activity-label text and pass through");
  assert.equal(candidates[0].activity_label_detected, true);
});

test("Anchor-CA3: a non-full-match submarket (handicap sub-line) with an authoritative-shaped identity still fails closed even when market_slug is not an activity label", async () => {
  const sourceRow = {
    id: "88888888-8888-4888-8888-888888888888",
    condition_id: "cond-ca-submarket",
    token_id: "tok-ca-submarket",
    selected_outcome: "TEAM_A",
    score: 82,
    entry_price_num: 0.4,
    created_at: "2026-07-20T11:30:00.000Z",
    event_slug: "Game Handicap: KC (-1.5) vs Team Vitality (+1.5)",
    market_slug: "game-handicap-kc-vs-team-vitality",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
  };
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false, "a non-full-match submarket must fail closed regardless of missing/unknown authoritative sport context");
  assert.equal(candidates[0].activity_label_detected, false);
  assert.match(candidates[0].live_rejection_reason ?? "", /^CONTRACT_A_FULLMATCH_/);
});

// Note: produceFrozenModelV2ShadowDecisions excludes esports rows entirely
// upstream of buildContractAV1Candidates (isEsports check in
// frozenModelProducerV2Shadow.ts), so a BO1/BO3/BO5 esports row never
// reaches this path regardless of this fix -- the reachable positive case
// on CONTRACT_A_V1 is a clean full-match anchor such as moneyline/spread.
// The anchor probe above still special-cases BO-series titles (inferred as
// "esport" for the fullMatchAnchorDecision call only) as defense-in-depth
// should that upstream exclusion ever change.
test("Anchor-CA4: a valid clean full-match moneyline anchor remains queue-eligible (live_eligible=true)", async () => {
  const sourceRow = {
    id: "99999999-9999-4999-8999-999999999999",
    condition_id: "cond-ca-moneyline",
    token_id: "tok-ca-moneyline",
    selected_outcome: "TEAM_A",
    score: 82,
    entry_price_num: 0.4,
    created_at: "2026-07-20T11:30:00.000Z",
    event_slug: "nba-team-a-vs-team-b-moneyline",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
  };
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, true, "a valid clean full-match anchor must remain queue-eligible after the fail-closed fix");
  assert.equal(candidates[0].activity_label_detected, false);
  assert.equal(candidates[0].live_rejection_reason, null);
});

// ── P0: an activity-label display market must not discard a real exact market ─
//
// Production regression (Cleveland Guardians vs. Cincinnati Reds,
// polymarket:mlb-cle-cin-2026-07-27:2026-07-28): a fresh source row carried
// market_slug = "$24K matched activity" -- purely a display/volume label --
// while diagnostics.providerEventContext supplied the provider's OWN
// structured, stable event identity (exact eventId, eventStartIso, and
// eventTitle/marketQuestion matching the physical event) plus a real
// condition_id/token_id/selected_outcome. The activity-label check was
// unconditional and discarded this fully-executable market with
// CONTRACT_A_ACTIVITY_LABEL_MARKET before it ever reached the queue -- even
// though the SAME canonical taxonomy classifier, fed the provider's own
// market question instead of the activity label, would have approved it.

function contractAProviderContext(overrides: Record<string, unknown> = {}) {
  return {
    v: "v1",
    provider: "polymarket",
    eventId: "mlb-cle-cin-2026-07-27",
    eventSlug: "mlb-cle-cin-2026-07-27",
    eventTitle: "Cleveland Guardians vs. Cincinnati Reds",
    marketQuestion: "Cleveland Guardians vs. Cincinnati Reds",
    game: "moneyline",
    league: "MLB",
    eventStartIso: "2026-07-28T17:40:00.000Z",
    ...overrides,
  };
}

function activityLabelSourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "10101010-1010-4101-8101-101010101010",
    condition_id: "cond-cle-cin",
    token_id: "tok-cle-cin",
    selected_outcome: "Cleveland Guardians",
    score: 82,
    entry_price_num: 0.41,
    created_at: "2026-07-28T16:10:00.000Z", // T-90 boundary for a 17:40Z kickoff
    event_slug: "mlb-cle-cin-2026-07-27",
    market_slug: "$24K matched activity",
    diagnostics: {
      gameStartIso: "2026-07-28T17:40:00.000Z",
      providerEventContext: contractAProviderContext(),
    },
    ...overrides,
  };
}

test("Anchor-CA5 (P0 RED->GREEN): an activity-label display with an exact moneyline provider context and complete IDs is queue-eligible", async () => {
  const { candidates } = await buildFireModelCandidates(10, "all", true, [activityLabelSourceRow()], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.live_eligible, true, "an exact moneyline market behind an activity-label display must be queue-eligible");
  assert.equal(c.live_rejection_reason, null);
  assert.equal(c.activity_label_detected, false, "the display label must be replaced by the provider's own market question");
  assert.equal(
    c.market_slug,
    "Cleveland Guardians vs. Cincinnati Reds",
    "the queue-facing market question must come from providerEventContext, never the activity label"
  );
});

test("Anchor-CA6: an activity-label display with an exact approved SPREAD provider context and complete IDs is queue-eligible", async () => {
  const sourceRow = activityLabelSourceRow({
    id: "10101010-1010-4101-8101-101010101011",
    diagnostics: {
      gameStartIso: "2026-07-28T17:40:00.000Z",
      providerEventContext: contractAProviderContext({ game: "spread" }),
    },
  });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, true);
  assert.equal(candidates[0].live_rejection_reason, null);
});

test("Anchor-CA7: an activity-label display with an exact approved TOTAL provider context and complete IDs is queue-eligible", async () => {
  const sourceRow = activityLabelSourceRow({
    id: "10101010-1010-4101-8101-101010101012",
    diagnostics: {
      gameStartIso: "2026-07-28T17:40:00.000Z",
      providerEventContext: contractAProviderContext({ game: "total" }),
    },
  });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, true);
  assert.equal(candidates[0].live_rejection_reason, null);
});

test("Anchor-CA8: an activity-label display with NO provider context still fails closed (Anchor-CA1 unchanged)", async () => {
  const sourceRow = activityLabelSourceRow({
    id: "10101010-1010-4101-8101-101010101013",
    diagnostics: { gameStartIso: "2026-07-28T17:40:00.000Z" },
  });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false);
  assert.equal(candidates[0].activity_label_detected, true);
  assert.equal(candidates[0].live_rejection_reason, "CONTRACT_A_ACTIVITY_LABEL_MARKET");
});

test("Anchor-CA9: an activity-label display with provider context missing a stable event id still fails closed", async () => {
  const sourceRow = activityLabelSourceRow({
    id: "10101010-1010-4101-8101-101010101014",
    diagnostics: {
      gameStartIso: "2026-07-28T17:40:00.000Z",
      providerEventContext: contractAProviderContext({ eventId: "", eventSlug: "" }),
    },
  });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false, "missing stable provider event identity must not rescue an activity label");
  assert.equal(candidates[0].live_rejection_reason, "CONTRACT_A_ACTIVITY_LABEL_MARKET");
});

test("Anchor-CA10: an activity-label display with provider context missing eventStartIso still fails closed", async () => {
  const sourceRow = activityLabelSourceRow({
    id: "10101010-1010-4101-8101-101010101015",
    diagnostics: {
      gameStartIso: "2026-07-28T17:40:00.000Z",
      providerEventContext: contractAProviderContext({ eventStartIso: "" }),
    },
  });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false, "missing stable provider event start must not rescue an activity label");
  assert.equal(candidates[0].live_rejection_reason, "CONTRACT_A_ACTIVITY_LABEL_MARKET");
});

test("Anchor-CA11: an activity-label display with provider context missing marketQuestion still fails closed", async () => {
  const sourceRow = activityLabelSourceRow({
    id: "10101010-1010-4101-8101-101010101016",
    diagnostics: {
      gameStartIso: "2026-07-28T17:40:00.000Z",
      providerEventContext: contractAProviderContext({ marketQuestion: "" }),
    },
  });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false, "missing the provider's own market question must not rescue an activity label");
  assert.equal(candidates[0].live_rejection_reason, "CONTRACT_A_ACTIVITY_LABEL_MARKET");
});

test("Anchor-CA12: an activity-label display whose provider context is itself a partial/prop market (map/set/round) still fails closed", async () => {
  const sourceRow = activityLabelSourceRow({
    id: "10101010-1010-4101-8101-101010101017",
    diagnostics: {
      gameStartIso: "2026-07-28T17:40:00.000Z",
      providerEventContext: contractAProviderContext({
        marketQuestion: "Cleveland Guardians vs. Cincinnati Reds - Game 1 Winner",
        game: "moneyline",
      }),
    },
  });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false, "a partial/segment market must never be rescued by the provider-context override");
});

test("Anchor-CA13: an activity-label display whose provider context is a player prop still fails closed", async () => {
  const sourceRow = activityLabelSourceRow({
    id: "10101010-1010-4101-8101-101010101018",
    diagnostics: {
      gameStartIso: "2026-07-28T17:40:00.000Z",
      providerEventContext: contractAProviderContext({
        marketQuestion: "Player Prop: Total Home Runs Over 1.5",
        game: "moneyline",
      }),
    },
  });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false, "a player prop must never be rescued by the provider-context override");
});

test("Anchor-CA14: the exact rescued identity (condition_id/token_id/side) reaches the candidate and queue row unchanged, never synthesized", async () => {
  const sourceRow = activityLabelSourceRow({ id: "10101010-1010-4101-8101-101010101019" });
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.condition_id, "cond-cle-cin");
  assert.equal(c.token_id, "tok-cle-cin");
  assert.equal(c.side, "Cleveland Guardians");
});

test("Anchor-CA1 (regression, unchanged): the production KC handicap / activity-label candidate is still not queue-eligible", async () => {
  const sourceRow = {
    id: "66666666-6666-4666-8666-666666666666",
    condition_id: "cond-ca-kc-handicap",
    token_id: "tok-ca-kc-handicap",
    selected_outcome: "Karmine Corp",
    score: 82,
    entry_price_num: 0.4,
    created_at: "2026-07-24T13:30:00.000Z",
    event_slug: "Game Handicap: KC (-1.5) vs Team Vitality (+1.5)",
    market_slug: "$52K matched activity",
    diagnostics: { gameStartIso: "2026-07-24T15:00:00.000Z" },
  };
  const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow], "CONTRACT_A_V1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].live_eligible, false);
  assert.equal(candidates[0].live_rejection_reason, "CONTRACT_A_ACTIVITY_LABEL_MARKET");
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

function multiEventAuthorityFixture(n: number) {
  const legacy = multiEventFixture(n);
  const sourceIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const authorities = legacy.reservations.map((reservation, index) =>
    createQueueAuthorityFixture(IN_WINDOW_MS, reservation, legacy.candidates[index], sourceIds[index])
  );
  return {
    reservations: authorities.map((authority) => authority.reservation),
    fetchFinalIdentitySourceRows: async (reservation: NightEventReservationRow) => {
      const authority = authorities.find((item) => item.reservation.id === reservation.id);
      return authority ? [authority.sourceRow] : [];
    },
    fetchExactTokenOrderbook: async (tokenId: string) => {
      const authority = authorities.find((item) => item.sourceRow.token_id === tokenId);
      if (!authority) return { ok: false as const, tokenId, latencyMs: 1, errorCode: "FIXTURE_TOKEN_NOT_FOUND" };
      return authority.fetchExactTokenOrderbook();
    },
  };
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
  const { reservations, fetchFinalIdentitySourceRows, fetchExactTokenOrderbook } = multiEventAuthorityFixture(3);
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 2 },
    { repo, fetchFinalIdentitySourceRows, fetchExactTokenOrderbook }
  );
  assert.equal(result.blocked_by_max_queue_writes, true);
  assert.equal(result.queued_count, 0, "MAX_QUEUE_WRITES_EXCEEDED must block all writes, not partially write");
  assert.equal(repo.queueRows.length, 0);
  assert.equal(repo.skippedCalls.length, 0, "no reservation should even be marked skipped when the whole run is blocked");
  assert.equal(repo.queuedStatusCalls.length, 0);
  assert.equal(result.wrote, false);
});

test("Cap-3: write mode allows and writes exactly the planned rows when within the cap", async () => {
  const { reservations, fetchFinalIdentitySourceRows, fetchExactTokenOrderbook } = multiEventAuthorityFixture(2);
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 2 },
    { repo, fetchFinalIdentitySourceRows, fetchExactTokenOrderbook }
  );
  assert.equal(result.blocked_by_max_queue_writes, false);
  assert.equal(result.queued_count, 2);
  assert.equal(repo.queueRows.length, 2);
  assert.equal(result.planned_queue_writes, 2);
});

test("Cap-4: omitting maxQueueWrites preserves current unlimited behavior", async () => {
  const { reservations, fetchFinalIdentitySourceRows, fetchExactTokenOrderbook } = multiEventAuthorityFixture(3);
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchFinalIdentitySourceRows, fetchExactTokenOrderbook }
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
  const founderStart = routeSource.indexOf("if (founderBattleBatch) {");
  const founderEnd = routeSource.indexOf("// Canary identity-targeted rebalance", founderStart);
  assert.ok(founderStart >= 0 && founderEnd > founderStart, "expected to find the founderBattleBatch branch");
  assert.doesNotMatch(routeSource.slice(founderStart, founderEnd), /maxQueueWrites/);
});

test("Cap-7: controlledLiveIntent is structurally unaffected -- the route never threads maxQueueWrites into runControlledLiveIntent", () => {
  const routeSource = readFileSync(path.join(root, "app/api/cron/event-rebalance/route.ts"), "utf8");
  const controlledStart = routeSource.indexOf("if (controlledLiveIntent !== null) {");
  const controlledEnd = routeSource.indexOf("const maxQueueWritesParsed", controlledStart);
  assert.ok(controlledStart >= 0 && controlledEnd > controlledStart, "expected to find the controlledLiveIntent branch");
  assert.doesNotMatch(routeSource.slice(controlledStart, controlledEnd), /maxQueueWrites/);
});

// ── Contract A planning → final authoritative identity handoff ───────────────
//
// SUPERSEDED CONTRACT (night-plan:2026-07-24 incident, R0E identity contract):
// rebalance no longer REDISCOVERS a market for a planning reservation via
// source lineage / normalized slug / match_family_key. Planning resolves the
// immutable execution identity BEFORE the reservation slot is consumed and
// persists it; rebalance only VALIDATES those exact IDs against the
// authoritative universe. A string join can no longer select a token.

const LINEAGE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function planningReservation(overrides: Partial<NightEventReservationRow> = {}): NightEventReservationRow {
  return baseReservation({
    id: "res-la-spread",
    match_family_key: "WEAK_SINGLE_TEAM_SPREAD:los-angeles-angels:2026-07-19", // un-prefixed weak key
    event_slug: "", // empty slug — the exact production defect shape
    best_snapshot_id: LINEAGE_UUID,
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      // Immutable identity resolved at planning time and persisted verbatim.
      authoritative_condition_id: "cond-la-final",
      authoritative_token_id: "tok-la-final",
      authoritative_side: "Los Angeles Angels",
      authoritative_observation_id: "obs-la-final",
      authoritative_event_key: "pair:chicago-white-sox-vs-los-angeles-angels:2026-07-19",
      identity_physical_event_key: "pair:chicago-white-sox-vs-los-angeles-angels:2026-07-19",
      identity_market_type: "TIER1_CORE_STRICT_72_COV50",
      identity_market_family: "contract_a_authoritative",
      identity_source_signal_id: LINEAGE_UUID,
    },
    ...overrides,
  });
}

function finalAuthoritativeCandidate(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return baseCandidate({
    condition_id: "cond-la-final",
    token_id: "tok-la-final",
    side: "Los Angeles Angels",
    selected_outcome: "Los Angeles Angels",
    generated_signal_pair_id: LINEAGE_UUID, // same generated_signal_pairs.id as reservation.best_snapshot_id
    match_family_key: "match:mlb-laa-spread", // PREFIXED final key (different space than planning)
    event_slug: "MLB-LAA-CWS-2026-07-22", // raw/uppercase (final never lowercases)
    stake_usd: 1.1,
    ...overrides,
  });
}

test("CA-Handoff-A (identity validation): a planning reservation with empty slug + un-prefixed key QUEUES because its PERSISTED identity is found in the authoritative universe", async () => {
  const repo = makeFakeRepo([planningReservation()]);
  const final = finalAuthoritativeCandidate();
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    {
      repo,
      fetchCandidates: async () => ({ candidates: [] }),
      fetchContractAFinalCandidates: async () => ({ candidates: [final] }),
    }
  );
  assert.equal(result.queued_count, 1, "planning reservation must validate its stored identity and QUEUE");
  assert.equal(repo.queueRows.length, 0, "legacy stored-identity validation remains read-only");
  const row = result.outcomes[0]?.queue_row!;
  assert.equal(row.condition_id, "cond-la-final", "cond copied verbatim from the stored identity");
  assert.equal(row.token_id, "tok-la-final");
  assert.equal(row.side, "Los Angeles Angels");
  assert.equal(row.stake_usd, 1.1, "stake stays $1.10");
  assert.equal((row.diagnostics as Record<string, unknown>).source_signal_id, LINEAGE_UUID, "source_signal_id remains the valid UUID");
});

test("CA-Handoff-B (no slug rediscovery): the stored identity alone decides -- a slug-only match with different IDs is never selected", async () => {
  const repo = makeFakeRepo([planningReservation()]);
  // Same normalized slug as the reservation would have had, but DIFFERENT IDs.
  const slugTwin = finalAuthoritativeCandidate({
    condition_id: "cond-OTHER",
    token_id: "tok-OTHER",
    side: "Chicago White Sox",
    selected_outcome: "Chicago White Sox",
  });
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [] }), fetchContractAFinalCandidates: async () => ({ candidates: [slugTwin] }) }
  );
  assert.equal(result.queued_count, 0, "a same-slug/different-ID market must never be substituted");
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /CONTRACT_A_AUTHORITATIVE_MARKET_NOT_FOUND: SOURCE_CHANGED_SINCE_PLANNING/);
});

test("CA-Handoff-C (no unsafe fuzzy match): similar titles/teams but no candidate carrying the stored IDs -> fail closed, no queue row", async () => {
  const nearMissA = finalAuthoritativeCandidate({ condition_id: "other-1", token_id: "tok-1", event_slug: "los-angeles-angels-moneyline", match_family_key: "match:a" });
  const nearMissB = finalAuthoritativeCandidate({ condition_id: "other-2", token_id: "tok-2", event_slug: "los-angeles-dodgers-spread", match_family_key: "match:b" });
  const repo = makeFakeRepo([planningReservation()]);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [] }), fetchContractAFinalCandidates: async () => ({ candidates: [nearMissA, nearMissB] }) }
  );
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /CONTRACT_A_AUTHORITATIVE_MARKET_NOT_FOUND/);
});

test("CA-Handoff-C2 (ambiguity fails closed): two final candidates carry the same stored identity -> never guess", async () => {
  const repo = makeFakeRepo([planningReservation()]);
  const a = finalAuthoritativeCandidate({ market_slug: "a" });
  const b = finalAuthoritativeCandidate({ market_slug: "b" }); // identical IDs
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [] }), fetchContractAFinalCandidates: async () => ({ candidates: [a, b] }) }
  );
  assert.equal(result.queued_count, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /AMBIGUOUS_IDENTITY_MATCH/);
});

test("CA-Handoff-D (stored identity is authoritative): fresh price/telemetry is taken from the located candidate, but a candidate with DIFFERENT IDs can never be queued", async () => {
  // Fresh telemetry on the SAME identity is used.
  const repoOk = makeFakeRepo([planningReservation()]);
  const fresh = finalAuthoritativeCandidate({ max_entry_price: 0.51 });
  const ok = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo: repoOk, fetchCandidates: async () => ({ candidates: [] }), fetchContractAFinalCandidates: async () => ({ candidates: [fresh] }) }
  );
  assert.equal(ok.queued_count, 1);
  assert.equal(repoOk.queueRows.length, 0, "legacy fresh-telemetry validation remains read-only");
  assert.equal(ok.outcomes[0]?.queue_row?.condition_id, "cond-la-final");
  assert.equal((ok.outcomes[0]?.queue_row?.diagnostics as Record<string, unknown>).max_entry_price, 0.51, "price cap from fresh final candidate");

  // Different IDs -> fail closed, never substituted.
  const repoDrift = makeFakeRepo([planningReservation()]);
  const drifted = finalAuthoritativeCandidate({ condition_id: "FRESH-cond", token_id: "FRESH-tok", side: "FRESH-side", selected_outcome: "FRESH-side" });
  const drift = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo: repoDrift, fetchCandidates: async () => ({ candidates: [] }), fetchContractAFinalCandidates: async () => ({ candidates: [drifted] }) }
  );
  assert.equal(drift.queued_count, 0);
  assert.equal(repoDrift.queueRows.length, 0);
  assert.match(drift.outcomes[0]?.reason ?? "", /SOURCE_CHANGED_SINCE_PLANNING/);
});

test("CA-Handoff-E (no regression): a FINAL_AUTHORITATIVE legacy reservation still queues its exact stored authoritative market unchanged", async () => {
  // Mirrors the pre-existing D1 legacy path (selector = FROZEN_MODEL_V2_VERSION),
  // which must be entirely unaffected by the planning-branch change.
  const legacyReservation = baseReservation({
    id: "res-legacy",
    diagnostics: {
      selector_id: "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M",
      authoritative_condition_id: "cond-market-A",
      authoritative_token_id: "tok-market-A",
      authoritative_side: "Spain",
      authoritative_observation_id: "obs-1",
      authoritative_event_key: "pair:argentina-vs-spain:2026-07-19",
    },
  });
  const repo = makeFakeRepo([legacyReservation]);
  const marketA = baseCandidate({ condition_id: "cond-market-A", token_id: "tok-market-A", side: "Spain", selected_outcome: "Spain" });
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [marketA] }) }
  );
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 0, "legacy FINAL_AUTHORITATIVE validation remains read-only");
  assert.equal(result.outcomes[0]?.queue_row?.condition_id, "cond-market-A");
  assert.equal(result.outcomes[0]?.queue_row?.token_id, "tok-market-A");
});

// ── CANONICAL READY PRODUCER CERTIFICATION (integration, real production fns) ─
//
// Drives the ACTUAL production orchestration (runEventRebalance ->
// selectQueueRowForDueReservation -> readPersistedExecutableIdentity
// -> findCandidateForStoredIdentity -> isExecutableMarket -> buildQueueRow) with a Chicago/Detroit-shaped
// single-team-spread planning reservation, then serializes the built row
// through the REAL /api/executor/queue serializer (mapQueueRowToIrelandCandidate).
// No mock reimplementation, no dry-run endpoint, no DB, no writes.

const CHI_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function chicagoPlanningReservation(overrides: Partial<NightEventReservationRow> = {}): NightEventReservationRow {
  return baseReservation({
    id: "res-cws-spread",
    event_title: "Chicago White Sox vs Detroit Tigers",
    sport: "baseball",
    strategic_scope: "MLB",
    match_family_key: "WEAK_SINGLE_TEAM_SPREAD:chicago-white-sox:2026-07-19",
    event_slug: "", // empty slug — the production defect shape
    best_snapshot_id: CHI_UUID,
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      authoritative_condition_id: "cond-cws-final",
      authoritative_token_id: "tok-cws-final",
      authoritative_side: "Chicago White Sox",
      authoritative_observation_id: "obs-cws-final",
      authoritative_event_key: "pair:chicago-white-sox-vs-detroit-tigers:2026-07-19",
      identity_physical_event_key: "pair:chicago-white-sox-vs-detroit-tigers:2026-07-19",
      identity_market_type: "TIER1_CORE_STRICT_72_COV50",
      identity_market_family: "contract_a_authoritative",
      identity_source_signal_id: CHI_UUID,
    },
    ...overrides,
  });
}

function chicagoFinalCandidate(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return baseCandidate({
    condition_id: "cond-cws-final",
    token_id: "tok-cws-final",
    side: "Chicago White Sox",
    selected_outcome: "Chicago White Sox",
    generated_signal_pair_id: CHI_UUID,
    match_family_key: "match:mlb-cws-spread", // prefixed final key (different space)
    event_slug: "chicago-white-sox-vs-detroit-tigers-2026-07-19",
    market_slug: "chicago-white-sox-vs-detroit-tigers-moneyline",
    max_entry_price: 0.58,
    stake_usd: 1.1,
    ...overrides,
  });
}

async function runCanonicalProducer(
  reservationOverrides: Partial<NightEventReservationRow> = {},
  finalOverrides: Partial<FireModelCandidate> = {},
  nowMs: number = IN_WINDOW_MS,
) {
  const final = chicagoFinalCandidate(finalOverrides);
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, chicagoPlanningReservation(), final, CHI_UUID);
  const reservation = { ...authority.reservation, ...reservationOverrides };
  const repo = makeFakeRepo([reservation]);
  const result = await runEventRebalance(
    nowMs,
    { write: true },
    {
      repo,
      fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows,
      fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook,
    },
  );
  return { repo, result, final };
}

test("CERT: canonical READY producer positive acceptance matrix (01-13) via real functions + real /api/executor/queue serializer", async () => {
  const { repo, result } = await runCanonicalProducer();

  // 12 one physical event -> exactly one queue row
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
  const row = repo.queueRows[0];
  const diag = row.diagnostics as Record<string, unknown>;

  // 01 located by exact stored-identity validation (empty slug + un-prefixed key
  //    prove no string join was involved).
  // 02/03/04 final Contract A cond/token/side used (identical to the stored identity).
  assert.equal(row.condition_id, "cond-cws-final");
  assert.equal(row.token_id, "tok-cws-final");
  assert.equal(row.side, "Chicago White Sox");
  // 07 stake_usd = 1.10
  assert.equal(row.stake_usd, 1.1);
  // 08 max_entry_price present + numeric
  assert.equal(typeof diag.max_entry_price, "number");
  assert.equal(diag.max_entry_price, 0.58);
  // 09 selected raw provider-row lineage is preserved without Final Identity.
  const lineage = diag.source_lineage as { generated_signal_pair_id: string };
  assert.equal(lineage.generated_signal_pair_id, diag.selected_signal_pair_id);
  assert.ok(lineage.generated_signal_pair_id.length > 0);
  // 10 status emitted is READY
  assert.equal(row.status, "READY");
  // 11 idempotency_key present + stable (deterministic sha256 of plan_run_id::order_key)
  assert.ok(typeof row.idempotency_key === "string" && row.idempotency_key.length > 0);

  // Serialize through the REAL production wire serializer.
  const wire = mapQueueRowToIrelandCandidate(row, IN_WINDOW_MS);
  // 02/03/04 preserved on the wire
  assert.equal(wire.condition_id, "cond-cws-final");
  assert.equal(wire.token_id, "tok-cws-final");
  assert.equal(wire.side, "Chicago White Sox");
  // 05 executable projection (is_executable true) / 06 timing (entry_state)
  assert.equal(wire.is_executable, true);
  assert.ok(wire.entry_state === "IN_WINDOW" || wire.entry_state === "PENDING_WINDOW");
  // 07 stake on wire / 08 max_entry_price + price_cap alias
  assert.equal(wire.stake_usd, 1.1);
  assert.equal(wire.max_stake_usd, 1.1);
  assert.equal(wire.max_entry_price, 0.58);
  assert.equal(wire.price_cap, 0.58);
  // 11 idempotency_key on wire
  assert.equal(wire.idempotency_key, row.idempotency_key);
});

test("CERT: 11/13 idempotency_key is stable across a duplicate invocation and 13 no second row is created", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, chicagoPlanningReservation(), chicagoFinalCandidate(), CHI_UUID);
  const reservation = authority.reservation;
  const repo = makeFakeRepo([reservation]);
  const deps = { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook };
  const first = await runEventRebalance(IN_WINDOW_MS, { write: true }, deps);
  assert.equal(first.queued_count, 1);
  const firstKey = repo.queueRows[0].idempotency_key;

  // Re-surface the reservation (simulate a race/retry re-read, mirrors B4): it is
  // active again AND already in the queued set -> alreadyQueued must block a second row.
  reservation.status = "REBALANCE_PENDING";
  const second = await runEventRebalance(IN_WINDOW_MS, { write: true }, deps);
  assert.equal(second.already_queued_count, 1);
  assert.equal(second.queued_count, 0);
  assert.equal(repo.queueRows.length, 1, "duplicate invocation must not create a second queue row");
  assert.equal(repo.queueRows[0].idempotency_key, firstKey, "idempotency_key stable");
});

test("CERT: 06/14 a stale (past T-3) reservation cannot become READY -- no queue row, no serialization", async () => {
  const { repo, result } = await runCanonicalProducer({}, {}, AFTER_WINDOW_MS);
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0, "stale reservation must never produce a READY row");
});

// ── Negative filter matrix: mutate ONE field, assert the exact fail-closed result.

test("CERT-NEG: no identity persisted on the reservation -> SKIPPED CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE: IDENTITY_NOT_PERSISTED, no row", async () => {
  const { repo, result } = await runCanonicalProducer(
    { diagnostics: { selector_id: "CONTRACT_A_PLANNING_V1", contract_a_stage: "PLANNING" } },
  );
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(repo.skippedCalls[0].reason, "RESERVATION_EXACT_EVENT_LINEAGE_INCOMPLETE");
});

test("CERT-NEG: the typed Final Identity producer explicitly fails closed unless exactly one candidate matches", () => {
  const source = readFileSync(path.join(root, "lib/executor/contractADecisions.ts"), "utf8");
  assert.match(source, /if \(matches\.length !== 1\)/);
  assert.match(source, /matches\.length === 0 \? "NO_FINAL_IDENTITY_CANDIDATE" : "AMBIGUOUS_FINAL_IDENTITY_CANDIDATE"/);
});

test("CERT-NEG: outside timing window (before T-70) -> not due, no queue row", async () => {
  const { repo, result } = await runCanonicalProducer({}, {}, BEFORE_WINDOW_MS);
  assert.equal(result.due_count, 0);
  assert.equal(repo.queueRows.length, 0);
});

test("CERT-NEG: exact provider row missing token_id -> SKIPPED, not queued", async () => {
  // The stored token_id no longer exists in the authoritative universe.
  const { repo, result } = await runCanonicalProducer({}, { token_id: "" });
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(repo.skippedCalls[0].reason, "NO_EXACT_RESERVED_EVENT_SIGNAL_PAIR");
});

test("CERT-NEG: invalid stake (non-positive) on final candidate -> not executable, no queue row", async () => {
  const repo = makeFakeRepo([baseReservation()]);
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, {
    repo,
    fetchCandidates: async () => ({ candidates: [baseCandidate({ stake_usd: 0 })] }),
  });
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.match(result.outcomes[0]?.reason ?? "", /RESERVATION_REQUIRED_USE_EVENT_REBALANCE/);
});

test("CERT-NEG: partially persisted identity (condition_id only) -> IDENTITY_INCOMPLETE with the exact missing-field code", async () => {
  const { repo, result } = await runCanonicalProducer({
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      authoritative_condition_id: "cond-cws-final",
    },
  });
  assert.equal(result.queued_count, 0);
  assert.equal(repo.skippedCalls[0].reason, "RESERVATION_EXACT_EVENT_LINEAGE_INCOMPLETE");
});

test("CERT-NEG: queue-route serializer exposes no secret-bearing field (no diagnostics blob, no source_signal_id, no keys/tokens beyond order identity)", async () => {
  const { repo } = await runCanonicalProducer();
  const wire = mapQueueRowToIrelandCandidate(repo.queueRows[0], IN_WINDOW_MS);
  const keys = Object.keys(wire);
  // The wire payload must not carry the raw diagnostics blob or the internal source_signal_id.
  assert.equal(keys.includes("diagnostics"), false);
  assert.equal(keys.includes("source_signal_id"), false);
  // No field name suggests a secret/credential.
  for (const k of keys) {
    assert.doesNotMatch(k, /secret|password|apikey|api_key|private|passphrase|authorization/i);
  }
});
