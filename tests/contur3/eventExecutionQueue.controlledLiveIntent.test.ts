// Contur3 controlled one-shot live-intent seam tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Proves the controlled-live-intent branch (runControlledLiveIntent) reuses
// the exact same due-reservation loading, authoritative-candidate selection
// and buildQueueRow() as the normal scheduled rebalance -- it can never
// accept a caller-supplied market identity, stake, or idempotency key, it
// writes at most one row, and it never changes normal-mode behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import {
  runEventRebalance,
  runControlledLiveIntent,
  validateControlledLiveIntentRequest,
  applyControlledLiveIntentOverrides,
  buildQueueRow,
  CONTROLLED_LIVE_TEST_ID,
  CONTROLLED_LIVE_STAKE_CAP_USD,
  CONTROLLED_LIVE_PROVENANCE,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import { buildRebalanceRunId } from "../../lib/executor/nightWindow";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
// T-60m from a 19:00Z kickoff, inside the T-70..T-3 rebalance window.
const IN_WINDOW_MS = Date.parse("2026-07-19T18:00:00.000Z");

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
} {
  const queueRows: EventExecutionQueueRow[] = [];
  const queuedReservationIds = new Set<string>();
  return {
    queueRows,
    queuedReservationIds,
    async loadActiveReservations() {
      return reservations.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING");
    },
    async loadQueuedReservationIds() {
      return new Set(queuedReservationIds);
    },
    async markReservationsExpired(ids) {
      for (const r of reservations) if (ids.includes(r.id as string)) r.status = "EXPIRED";
    },
    async markReservationSkipped(id, reason) {
      const r = reservations.find((x) => x.id === id);
      if (r) { r.status = "SKIPPED"; r.selection_reason = reason; }
    },
    async insertQueueRow(row) {
      queueRows.push(row);
      if (row.reservation_id) queuedReservationIds.add(row.reservation_id);
    },
    async markReservationQueued(id, reason) {
      const r = reservations.find((x) => x.id === id);
      if (r) { r.status = "QUEUED"; r.selection_reason = reason; }
    },
    async findQueueRowsByRebalanceRunId(rebalanceRunId) {
      return queueRows.filter((r) => r.rebalance_run_id === rebalanceRunId);
    },
  };
}

test("CTL1: controlled mode rejects any id other than the exact fixed test id, with zero repo interaction", async () => {
  const throwingRepo: RebalanceRepoPort = {
    async loadActiveReservations() { throw new Error("must not be called"); },
    async loadQueuedReservationIds() { throw new Error("must not be called"); },
    async markReservationsExpired() { throw new Error("must not be called"); },
    async markReservationSkipped() { throw new Error("must not be called"); },
    async insertQueueRow() { throw new Error("must not be called"); },
    async markReservationQueued() { throw new Error("must not be called"); },
    async findQueueRowsByRebalanceRunId() { throw new Error("must not be called"); },
  };

  for (const bad of ["founder-live-order-20260721-002", "FOUNDER-LIVE-ORDER-20260721-001", "", null, undefined, 123, {}]) {
    const result = await runControlledLiveIntent(IN_WINDOW_MS, bad, { write: true }, { repo: throwingRepo });
    assert.equal(result.kind, "BLOCKED_INVALID_REQUEST");
    assert.equal(result.reason, "CONTROLLED_LIVE_INTENT_ID_MISMATCH");
    assert.equal(result.wrote, false);
  }

  const validation = validateControlledLiveIntentRequest(CONTROLLED_LIVE_TEST_ID);
  assert.equal(validation.ok, true);
});

test("CTL2: controlled mode preserves the normal canonical derived idempotency_key", async () => {
  const reservation = baseReservation();
  const candidate = baseCandidate();
  const repo = makeFakeRepo([reservation]);

  const result = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [candidate] }) }
  );

  assert.equal(result.kind, "CREATED");
  const expectedRebalanceRunId = buildRebalanceRunId(IN_WINDOW_MS);
  const canonicalRow = buildQueueRow(reservation, candidate, expectedRebalanceRunId);
  assert.equal(result.queue_row?.idempotency_key, canonicalRow.idempotency_key);
  assert.equal(result.queue_row?.order_key, canonicalRow.order_key);
  assert.equal(result.queue_row?.condition_id, canonicalRow.condition_id);
  assert.equal(result.queue_row?.token_id, canonicalRow.token_id);
  assert.equal(result.queue_row?.side, canonicalRow.side);
});

test("CTL3: controlled mode never accepts caller-provided market identity or idempotency key -- the API surface has no such parameters", async () => {
  // runControlledLiveIntent's only inputs besides nowMs/opts/deps is the
  // requested test id string itself -- there is no condition_id/token_id/
  // side/market/idempotency_key parameter anywhere in its signature. Prove
  // the produced row's identity comes only from the authoritative candidate.
  const reservation = baseReservation();
  const candidate = baseCandidate({ condition_id: "cond-real", token_id: "token-real", side: "RealSide" });
  const repo = makeFakeRepo([reservation]);

  const result = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [candidate] }) }
  );

  assert.equal(result.queue_row?.condition_id, "cond-real");
  assert.equal(result.queue_row?.token_id, "token-real");
  assert.equal(result.queue_row?.side, "RealSide");
});

test("CTL4: controlled mode uses the authoritative Contract A candidate, never a higher-scoring alternate", async () => {
  const AUTH_SELECTOR_ID = "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M";
  const reservation = baseReservation({
    diagnostics: {
      selector_id: AUTH_SELECTOR_ID,
      authoritative_condition_id: "cond-market-A",
      authoritative_token_id: "tok-market-A",
      authoritative_side: "Spain",
      authoritative_observation_id: "obs-esp-arg-1",
      authoritative_event_key: "pair:argentina-vs-spain:2026-07-19",
    },
  });
  const marketA = baseCandidate({ condition_id: "cond-market-A", token_id: "tok-market-A", side: "Spain", selected_outcome: "Spain" });
  const marketB = baseCandidate({
    condition_id: "cond-market-B",
    token_id: "tok-market-B",
    side: "Argentina",
    selected_outcome: "Argentina",
    diagnostics: {
      executor_action: "BET_OR_PAPER_GO",
      paper_only: false,
      real_trade: false,
      score: 99,
      coverage: 99,
      smart_money: 99,
      entry_price: 0.5,
      game_start_iso: KICKOFF_ISO,
      hours_to_start_now: 1,
      fire_model_alias: "FireModel1",
      version: "v2-lite-growth-safe",
    },
  });
  const repo = makeFakeRepo([reservation]);

  const result = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [marketB, marketA] }) }
  );

  assert.equal(result.kind, "CREATED");
  assert.equal(result.queue_row?.condition_id, "cond-market-A");
  assert.equal(result.queue_row?.token_id, "tok-market-A");
  assert.equal(result.queue_row?.side, "Spain");
});

test("CTL5: controlled mode writes at most one queue row when multiple reservations are due", async () => {
  const reservationA = baseReservation({ id: "res-a", match_family_key: "pair:a-vs-b:2026-07-19", event_slug: "a-vs-b" });
  const reservationB = baseReservation({ id: "res-b", match_family_key: "pair:c-vs-d:2026-07-19", event_slug: "c-vs-d" });
  const candidateA = baseCandidate({ match_family_key: "pair:a-vs-b:2026-07-19", event_slug: "a-vs-b", condition_id: "cond-a", token_id: "token-a" });
  const candidateB = baseCandidate({ match_family_key: "pair:c-vs-d:2026-07-19", event_slug: "c-vs-d", condition_id: "cond-b", token_id: "token-b" });
  const repo = makeFakeRepo([reservationA, reservationB]);

  const result = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [candidateA, candidateB] }) }
  );

  assert.equal(result.kind, "CREATED");
  assert.equal(repo.queueRows.length, 1, "must stop after the first successful queue insert");
});

test("CTL6: controlled mode caps stake_usd at 1.00 even when the candidate's own stake is higher", async () => {
  const reservation = baseReservation();
  const candidate = baseCandidate({ stake_usd: 7 });
  const repo = makeFakeRepo([reservation]);

  const result = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [candidate] }) }
  );

  assert.equal(result.queue_row?.stake_usd, CONTROLLED_LIVE_STAKE_CAP_USD);
  assert.equal(CONTROLLED_LIVE_STAKE_CAP_USD, 1);
});

test("CTL7: controlled mode stores the durable controlled test marker in existing correlation/provenance fields", async () => {
  const reservation = baseReservation();
  const candidate = baseCandidate();
  const repo = makeFakeRepo([reservation]);

  const result = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [candidate] }) }
  );

  assert.equal(result.queue_row?.rebalance_run_id, CONTROLLED_LIVE_TEST_ID);
  const diag = result.queue_row?.diagnostics as Record<string, unknown>;
  assert.equal(diag.controlled_live_intent, true);
  assert.equal(diag.controlled_test_id, CONTROLLED_LIVE_TEST_ID);
  assert.equal(diag.controlled_provenance, CONTROLLED_LIVE_PROVENANCE);
});

test("CTL8: repeating the same controlled test id after a matching row exists creates zero rows and returns ALREADY_EXISTS", async () => {
  const reservation = baseReservation();
  const candidate = baseCandidate();
  const repo = makeFakeRepo([reservation]);

  const first = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [candidate] }) }
  );
  assert.equal(first.kind, "CREATED");
  assert.equal(repo.queueRows.length, 1);

  const second = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [candidate] }) }
  );
  assert.equal(second.kind, "ALREADY_EXISTS");
  assert.equal(second.wrote, false);
  assert.equal(repo.queueRows.length, 1, "replay must create zero additional rows");
});

test("CTL9: no safe due candidate produces zero writes and a fail-closed NO_SAFE_CANDIDATE status", async () => {
  const reservation = baseReservation();
  const repo = makeFakeRepo([reservation]);

  const result = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [] }) } // no executable candidate for the due reservation
  );

  assert.equal(result.kind, "NO_SAFE_CANDIDATE");
  assert.equal(result.wrote, false);
  assert.equal(repo.queueRows.length, 0);
});

test("CTL10: normal scheduled rebalance (runEventRebalance) is behaviorally unchanged by the controlled-mode refactor", async () => {
  const reservation = baseReservation();
  const candidate = baseCandidate();
  const repo = makeFakeRepo([reservation]);

  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    { repo, fetchCandidates: async () => ({ candidates: [candidate] }) }
  );

  assert.equal(result.due_count, 1);
  assert.equal(result.queued_count, 1);
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.queueRows[0].status, "READY");
  assert.equal(repo.queueRows[0].condition_id, "cond-esp-arg");
  assert.equal(repo.queueRows[0].stake_usd, 7, "normal mode must not apply the controlled $1 stake cap");
  assert.notEqual(repo.queueRows[0].rebalance_run_id, CONTROLLED_LIVE_TEST_ID, "normal mode must not carry the controlled marker");
});

test("CTL11: dry-run controlled mode performs zero writes", async () => {
  const reservation = baseReservation();
  const candidate = baseCandidate();
  const repo = makeFakeRepo([reservation]);

  const result = await runControlledLiveIntent(
    IN_WINDOW_MS,
    CONTROLLED_LIVE_TEST_ID,
    { write: false },
    { repo, fetchCandidates: async () => ({ candidates: [candidate] }) }
  );

  assert.equal(result.kind, "CREATED");
  assert.equal(result.wrote, false);
  assert.equal(repo.queueRows.length, 0);
});

test("CTL12: applyControlledLiveIntentOverrides never raises stake and never touches market identity", () => {
  const row: EventExecutionQueueRow = buildQueueRow(baseReservation(), baseCandidate({ stake_usd: 0.5 }), "rebalance-1");
  const overridden = applyControlledLiveIntentOverrides(row);
  assert.equal(overridden.stake_usd, 0.5, "stake is capped, never raised -- 0.5 stays 0.5");
  assert.equal(overridden.condition_id, row.condition_id);
  assert.equal(overridden.token_id, row.token_id);
  assert.equal(overridden.side, row.side);
  assert.equal(overridden.idempotency_key, row.idempotency_key);
});

test("CTL13: the runner rejects any CONTROLLED_LIVE_TEST_ID value other than the exact fixed id, locally, before any network request", () => {
  const scriptPath = path.join(process.cwd(), "scripts", "contur3", "run-event-rebalance.mjs");
  let stdoutErr = "";
  let status = 0;
  try {
    execFileSync("node", [scriptPath], {
      env: { ...process.env, EXECUTOR_CANDIDATES_SECRET: "test-secret-not-real", CONTROLLED_LIVE_TEST_ID: "wrong-id" },
      timeout: 5000,
      encoding: "utf8",
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
    stdoutErr = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.equal(status, 1);
  assert.match(stdoutErr, /CONTROLLED_LIVE_INTENT_ID_MISMATCH/);
  assert.doesNotMatch(stdoutErr, /POST http/, "must not attempt any network request before rejecting the mismatched id");
});

test("CTL14: the runner source only applies controlledLiveIntent to the request URL when the explicit env marker is present (normal invocation is additive-unaffected)", () => {
  const scriptPath = path.join(process.cwd(), "scripts", "contur3", "run-event-rebalance.mjs");
  const src = fs.readFileSync(scriptPath, "utf8");
  assert.match(src, /if \(controlledLiveIntent !== null\)/, "controlled query param must be gated behind an explicit non-null check");
  assert.match(src, /url\.searchParams\.set\('controlledLiveIntent', controlledLiveIntent\)/);
  assert.match(src, /const url = new URL\(`\$\{BASE_URL\}\$\{ENDPOINT\}`\)/, "base endpoint construction is unchanged for normal invocation");
});
