// Canary identity-targeted rebalance:
//   node --import tsx --test tests/contur3/targetedRebalance.test.ts
//
// Proves runEventRebalance's targetReservationId seam processes exactly one
// Reservation through the SAME production selection path
// (selectQueueRowForDueReservation / buildQueueRow), forces maxQueueWrites=1,
// and leaves every other active Reservation completely untouched.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import { buildFireModelCandidates, type FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import { createQueueAuthorityFixture } from "./helpers/queueAuthorityFixtures";

const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
// T-70..T-3 window for a 19:00Z kickoff = 17:50Z..18:57Z.
const IN_WINDOW_MS = Date.parse("2026-07-19T18:00:00.000Z"); // T-60m

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

// ── RED (on origin/main, opts.targetReservationId does not exist and is
// silently ignored -- the result would not carry target_reservation_matched
// at all, so this whole suite fails to type-check / asserts undefined). ────

// ── Positive: targeted rebalance processes exactly the one Reservation ────

test("TARGETED-1: targetReservationId queues exactly that Reservation via the real selection path", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation({ id: "res-a" }), baseCandidate());
  const reservations = [authority.reservation];
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 1, targetReservationId: "res-a" },
    { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
  );
  assert.equal(result.target_reservation_matched, true);
  assert.equal(result.target_reservation_id, "res-a");
  assert.equal(result.due_count, 1);
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.queueRows[0].reservation_id, "res-a");
  assert.equal(repo.queueRows[0].condition_id, "cond-esp-arg");
  assert.equal(repo.queueRows[0].token_id, "token-esp-arg-spain");
});

// ── Positive: other due Reservations are left completely untouched ────────

test("TARGETED-2: a second due Reservation is never touched by the targeted run", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation({ id: "res-a" }), baseCandidate());
  const reservations = [
    authority.reservation,
    baseReservation({
      id: "res-b",
      match_family_key: "pair:brazil-vs-uruguay:2026-07-19",
      event_title: "Brazil vs Uruguay",
    }),
  ];
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 1, targetReservationId: "res-a" },
    {
      repo,
      fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows,
      fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook,
    }
  );
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.queueRows[0].reservation_id, "res-a");
  // res-b was never marked queued, skipped, or expired, and never inserted into the queue.
  assert.equal(reservations[1].status, "RESERVED");
  assert.equal(repo.skippedCalls.length, 0);
  assert.equal(repo.expiredCalls.length, 0);
  assert.equal(repo.queuedStatusCalls.length, 1);
  assert.equal(repo.queuedStatusCalls[0].id, "res-a");
});

// ── Negative: a count-only cap is insufficient -- max_queue_writes forced to 1 ─

test("TARGETED-3: maxQueueWrites is forced to 1 in targeted mode regardless of due count", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation({ id: "res-a" }), baseCandidate());
  const reservations = [authority.reservation];
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 1, targetReservationId: "res-a" },
    { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
  );
  assert.equal(result.max_queue_writes, 1);
  assert.equal(result.queue_rows_created, 1);
});

// ── Negative: missing target Reservation → fail closed ─────────────────────

test("TARGETED-4: an unknown targetReservationId fails closed -- zero writes, zero due", async () => {
  const reservations = [baseReservation({ id: "res-a" })];
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 1, targetReservationId: "res-does-not-exist" },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }) }
  );
  assert.equal(result.target_reservation_matched, false);
  assert.equal(result.due_count, 0);
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(result.first_rejection_code, "CANARY_RESERVATION_NOT_FOUND");
  // res-a (the real, due reservation) must remain untouched -- targeting an
  // unrelated id must never fall back to processing whatever is due instead.
  assert.equal(reservations[0].status, "RESERVED");
});

// ── Negative: target Reservation exists but is not yet due → fail closed ──

test("TARGETED-5: a Reservation that exists but is not yet due is treated as not found (never bypasses timing)", async () => {
  const NOT_DUE_YET_MS = Date.parse("2026-07-19T16:00:00.000Z"); // T-180m, well before T-70
  const reservations = [baseReservation({ id: "res-a" })];
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    NOT_DUE_YET_MS,
    { write: true, maxQueueWrites: 1, targetReservationId: "res-a" },
    { repo, fetchCandidates: async () => ({ candidates: [baseCandidate()] }) }
  );
  assert.equal(result.target_reservation_matched, false);
  assert.equal(repo.queueRows.length, 0);
});

// ── Negative: ambiguous/missing final exact market → zero READY rows ──────

test("TARGETED-6: no executable market for the targeted Reservation → zero READY rows, skip recorded", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation({ id: "res-a" }), baseCandidate());
  const reservations = [authority.reservation];
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 1, targetReservationId: "res-a" },
    { repo, fetchFinalIdentitySourceRows: async () => [], fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
  );
  assert.equal(result.target_reservation_matched, true);
  assert.equal(result.queued_count, 0);
  assert.equal(result.skipped_count, 1);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(result.first_rejection_code, "CONTRACT_A_FINAL_IDENTITY_REJECTED");
  assert.equal(result.outcomes[0]?.reason, "CONTRACT_A_FINAL_IDENTITY_REJECTED: NO_FINAL_IDENTITY_CANDIDATE");
});

// ── Negative: no condition/token/side is ever synthesized ──────────────────

test("TARGETED-7: the queued row's identity comes only from the real candidate -- never synthesized", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation({ id: "res-a" }), baseCandidate());
  const reservations = [authority.reservation];
  const repo = makeFakeRepo(reservations);
  await runEventRebalance(
    IN_WINDOW_MS,
    { write: true, maxQueueWrites: 1, targetReservationId: "res-a" },
    { repo, fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows, fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook }
  );
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.queueRows[0].condition_id, "cond-esp-arg");
  assert.equal(repo.queueRows[0].token_id, "token-esp-arg-spain");
  assert.equal(repo.queueRows[0].side, "Spain");
});

// ── Negative: no CLOB / Ireland calls -- dry-run mode writes nothing ───────

test("TARGETED-8: dry-run canary (write=false) computes the same outcome without any repo write", async () => {
  const authority = createQueueAuthorityFixture(IN_WINDOW_MS, baseReservation({ id: "res-a" }), baseCandidate());
  const reservations = [authority.reservation];
  const repo = makeFakeRepo(reservations);
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: false, maxQueueWrites: 1, targetReservationId: "res-a" },
    {
      repo,
      fetchCandidates: async () => ({ candidates: [baseCandidate()] }),
      fetchFinalIdentitySourceRows: authority.fetchFinalIdentitySourceRows,
      fetchExactTokenOrderbook: authority.fetchExactTokenOrderbook,
    }
  );
  assert.equal(result.target_reservation_matched, true);
  assert.equal(result.queued_count, 1, "dry-run still reports what WOULD be queued");
  assert.equal(repo.queueRows.length, 0, "dry-run performs zero writes");
  assert.equal(repo.queuedStatusCalls.length, 0);
});
