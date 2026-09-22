// PREMVP Queue money envelope: default stake $2.50, exceptional hard ceiling
// $4.00, max_entry_price <= 0.62.
//   node --import tsx --test tests/contur3/queueMoneyEnvelope.test.ts
//
// RESTORE_DEFAULT_250_SEPARATE_MAX_400_CONTRACT_V1 (2026-09-22): the
// 2026-09-21 envelope change (ae6e944) defined EXECUTABLE_STAKE_USD ===
// QUEUE_MAX_STAKE_USD, so every normal Queue row was accidentally written at
// $4.00 -- production confirmed the resulting $4 live orders. $4.00 is
// exceptional headroom for a venue-minimum-size problem, never the ordinary
// stake. This file proves the corrected two-level contract: normal rows get
// stake_usd = $2.50, the $4.00 ceiling is persisted separately as
// diagnostics.max_stake_usd, and historical rows without that diagnostic are
// never silently promoted to $4. Enters through the REAL runEventRebalance
// seam.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runEventRebalance, type RebalanceRepoPort } from "../../lib/executor/eventExecutionQueue";
import {
  EXECUTABLE_STAKE_USD,
  QUEUE_DEFAULT_STAKE_USD,
  QUEUE_MAX_ENTRY_PRICE,
  QUEUE_MAX_STAKE_USD,
  extractMaxStakeUsd,
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

// ── 1. normal new Queue row: stake_usd = 2.50, max_stake_usd (diagnostics) = 4.00 ──

test("QME-1: constants are the corrected two-level envelope and a normal Queue row gets the $2.50 default, not $4.00", async () => {
  assert.equal(QUEUE_DEFAULT_STAKE_USD, 2.5);
  assert.equal(QUEUE_MAX_STAKE_USD, 4);
  assert.equal(QUEUE_MAX_ENTRY_PRICE, 0.62);
  assert.equal(EXECUTABLE_STAKE_USD, 2.5, "EXECUTABLE_STAKE_USD is the ordinary default, never the exceptional ceiling");
  const repo = repoFor(reservation(0.5));
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  const row = repo.queueRows[0];
  assert.equal(row.stake_usd, 2.5, "a normal Queue row's stake_usd must be the $2.50 default, not $4.00");
  const diag = row.diagnostics as Record<string, unknown>;
  assert.equal(diag.max_stake_usd, 4, "the exceptional $4.00 ceiling is persisted separately in diagnostics.max_stake_usd");
  assert.equal(diag.stake_guard_usd, 2.5);
});

// ── 2. Ireland projection: stake_usd = 2.50, max_stake_usd = 4.00 ──────────

test("QME-2: the Ireland projection carries stake_usd=2.50 and max_stake_usd=4.00 for a normal Queue row", async () => {
  const repo = repoFor(reservation(0.5));
  await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  const candidate = mapQueueRowToIrelandCandidate(repo.queueRows[0], IN_WINDOW_MS);
  assert.equal(candidate.stake_usd, 2.5);
  assert.equal(candidate.max_stake_usd, 4);
  assert.notEqual(
    candidate.max_stake_usd,
    candidate.stake_usd,
    "max_stake_usd must never equal stake_usd under this contract",
  );
});

// ── 3. old Queue row without diagnostics.max_stake_usd: effective max stays its historical stake_usd ──

test("QME-3: a historical Queue row without diagnostics.max_stake_usd is never silently promoted to $4.00", () => {
  const legacyRow: EventExecutionQueueRow = queueRow({ stake_usd: 2.5 }, 0.62);
  // No max_stake_usd key at all in diagnostics -- exactly a pre-2026-09-22 row.
  assert.equal((legacyRow.diagnostics as Record<string, unknown>).max_stake_usd, undefined);
  assert.equal(
    extractMaxStakeUsd(legacyRow.diagnostics as Record<string, unknown>, legacyRow.stake_usd),
    2.5,
    "effective max stake for a legacy row must remain its own historical stake_usd",
  );
  const candidate = mapQueueRowToIrelandCandidate(legacyRow, IN_WINDOW_MS);
  assert.equal(candidate.max_stake_usd, 2.5, "Ireland projection must not promote a legacy row's max stake to $4.00");

  // The callback path agrees: a $3.00 submission against this legacy $2.50 row is rejected,
  // even though $3.00 is well under the $4.00 hard ceiling.
  const r = validateOrderEventAgainstQueueRow(
    submission({ stake_usd: 3, submitted_size: 4.83, submitted_price: 0.62 }),
    legacyRow,
  );
  assert.deepEqual(r, { ok: false, reason: "STAKE_EXCEEDS_QUEUE_MAX" });
});

// ── envelope function itself ────────────────────────────────────────────────

test("QME-4: the pure row-level envelope check fails closed above $4.00 / 0.62 and passes at the bounds", () => {
  assert.equal(queueMoneyEnvelopeViolation(4, 0.62), null);
  assert.equal(queueMoneyEnvelopeViolation(2.5, 0.5), null);
  assert.equal(queueMoneyEnvelopeViolation(4.01, 0.5), "QUEUE_STAKE_ABOVE_ENVELOPE");
  assert.equal(queueMoneyEnvelopeViolation(Number.NaN, 0.5), "QUEUE_STAKE_ABOVE_ENVELOPE");
  assert.equal(queueMoneyEnvelopeViolation(4, 0.6201), "QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING");
});

test("QME-5: identity, GTD/latest_entry and idempotency are unchanged by the corrected envelope", async () => {
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

test("QME-price-ceiling: max_entry_price above 0.62 is rejected with a specific reason; nothing is written or clamped", async () => {
  const repo = repoFor(reservation(0.625));
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.ok(
    JSON.stringify(result.outcomes).includes("QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING"),
    JSON.stringify(result.outcomes)
  );
});

test("QME-price-bound: max_entry_price exactly 0.62 is accepted and copied unchanged (no headroom, no clamp)", async () => {
  const repo = repoFor(reservation(0.62));
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });
  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  assert.equal((repo.queueRows[0].diagnostics as Record<string, unknown>).max_entry_price, 0.62);
});

// ── callback validation ─────────────────────────────────────────────────────
// A queue row here carries diagnostics.max_stake_usd = 4.00 (the new explicit
// envelope), exactly what a normal post-2026-09-22 Queue row now persists.

function queueRow(overrides: Partial<EventExecutionQueueRow> = {}, maxEntry: number | null = 0.62): EventExecutionQueueRow {
  return {
    id: "queue-1", reservation_id: "res-1", plan_run_id: "plan-1", rebalance_run_id: "rb-1",
    match_family_key: "m", event_title: "t", event_slug: "s", sport: "soccer", league: null,
    game_start_iso: KICKOFF_ISO, condition_id: "cond-1", token_id: "token-1", side: "Spain",
    market_slug: "x", market_title: "x", market_family: null, score: 80, coverage: null, tier: "TIER1",
    stake_usd: 2.5, preferred_entry_iso: "2026-07-19T17:50:00.000Z", latest_entry_iso: "2026-07-19T18:57:00.000Z",
    selection_rank: 1, selection_reason: null, status: "READY", order_key: "k", idempotency_key: "i",
    diagnostics: maxEntry === null ? {} : { max_entry_price: maxEntry },
    ...overrides,
  };
}

/** A normal post-2026-09-22 row: stake_usd=2.50 default, diagnostics.max_stake_usd=4.00 explicit ceiling. */
function queueRowWithEnvelope(overrides: Partial<EventExecutionQueueRow> = {}, maxEntry: number | null = 0.62): EventExecutionQueueRow {
  const base = queueRow(overrides, maxEntry);
  return { ...base, diagnostics: { ...base.diagnostics, max_stake_usd: 4 } };
}

function submission(overrides: Partial<OrderEventSubmission> = {}): OrderEventSubmission {
  return {
    queue_id: "queue-1", reservation_id: "res-1", idempotency_key: "i", token_id: "token-1",
    condition_id: "cond-1", side: "Spain", market_slug: "x",
    stake_usd: 4, submitted_size: 6.4, submitted_price: 0.62,
    ...overrides,
  } as OrderEventSubmission;
}

// ── 4. callback/notional <= 4 may pass only under the new explicit max envelope ──

test("QME-6: a $4.00 callback is accepted against a row with the explicit $4.00 diagnostics envelope (notional 3.968 <= 4, price 0.62 <= 0.62)", () => {
  assert.deepEqual(validateOrderEventAgainstQueueRow(submission(), queueRowWithEnvelope()), { ok: true });
});

test("QME-6b: the SAME $4.00 callback is rejected against a normal $2.50 row with NO explicit max_stake_usd (no promotion to $4)", () => {
  const r = validateOrderEventAgainstQueueRow(submission(), queueRow());
  assert.deepEqual(r, { ok: false, reason: "STAKE_EXCEEDS_QUEUE_MAX" });
});

test("QME-6c: a $2.50 callback within the ordinary default is accepted against a normal row with no explicit envelope", () => {
  assert.deepEqual(
    validateOrderEventAgainstQueueRow(
      submission({ stake_usd: 2.5, submitted_size: 4.03, submitted_price: 0.62 }),
      queueRow(),
    ),
    { ok: true },
  );
});

// ── 5. >4 fails closed ───────────────────────────────────────────────────────

test("QME-7: callback notional above the row's effective max stake is rejected", () => {
  const r = validateOrderEventAgainstQueueRow(submission({ submitted_size: 7 }), queueRowWithEnvelope());
  assert.deepEqual(r, { ok: false, reason: "ORDER_NOTIONAL_EXCEEDS_QUEUE_MAX" });
  const s = validateOrderEventAgainstQueueRow(submission({ stake_usd: 4.5 }), queueRowWithEnvelope());
  assert.deepEqual(s, { ok: false, reason: "STAKE_EXCEEDS_QUEUE_MAX" });
});

test("QME-9: a Queue row whose effective max stake is itself above $4.00 fails callback validation closed", () => {
  assert.deepEqual(
    validateOrderEventAgainstQueueRow(
      submission(),
      { ...queueRow({ stake_usd: 4.5 }), diagnostics: { max_entry_price: 0.62, max_stake_usd: 4.5 } },
    ),
    { ok: false, reason: "QUEUE_STAKE_ABOVE_ENVELOPE" },
  );
});

// ── 6/7. price >0.62 fails closed; max_entry_price remains 0.62 ─────────────

test("QME-8: callback price above the Queue max_entry_price is rejected", () => {
  const r = validateOrderEventAgainstQueueRow(submission({ submitted_price: 0.63, submitted_size: 6 }), queueRowWithEnvelope());
  assert.deepEqual(r, { ok: false, reason: "PRICE_EXCEEDS_QUEUE_MAX" });
});

test("QME-9b: a Queue row whose own max_entry_price is above 0.62 fails callback validation closed", () => {
  assert.deepEqual(
    validateOrderEventAgainstQueueRow(submission({ submitted_price: 0.5, submitted_size: 6 }), queueRowWithEnvelope({}, 0.7)),
    { ok: false, reason: "QUEUE_MAX_ENTRY_PRICE_ABOVE_CEILING" },
  );
});

test("QME-14: callback at 0.61 (within the 0.62 cap) is accepted", () => {
  assert.deepEqual(
    validateOrderEventAgainstQueueRow(
      submission({ submitted_price: 0.61, submitted_size: 6.55, stake_usd: 4 }),
      queueRowWithEnvelope(),
    ),
    { ok: true },
  );
});

// ── SET_LIVE_QUEUE_EXECUTION_PRICE_CAP_TO_062_V1 (preserved) ───────────────
// For normal live Queue rows, max_entry_price is a flat QUEUE_MAX_ENTRY_PRICE
// (0.62), never the raw candidate entry_price_num.

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
