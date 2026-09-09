// B3: REBALANCE FINAL MARKET SELECTION FROM THE B2 RESERVATION CANDIDATE MANIFEST
//   node --import tsx --test tests/contur3/rebalanceFromReservationCandidateManifest.test.ts
//
// Business result under test: for a Reservation carrying a supported B2
// candidate manifest (diagnostics.candidate_manifest_version =
// RESERVATION_CANDIDATE_MANIFEST_V1), Rebalance resolves the final Queue row
// ENTIRELY from that frozen manifest -- zero generated_signal_pairs reads,
// zero current_signal_pair_serving reads. A legacy Reservation (no manifest
// version at all) keeps the existing bounded GSP path unchanged. A present
// but unsupported/malformed manifest fails closed and NEVER falls back to GSP.
//
// Enters through the REAL production seam runEventRebalance -- never a
// hand-assembled queue row.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runEventRebalance,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import {
  EXECUTABLE_STAKE_USD,
  type EventExecutionQueueRow,
  type NightEventReservationRow,
} from "../../lib/executor/executorQueueTypes";

const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
// T-60m from a 19:00Z kickoff, inside the T-70..T-3 rebalance window.
const IN_WINDOW_MS = Date.parse("2026-07-19T18:00:00.000Z");
const PHYSICAL_EVENT_ID = "provider:polymarket:esp-arg-2026-07-19:2026-07-19";

function b2Reservation(overrides: Partial<NightEventReservationRow> = {}): NightEventReservationRow {
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
      candidate_manifest: [
        {
          generated_signal_pair_id: "11111111-1111-4111-8111-111111111111",
          generated_signal_pair_id_is_uuid: true,
          condition_id: "cond-esp-arg-ml",
          token_id: "token-esp-arg-spain",
          side: "Spain",
          market_slug: "Argentina vs Spain - Moneyline",
          event_slug: "fifwc-esp-arg-2026-07-19",
          entry_price_num: 0.42,
          signal_confidence_num: 80,
          metric_formula_version: "v2-lite-growth-safe",
          source_created_at: "2026-07-19T12:00:00.000Z",
        },
        {
          generated_signal_pair_id: "22222222-2222-4222-8222-222222222222",
          generated_signal_pair_id_is_uuid: true,
          condition_id: "cond-esp-arg-spread",
          token_id: "token-esp-arg-spain-spread",
          side: "Spain -1.5",
          market_slug: "Argentina vs Spain - Spread",
          event_slug: "fifwc-esp-arg-2026-07-19",
          entry_price_num: 0.38,
          // Deliberately LOWER confidence than the moneyline entry above, so
          // determinism (max-score wins) is provably exercised.
          signal_confidence_num: 65,
          metric_formula_version: "v2-lite-growth-safe",
          source_created_at: "2026-07-19T12:00:00.000Z",
        },
      ],
    },
    ...overrides,
  };
}

function makeInstrumentedRepo(reservations: NightEventReservationRow[]): RebalanceRepoPort & {
  queueRows: EventExecutionQueueRow[];
  gspLoadCallCount: number;
  gspLoadedReservationIds: string[];
} {
  const queueRows: EventExecutionQueueRow[] = [];
  const queuedReservationIds = new Set<string>();
  let gspLoadCallCount = 0;
  const gspLoadedReservationIds: string[] = [];
  return {
    queueRows,
    get gspLoadCallCount() {
      return gspLoadCallCount;
    },
    gspLoadedReservationIds,
    async loadActiveReservations() {
      return reservations.filter((r) => r.status === "RESERVED" || r.status === "REBALANCE_PENDING");
    },
    async loadQueuedReservationIds() {
      return new Set(queuedReservationIds);
    },
    async markReservationsExpired() {},
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
    // This is exactly the GSP-anchor path B3 must NEVER call for a B2 cohort.
    async loadFinalIdentitySourceRows(reservation) {
      gspLoadCallCount += 1;
      gspLoadedReservationIds.push(String(reservation.id));
      return [{
        id: "11111111-1111-4111-8111-111111111111",
        condition_id: "cond-esp-arg-ml",
        selected_token_id: "token-esp-arg-spain",
        selected_outcome: "Spain",
        signal_confidence_num: 80,
        entry_price_num: 0.42,
        metric_formula_version: "v2-lite-growth-safe",
        market_slug: "Argentina vs Spain - Moneyline",
        diagnostics: {
          providerEventContext: { v: "v1", provider: "polymarket", eventId: "esp-arg-2026-07-19", eventStartIso: KICKOFF_ISO },
        },
      }];
    },
  };
}

// ── A, B, C, D: the manifest is the complete candidate universe; zero GSP/Serving reads ──

test("RFM-1: a B2 Reservation resolves its Queue row entirely from candidate_manifest, with zero GSP reads and zero Serving rediscovery calls", async () => {
  const repo = makeInstrumentedRepo([b2Reservation()]);
  let servingCallCount = 0;
  const result = await runEventRebalance(
    IN_WINDOW_MS,
    { write: true },
    {
      repo,
      // If this is ever invoked for the B2 cohort, the test fails via the counter below.
      fetchCandidates: async () => { servingCallCount += 1; return { candidates: [] }; },
      fetchContractAFinalCandidates: async () => { servingCallCount += 1; return { candidates: [] }; },
    }
  );

  assert.equal(result.due_count, 1);
  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  assert.equal(repo.queueRows.length, 1);
  assert.equal(repo.gspLoadCallCount, 0, "B2 manifest Reservation must never call loadFinalIdentitySourceRows (GSP)");
  assert.equal(servingCallCount, 0, "B2 manifest Reservation must never rediscover the candidate set from Serving/candidate fetchers");

  const row = repo.queueRows[0];
  assert.equal((row.diagnostics as Record<string, unknown>).source_authority, "B2_CANDIDATE_MANIFEST");
});

test("RFM-2: multiple manifest market rows for the same physical event remain one candidate universe under ONE Queue row, and the max-confidence entry deterministically wins", async () => {
  const repo = makeInstrumentedRepo([b2Reservation()]);
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });

  assert.equal(result.queued_count, 1, "exactly one queue row, never one per manifest entry");
  assert.equal(repo.queueRows.length, 1);
  const row = repo.queueRows[0];
  // The moneyline entry (confidence 80) must win over the spread entry (confidence 65).
  assert.equal(row.condition_id, "cond-esp-arg-ml");
  assert.equal(row.token_id, "token-esp-arg-spain");
  assert.equal(row.score, 80);
});

test("RFM-3: re-running the same manifest selection is deterministic (repeat run picks the identical candidate)", async () => {
  const reservation = b2Reservation();
  const repoA = makeInstrumentedRepo([{ ...reservation }]);
  const repoB = makeInstrumentedRepo([{ ...reservation }]);
  const [resultA, resultB] = await Promise.all([
    runEventRebalance(IN_WINDOW_MS, { write: true }, { repo: repoA }),
    runEventRebalance(IN_WINDOW_MS, { write: true }, { repo: repoB }),
  ]);
  assert.equal(resultA.queued_count, 1);
  assert.equal(resultB.queued_count, 1);
  assert.deepEqual(
    [repoA.queueRows[0].condition_id, repoA.queueRows[0].token_id, repoA.queueRows[0].side],
    [repoB.queueRows[0].condition_id, repoB.queueRows[0].token_id, repoB.queueRows[0].side]
  );
});

// ── E: malformed/unsupported manifest fails closed, never falls back to GSP ──

test("RFM-4: an unrecognized candidate_manifest_version fails closed and never calls the GSP loader", async () => {
  const reservation = b2Reservation({
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      source_lineage: { generated_signal_pair_id: "11111111-1111-4111-8111-111111111111" },
      candidate_manifest_version: "RESERVATION_CANDIDATE_MANIFEST_V2_HYPOTHETICAL_FUTURE",
      candidate_manifest: [{ condition_id: "cond-x", token_id: "tok-x", side: "A", signal_confidence_num: 80, entry_price_num: 0.4, metric_formula_version: "v2-lite-growth-safe", generated_signal_pair_id: "33333333-3333-4333-8333-333333333333" }],
    },
  });
  const repo = makeInstrumentedRepo([reservation]);
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });

  assert.equal(result.queued_count, 0);
  assert.equal(repo.queueRows.length, 0);
  assert.equal(repo.gspLoadCallCount, 0, "an unsupported manifest version must never fall back to GSP");
  assert.equal(result.skipped_count, 1);
  assert.equal(result.outcomes[0]?.reason, "B2_MANIFEST_VERSION_UNSUPPORTED");
});

test("RFM-5: an empty candidate_manifest array fails closed and never calls the GSP loader", async () => {
  const reservation = b2Reservation({
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      source_lineage: { generated_signal_pair_id: "11111111-1111-4111-8111-111111111111" },
      candidate_manifest_version: "RESERVATION_CANDIDATE_MANIFEST_V1",
      candidate_manifest: [],
    },
  });
  const repo = makeInstrumentedRepo([reservation]);
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });

  assert.equal(result.queued_count, 0);
  assert.equal(repo.gspLoadCallCount, 0);
  assert.equal(result.outcomes[0]?.reason, "B2_MANIFEST_EMPTY_OR_MALFORMED");
});

test("RFM-6: a manifest entry missing a required execution-policy field fails the WHOLE manifest closed (never silently drops the bad entry and proceeds)", async () => {
  const reservation = b2Reservation({
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      source_lineage: { generated_signal_pair_id: "11111111-1111-4111-8111-111111111111" },
      candidate_manifest_version: "RESERVATION_CANDIDATE_MANIFEST_V1",
      candidate_manifest: [
        {
          generated_signal_pair_id: "11111111-1111-4111-8111-111111111111",
          condition_id: "cond-esp-arg-ml",
          token_id: "token-esp-arg-spain",
          side: "Spain",
          // entry_price_num missing -- cannot safely compute max-entry-price authority.
          signal_confidence_num: 80,
          metric_formula_version: "v2-lite-growth-safe",
        },
      ],
    },
  });
  const repo = makeInstrumentedRepo([reservation]);
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });

  assert.equal(result.queued_count, 0);
  assert.equal(repo.gspLoadCallCount, 0);
  assert.equal(result.outcomes[0]?.reason, "B2_MANIFEST_ENTRY_MALFORMED");
});

// ── F: legacy Reservation (no manifest version) preserves the existing GSP path ──

test("RFM-7: a legacy Reservation with no candidate_manifest_version preserves the existing GSP-anchor Rebalance path unchanged", async () => {
  const legacyReservation = b2Reservation({
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      source_lineage: { generated_signal_pair_id: "11111111-1111-4111-8111-111111111111" },
      // No candidate_manifest_version at all -- the pre-B2 shape.
    },
  });
  const repo = makeInstrumentedRepo([legacyReservation]);
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo });

  assert.equal(result.queued_count, 1, JSON.stringify(result.outcomes));
  assert.equal(repo.gspLoadCallCount, 1, "a legacy Reservation must still use the GSP-anchor loader exactly as before");
  const row = repo.queueRows[0];
  assert.equal((row.diagnostics as Record<string, unknown>).source_authority, "GSP_ANCHOR_SIBLING");
  assert.equal(row.condition_id, "cond-esp-arg-ml");
});

// ── G: Queue row identity/stake/idempotency contract is identical across both paths ──

test("RFM-8: the B2 manifest path and the legacy GSP path produce byte-identical Queue row identity/stake/idempotency shape for the same underlying selected market", async () => {
  const b2Repo = makeInstrumentedRepo([b2Reservation({
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      source_lineage: { generated_signal_pair_id: "11111111-1111-4111-8111-111111111111" },
      candidate_manifest_version: "RESERVATION_CANDIDATE_MANIFEST_V1",
      // Single entry only, matching the legacy fixture's sole GSP row exactly.
      candidate_manifest: [{
        generated_signal_pair_id: "11111111-1111-4111-8111-111111111111",
        condition_id: "cond-esp-arg-ml",
        token_id: "token-esp-arg-spain",
        side: "Spain",
        market_slug: "Argentina vs Spain - Moneyline",
        entry_price_num: 0.42,
        signal_confidence_num: 80,
        metric_formula_version: "v2-lite-growth-safe",
      }],
    },
  })]);
  const legacyRepo = makeInstrumentedRepo([b2Reservation({
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      source_lineage: { generated_signal_pair_id: "11111111-1111-4111-8111-111111111111" },
    },
  })]);

  await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo: b2Repo });
  await runEventRebalance(IN_WINDOW_MS, { write: true }, { repo: legacyRepo });

  const b2Row = b2Repo.queueRows[0];
  const legacyRow = legacyRepo.queueRows[0];

  assert.equal(b2Row.order_key, legacyRow.order_key, "order_key computation is identical across paths");
  assert.equal(b2Row.idempotency_key, legacyRow.idempotency_key, "idempotency_key computation is identical across paths");
  assert.equal(b2Row.stake_usd, EXECUTABLE_STAKE_USD);
  assert.equal(legacyRow.stake_usd, EXECUTABLE_STAKE_USD);
  assert.equal(b2Row.condition_id, legacyRow.condition_id);
  assert.equal(b2Row.token_id, legacyRow.token_id);
  assert.equal(b2Row.side, legacyRow.side);
  assert.equal(b2Row.status, "READY");
  assert.equal(legacyRow.status, "READY");
  assert.ok(b2Row.preferred_entry_iso && b2Row.latest_entry_iso);
  assert.equal(b2Row.preferred_entry_iso, legacyRow.preferred_entry_iso);
  assert.equal(b2Row.latest_entry_iso, legacyRow.latest_entry_iso);
});
