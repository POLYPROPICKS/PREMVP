// PREMVP Queue money envelope: stake_usd <= $4.00, max_entry_price <= 0.62.
//   node --import tsx --test tests/contur3/queueMoneyEnvelope.test.ts
//
// Founder-authorized 2026-09-21. PREMVP is the authority; Ireland receives the
// envelope as immutable instructions. Over-limit candidates are rejected with a
// specific reason, never clamped. Enters through the REAL runEventRebalance seam.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import {
  EXECUTABLE_STAKE_USD,
  QUEUE_MAX_ENTRY_PRICE,
  QUEUE_MAX_STAKE_USD,
  mapQueueRowToIrelandCandidate,
  queueMoneyEnvelopeViolation,
  validateOrderEventAgainstQueueRow,
  type EventExecutionQueueRow,
  type NightEventReservationRow,
  type OrderEventSubmission,
} from "../../lib/executor/executorQueueTypes";
import { latestEntryIso, preferredEntryIso } from "../../lib/executor/nightWindow";

const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
const IN_WINDOW_MS = Date.parse("2026-07-19T18:00:00.000Z");
const PHYSICAL_EVENT_ID = "provider:polymarket:esp-arg-2026-07-19:2026-07-19";

function reservation(entryPrice: number): NightEventReservationRow {
  return {
    id: "res-esp-arg",
    plan_run_id: "night-plan:2026-07-19:1700-minsk",
    plan_date_minsk: "2026-07-19",
    window_start_iso: "2026-07-19T14:00:00.000Z",
    window_end_iso: "2026-07-20T05:00:00.000Z",
    physical_event_id: PHYSICAL_EVENT_ID,
    event_start_iso: KICKOFF_ISO,
    match_family_key: PHYSICAL_EVENT_ID,
    event_slug: "fifwc-esp-arg-2026-07-19",
    event_title: "Argentina vs Spain",
    sport: "soccer",
    league: null,
    strategic_scope: "WC",
    game_start_iso: KICKOFF_ISO,
    event_tier: "TIER1",
    event_score: 80,
    best_snapshot_id: "11111111-1111-4111-8111-111111111111",
    reservation_rank: 1,
    status: "RESERVED",
    selection_reason: null,
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      source_lineage: { generated_signal_pair_id: "11111111-1111-4111-8111-111111111111" },
      candidate_manifest_version: "RESERVATION_CANDIDATE_MANIFEST_V1",
      candidate_manifest: [{
        generated_signal_pair_id: "11111111-1111-4111-8111-111111111111",
        generated_signal_pair_id_is_uuid: true,
        condition_id: "cond-esp-arg-ml",
        token_id: "token-esp-arg-spain",
        side: "Spain",
        market_slug: "Argentina vs Spain - Moneyline",
        event_slug: "fifwc-esp-arg-2026-07-19",
        entry_price_num: entryPrice,
        signal_confidence_num: 80,
        metric_formula_version: "v2-lite-growth-safe",
        source_created_at: "2026-07-19T12:00:00.000Z",
      }],
    },
  };
}

function repoFor(res: NightEventReservationRow) {
  const queueRows: EventExecutionQueueRow[] = [];
  const repo: RebalanceRepoPort & { queueRows: EventExecutionQueueRow[] } = {
    queueRows,
    async loadActiveReservations() { return [res]; },
    async loadQueuedReservationIds() { return new Set<string>(); },
    async markReservationsExpired() {},
    async markReservationSkipped() {},
    async insertQueueRow(row) { queueRows.push(row); },
    async markReservationQueued() {},
    async loadFinalIdentitySourceRows() { throw new Error("GSP must not be read for a B2 manifest"); },
  };
  return repo;
}

test("QME-1: constants are the Founder envelope and the Queue stake authorizes exactly $4.00", async () => {
  assert.equal(QUEUE_MAX_STAKE_USD, 4);
  assert.equal(QUEUE_MAX_ENTRY_PRICE, 0.62);
  assert.equal(EXECUTABLE_STAKE_USD, 4);
  const repo = repoFor(reservation(0.5));
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  assert.equal(repo.queueRows[0].stake_usd, 4);
  assert.equal((repo.queueRows[0].diagnostics as Record<string, unknown>).stake_guard_usd, 4);
});

test("QME-2: max_entry_price exactly 0.62 is accepted and copied unchanged (no headroom, no clamp)", async () => {
  const repo = repoFor(reservation(0.62));
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  assert.equal((repo.queueRows[0].diagnostics as Record<string, unknown>).max_entry_price, 0.62);
});

test("QME-3: max_entry_price above 0.62 is rejected with a specific reason; nothing is written or clamped", async () => {
  const repo = repoFor(reservation(0.625));
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.ok(
    JSON.stringify(result.outcomes).includes("QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING"),
    JSON.stringify(result.outcomes)
  );
});

test("QME-4: pure envelope check fails closed above $4.00 / 0.62 and passes at the bounds", () => {
  assert.equal(queueMoneyEnvelopeViolation(4, 0.62), null);
  assert.equal(queueMoneyEnvelopeViolation(2.5, 0.5), null);
  assert.equal(queueMoneyEnvelopeViolation(4.01, 0.5), "QUEUE_STAKE_ABOVE_ENVELOPE");
  assert.equal(queueMoneyEnvelopeViolation(Number.NaN, 0.5), "QUEUE_STAKE_ABOVE_ENVELOPE");
  assert.equal(queueMoneyEnvelopeViolation(4, 0.6201), "QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING");
});

test("QME-5: identity, GTD/latest_entry and idempotency are unchanged by the envelope", async () => {
  const repoA = repoFor(reservation(0.5));
  const repoB = repoFor(reservation(0.5));
  await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo: repoA });
  await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo: repoB });
  const row = repoA.queueRows[0];
  const startMs = Date.parse(KICKOFF_ISO);
  assert.equal(row.condition_id, "cond-esp-arg-ml");
  assert.equal(row.token_id, "token-esp-arg-spain");
  assert.equal(row.side, "Spain");
  assert.equal(row.preferred_entry_iso, preferredEntryIso(startMs));
  assert.equal(row.latest_entry_iso, latestEntryIso(startMs));
  assert.equal(row.idempotency_key, repoB.queueRows[0].idempotency_key);
  assert.equal(row.order_key, repoB.queueRows[0].order_key);
});

// ── callback validation ─────────────────────────────────────────────────────

function queueRow(overrides: Partial<EventExecutionQueueRow> = {}, maxEntry: number | null = 0.62): EventExecutionQueueRow {
  return {
    id: "queue-1", reservation_id: "res-1", plan_run_id: "plan-1", rebalance_run_id: "rb-1",
    match_family_key: "m", event_title: "t", event_slug: "s", sport: "soccer", league: null,
    game_start_iso: KICKOFF_ISO, condition_id: "cond-1", token_id: "token-1", side: "Spain",
    market_slug: "x", market_title: "x", market_family: null, score: 80, coverage: null, tier: "TIER1",
    stake_usd: 4, preferred_entry_iso: "2026-07-19T17:50:00.000Z", latest_entry_iso: "2026-07-19T18:57:00.000Z",
    selection_rank: 1, selection_reason: null, status: "READY", order_key: "k", idempotency_key: "i",
    diagnostics: maxEntry === null ? {} : { max_entry_price: maxEntry },
    ...overrides,
  };
}

function submission(overrides: Partial<OrderEventSubmission> = {}): OrderEventSubmission {
  return {
    queue_id: "queue-1", reservation_id: "res-1", idempotency_key: "i", token_id: "token-1",
    condition_id: "cond-1", side: "Spain", market_slug: "x",
    stake_usd: 4, submitted_size: 6.4, submitted_price: 0.62,
    ...overrides,
  } as OrderEventSubmission;
}

test("QME-6: callback within the envelope is accepted (notional 3.968 <= 4, price 0.62 <= 0.62)", () => {
  assert.deepEqual(validateOrderEventAgainstQueueRow(submission(), queueRow()), { ok: true });
});

test("QME-7: callback notional above the Queue stake is rejected", () => {
  const r = validateOrderEventAgainstQueueRow(submission({ submitted_size: 7 }), queueRow());
  assert.deepEqual(r, { ok: false, reason: "ORDER_NOTIONAL_EXCEEDS_QUEUE_MAX" });
  const s = validateOrderEventAgainstQueueRow(submission({ stake_usd: 4.5 }), queueRow());
  assert.deepEqual(s, { ok: false, reason: "STAKE_EXCEEDS_QUEUE_MAX" });
});

test("QME-8: callback price above the Queue max_entry_price is rejected", () => {
  const r = validateOrderEventAgainstQueueRow(submission({ submitted_price: 0.63, submitted_size: 6 }), queueRow());
  assert.deepEqual(r, { ok: false, reason: "PRICE_EXCEEDS_QUEUE_MAX" });
});

test("QME-9: a Queue row itself above $4.00 or 0.62 fails callback validation closed", () => {
  assert.deepEqual(
    validateOrderEventAgainstQueueRow(submission(), queueRow({ stake_usd: 4.5 })),
    { ok: false, reason: "QUEUE_STAKE_ABOVE_ENVELOPE" }
  );
  assert.deepEqual(
    validateOrderEventAgainstQueueRow(submission({ submitted_price: 0.5, submitted_size: 6 }), queueRow({}, 0.7)),
    { ok: false, reason: "QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING" }
  );
});

// ── SET_LIVE_QUEUE_EXECUTION_PRICE_CAP_TO_062_V1 ────────────────────────────
// Founder decision 2026-09-21: for normal live Queue rows, max_entry_price is
// a flat QUEUE_MAX_ENTRY_PRICE (0.62), never the raw candidate entry_price_num
// (ae6e944 only added the 0.62 ceiling *guard* -- the writer itself still
// copied entry_price_num verbatim, so a 0.50 candidate reached Ireland with
// max_entry_price=0.50, one PRICE_ABOVE_CAP retry away from failing at 0.51).

test("QME-10: candidate entry_price_num=0.50 -> Queue max_entry_price=0.62 (flat cap, not the raw price)", async () => {
  const repo = repoFor(reservation(0.5));
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  const diag = repo.queueRows[0].diagnostics as Record<string, unknown>;
  assert.equal(diag.max_entry_price, 0.62);
});

test("QME-11: candidate entry_price_num=0.45 -> Queue max_entry_price=0.62 (flat cap, not the raw price)", async () => {
  const repo = repoFor(reservation(0.45));
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  const diag = repo.queueRows[0].diagnostics as Record<string, unknown>;
  assert.equal(diag.max_entry_price, 0.62);
});

test("QME-12: the original candidate entry_price_num is preserved separately from the execution cap", async () => {
  const repo = repoFor(reservation(0.5));
  await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  const diag = repo.queueRows[0].diagnostics as Record<string, unknown>;
  assert.equal(diag.max_entry_price, 0.62);
  assert.equal(diag.entry_price, 0.5, "original entry_price_num must survive alongside the 0.62 execution cap");
});

test("QME-13: the Ireland projection carries price_cap=0.62 for a sub-0.62 candidate", async () => {
  const repo = repoFor(reservation(0.5));
  await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  const candidate = mapQueueRowToIrelandCandidate(repo.queueRows[0], IN_WINDOW_MS);
  assert.equal(candidate.max_entry_price, 0.62);
  assert.equal(candidate.price_cap, 0.62);
});

test("QME-14: callback at 0.61 (within the 0.62 cap) is accepted", () => {
  assert.deepEqual(
    validateOrderEventAgainstQueueRow(submission({ submitted_price: 0.61, submitted_size: 6.55 }), queueRow()),
    { ok: true }
  );
});
