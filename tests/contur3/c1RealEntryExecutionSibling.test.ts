// tests/contur3/c1RealEntryExecutionSibling.test.ts
//
// REAL-ENTRY C1 INTEGRATION GATE.
//
// This suite enters BEFORE the boundary that actually broke in production:
// the persistence -> consumer contract between `generated_signal_pairs` and the
// post-Reservation execution-sibling selector.
//
// It is deliberately NOT a selector unit test. Every candidate row is written
// through GeneratedSignalPairsTable, which rejects any property the real
// production table cannot store, and is read back through the REAL
// loadExactProviderSiblingRowsFromAnchor + REAL runEventRebalance. No test here
// may hand a prebuilt "complete" sibling to the selector.
//
// Production failure this reproduces (2026-08-09, plan night-plan:2026-08-09:1700-minsk):
// four exact siblings loaded successfully, then every one was rejected with
// NO_EXACT_RESERVED_EVENT_SIGNAL_PAIR because the selector read signal_score /
// stake_usd / max_entry_price -- none of which is a column.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEventRebalance,
  loadExactProviderSiblingRowsFromAnchor,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import { EXECUTABLE_STAKE_USD } from "../../lib/executor/executorQueueTypes";
import type {
  EventExecutionQueueRow,
  NightEventReservationRow,
} from "../../lib/executor/executorQueueTypes";
import {
  GeneratedSignalPairsTable,
  SchemaViolationError,
  producerShapedRow,
  assertNoPhantomExecutionColumns,
} from "./helpers/generatedSignalPairsSchemaHarness";

// ---------------------------------------------------------------------------
// Production-verbatim identity of the event that failed on 2026-08-09.
// ---------------------------------------------------------------------------
const PROVIDER_EVENT_ID = "818389";
const EVENT_START = "2026-08-09T18:00:00Z";
// PostgreSQL timestamptz serialization from night_event_reservations. This is
// the same instant as EVENT_START, but must not require matching text.
const RESERVATION_EVENT_START = "2026-08-09T18:00:00+00:00";
const PHYSICAL_ID = "provider:polymarket:818389:2026-08-09";
const CONDITION_ID = "0xf8ca43d088e56d7e759948f62d74071bf66f21b6bac9e5a51b0a9935fdbd7b07";
const ANCHOR_PAIR_ID = "05d6fe25-65ae-49a9-831b-7900d2608b02";
const SIBLING_PAIR_ID = "071bdfea-5088-4ff1-a304-eee3126c295b";
const SCORED_VERSION = "shadow-firemodel1_1_research_v0";
const UNSCORED_SHADOW_VERSION = "shadow-strategic-sports-v1";

// Due window is [T-70, T-3]; event starts 18:00:00Z so 17:00:00Z is due.
const NOW = Date.parse("2026-08-09T17:00:00.000Z");

/**
 * The persisted Reservation shape, copied verbatim from the production row
 * night_event_reservations.id=36fe6db7-e0d0-4609-a92e-25fed17c6fbb created by
 * the natural 2026-08-09 17:00 Minsk Contract A planning run. Not hand-invented.
 */
function productionReservation(
  overrides: Partial<NightEventReservationRow> = {},
): NightEventReservationRow {
  return {
    id: "36fe6db7-e0d0-4609-a92e-25fed17c6fbb",
    plan_run_id: "night-plan:2026-08-09:1700-minsk",
    plan_date_minsk: "2026-08-09",
    window_start_iso: "2026-08-09T14:00:00+00:00",
    window_end_iso: "2026-08-10T05:00:00+00:00",
    match_family_key: PHYSICAL_ID,
    event_slug: "dota 2: re.arise vs ilbirs esports (bo3) - asga...",
    event_title: null,
    sport: "esport",
    league: "Sports",
    strategic_scope: "ESPORT",
    game_start_iso: EVENT_START,
    event_tier: "TIER3_MICRO_EXPAND_50_COV25",
    event_score: 62,
    best_snapshot_id: ANCHOR_PAIR_ID,
    reservation_rank: 10,
    status: "RESERVED",
    selection_reason: null,
    physical_event_id: PHYSICAL_ID,
    event_start_iso: RESERVATION_EVENT_START,
    diagnostics: {
      selector_id: "CONTRACT_A_PLANNING_V1",
      contract_a_stage: "PLANNING",
      contract_a_version: "CONTRACT_A_PLANNING_V1",
      reservation_authority: "CONTRACT_A_PLANNING_DECISION",
      planning_score: 62,
      planning_tier: "TIER3_MICRO_EXPAND_50_COV25",
      planning_rank: 18,
      event_start_iso_source: "source_row_game_start_iso",
      source_lineage: {
        generated_signal_pair_id: ANCHOR_PAIR_ID,
        generated_signal_pair_id_is_uuid: true,
        provider_event_id: PROVIDER_EVENT_ID,
        provider_event_start_iso: EVENT_START,
        provider_event_key: "polymarket:818389:2026-08-09",
        observation_id: ANCHOR_PAIR_ID,
        event_slug: "dota 2: re.arise vs ilbirs esports (bo3) - asga...",
        provider_sport: "Sports",
        producer_source: "FireModel1_private_executor_2026_06_15",
        source_created_at: "2026-08-09T02:36:45.795039+00:00",
      },
    },
    ...overrides,
  } as NightEventReservationRow;
}

/** The exact four sibling rows that existed in production for this condition_id. */
function productionSiblings(): Record<string, unknown>[] {
  return [
    producerShapedRow({
      id: ANCHOR_PAIR_ID,
      conditionId: CONDITION_ID,
      selectedTokenId: "74531221319072082662127561958430587464439956098018275068847277854364923581338",
      selectedOutcome: "Ilbirs eSports",
      signalConfidenceNum: 62,
      entryPriceNum: 0.325,
      metricFormulaVersion: SCORED_VERSION,
      providerEventId: PROVIDER_EVENT_ID,
      providerEventStartIso: EVENT_START,
    }),
    producerShapedRow({
      id: SIBLING_PAIR_ID,
      conditionId: CONDITION_ID,
      selectedTokenId: "11111111111111111111111111111111111111111111111111111111111111111111111111111",
      selectedOutcome: "RE.Arise",
      signalConfidenceNum: 57,
      entryPriceNum: 0.675,
      metricFormulaVersion: SCORED_VERSION,
      providerEventId: PROVIDER_EVENT_ID,
      providerEventStartIso: EVENT_START,
    }),
    // Intentionally-unscored shadow material: signal_confidence_num IS NULL by
    // producer design. Must never become an execution candidate.
    producerShapedRow({
      id: "1d86b468-71cb-4d32-af71-d69d121619d8",
      conditionId: CONDITION_ID,
      selectedTokenId: "22222222222222222222222222222222222222222222222222222222222222222222222222222",
      selectedOutcome: "Ilbirs eSports",
      signalConfidenceNum: null,
      entryPriceNum: 0.365,
      metricFormulaVersion: UNSCORED_SHADOW_VERSION,
      providerEventId: PROVIDER_EVENT_ID,
      providerEventStartIso: EVENT_START,
    }),
    producerShapedRow({
      id: "19639514-d2e8-4690-b373-2c521acc51f2",
      conditionId: CONDITION_ID,
      selectedTokenId: "33333333333333333333333333333333333333333333333333333333333333333333333333333",
      selectedOutcome: "RE.Arise",
      signalConfidenceNum: null,
      entryPriceNum: 0.635,
      metricFormulaVersion: UNSCORED_SHADOW_VERSION,
      providerEventId: PROVIDER_EVENT_ID,
      providerEventStartIso: EVENT_START,
    }),
  ];
}

interface Harness {
  queue: EventExecutionQueueRow[];
  skipped: { id: string; reason: string }[];
  queued: string[];
  run: (nowMs?: number) => Promise<{ queued_count: number; first_rejection_code: string | null }>;
  table: GeneratedSignalPairsTable;
}

function harness(
  rows: readonly Record<string, unknown>[],
  reservation: NightEventReservationRow,
): Harness {
  const table = new GeneratedSignalPairsTable();
  table.insertAll(rows);

  const queue: EventExecutionQueueRow[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const queued: string[] = [];
  let current = reservation;

  const repo: RebalanceRepoPort = {
    async loadActiveReservations() {
      return [current];
    },
    async loadQueuedReservationIds() {
      return new Set(queue.map((q) => q.reservation_id).filter((v): v is string => v !== null));
    },
    async markReservationsExpired() {},
    async markReservationSkipped(id: string, reason: string) {
      skipped.push({ id, reason });
      current = { ...current, status: "SKIPPED", selection_reason: reason };
    },
    async markReservationQueued(id: string) {
      queued.push(id);
      current = { ...current, status: "QUEUED" };
    },
    async insertQueueRow(value: EventExecutionQueueRow) {
      queue.push(value);
    },
  };

  const deps = {
    repo,
    // THE REAL LOADER against the schema-enforcing table. Not an injected row list.
    fetchFinalIdentitySourceRows: (r: NightEventReservationRow) =>
      loadExactProviderSiblingRowsFromAnchor(
        r,
        (id: string) => table.queryById(id),
        (identity) => table.queryByProviderEvent(identity),
      ),
    // Any post-Reservation re-entry into model / broad discovery is a contract breach.
    fetchCandidates: async () => {
      throw new Error("HIDDEN_GATE: broad model candidates must never run post-Reservation");
    },
  };

  return {
    queue,
    skipped,
    queued,
    table,
    run: async (nowMs = NOW) => {
      const r = await runEventRebalance(nowMs, { write: true }, deps);
      return {
        queued_count: r.queued_count,
        first_rejection_code: (r as { first_rejection_code?: string | null }).first_rejection_code ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 0. The harness itself must be strong enough to prevent the original false green.
// ---------------------------------------------------------------------------

test("C1-0a: phantom execution columns are provably absent from the real schema", () => {
  assertNoPhantomExecutionColumns(assert);
});

test("C1-0b: harness rejects the exact fabrication that made the old selector test green", () => {
  const table = new GeneratedSignalPairsTable();
  const fabricated = {
    ...producerShapedRow({
      id: "fab", conditionId: CONDITION_ID, selectedTokenId: "t", selectedOutcome: "YES",
      signalConfidenceNum: 91, entryPriceNum: 0.5, metricFormulaVersion: SCORED_VERSION,
      providerEventId: PROVIDER_EVENT_ID, providerEventStartIso: EVENT_START,
    }),
    // These are precisely what tests/contur3/eventExecutionQueue.minimalPath.test.ts wrote.
    stake_usd: 1.1,
    max_entry_price: 0.62,
    signal_score: 91,
  };
  assert.throws(() => table.insert(fabricated), SchemaViolationError);
});

// ---------------------------------------------------------------------------
// 1. The production failure, reproduced end to end. RED on base.
// ---------------------------------------------------------------------------

test("C1-1: natural due Reservation reaches Queue via highest authoritative score", async () => {
  const h = harness(productionSiblings(), productionReservation());
  const result = await h.run();

  assert.notEqual(RESERVATION_EVENT_START, EVENT_START, "the regression must cross the real timestamptz/JSON serialization boundary");
  assert.equal(Date.parse(RESERVATION_EVENT_START), Date.parse(EVENT_START));

  assert.equal(
    result.queued_count,
    1,
    `expected exactly one Queue row; skipped=${JSON.stringify(h.skipped)}`,
  );
  assert.equal(h.queue.length, 1);

  const q = h.queue[0];
  const diag = q.diagnostics as Record<string, unknown>;

  // Winner is decided by authoritative score (62 > 57), not by being the anchor.
  assert.equal(diag.selected_signal_pair_id, ANCHOR_PAIR_ID);
  assert.equal(q.score, 62);
  assert.equal(q.condition_id, CONDITION_ID);
  assert.equal(q.side, "Ilbirs eSports");

  // Stake comes from the execution contract constant, never from a row field.
  assert.equal(q.stake_usd, EXECUTABLE_STAKE_USD);
  assert.equal(diag.stake_guard_usd, EXECUTABLE_STAKE_USD);

  // Frozen pre-Reservation accepted snapshot price, carried unmodified.
  assert.equal(diag.max_entry_price, 0.325);

  // Exact identity lineage.
  assert.equal(diag.physical_event_id, PHYSICAL_ID);
  assert.equal(diag.event_start_iso, RESERVATION_EVENT_START);
  assert.equal(q.reservation_id, "36fe6db7-e0d0-4609-a92e-25fed17c6fbb");
});

test("C1-2: unscored shadow rows cannot win even when they are the only siblings", async () => {
  const onlyShadow = productionSiblings().filter(
    (r) => r.metric_formula_version === UNSCORED_SHADOW_VERSION,
  );
  // Point the Reservation anchor at a shadow row so the loader resolves.
  const res = productionReservation({
    diagnostics: {
      ...(productionReservation().diagnostics as Record<string, unknown>),
      source_lineage: {
        ...((productionReservation().diagnostics as Record<string, unknown>)
          .source_lineage as Record<string, unknown>),
        generated_signal_pair_id: "1d86b468-71cb-4d32-af71-d69d121619d8",
      },
    },
  } as Partial<NightEventReservationRow>);

  const h = harness(onlyShadow, res);
  const result = await h.run();

  assert.equal(result.queued_count, 0, "unscored shadow material must never be executable");
  assert.equal(h.queue.length, 0);
  assert.equal(h.skipped[0]?.reason, "NO_EXACT_RESERVED_EVENT_SIGNAL_PAIR");
});

test("C1-3: missing accepted price fails closed", async () => {
  const rows = [
    producerShapedRow({
      id: ANCHOR_PAIR_ID, conditionId: CONDITION_ID, selectedTokenId: "tok-a",
      selectedOutcome: "Ilbirs eSports", signalConfidenceNum: 62,
      entryPriceNum: null, // never priced
      metricFormulaVersion: SCORED_VERSION,
      providerEventId: PROVIDER_EVENT_ID, providerEventStartIso: EVENT_START,
    }),
  ];
  const h = harness(rows, productionReservation());
  const result = await h.run();
  assert.equal(result.queued_count, 0);
  assert.equal(h.skipped[0]?.reason, "NO_EXACT_RESERVED_EVENT_SIGNAL_PAIR");
});

test("C1-4: deterministic canonical tie-break on equal authoritative score", async () => {
  const tie = [
    producerShapedRow({
      id: ANCHOR_PAIR_ID, conditionId: CONDITION_ID, selectedTokenId: "tok-z",
      selectedOutcome: "Ilbirs eSports", signalConfidenceNum: 70, entryPriceNum: 0.4,
      metricFormulaVersion: SCORED_VERSION,
      providerEventId: PROVIDER_EVENT_ID, providerEventStartIso: EVENT_START,
    }),
    producerShapedRow({
      id: SIBLING_PAIR_ID, conditionId: CONDITION_ID, selectedTokenId: "tok-a",
      selectedOutcome: "RE.Arise", signalConfidenceNum: 70, entryPriceNum: 0.6,
      metricFormulaVersion: SCORED_VERSION,
      providerEventId: PROVIDER_EVENT_ID, providerEventStartIso: EVENT_START,
    }),
  ];
  const h = harness(tie, productionReservation());
  await h.run();
  assert.equal(h.queue.length, 1);
  // Same condition_id -> tie-break falls to token_id ascending: tok-a < tok-z.
  assert.equal(h.queue[0].token_id, "tok-a");
  assert.equal(h.queue[0].score, 70);
});

test("C1-5: incompatible score-contract version is excluded from competition", async () => {
  const rows = [
    producerShapedRow({
      id: ANCHOR_PAIR_ID, conditionId: CONDITION_ID, selectedTokenId: "tok-anchor",
      selectedOutcome: "Ilbirs eSports", signalConfidenceNum: 60, entryPriceNum: 0.325,
      metricFormulaVersion: SCORED_VERSION,
      providerEventId: PROVIDER_EVENT_ID, providerEventStartIso: EVENT_START,
    }),
    // Scored and priced, but a DIFFERENT score contract: higher raw number must
    // not win, because the scales are not proven comparable.
    producerShapedRow({
      id: SIBLING_PAIR_ID, conditionId: CONDITION_ID, selectedTokenId: "tok-other",
      selectedOutcome: "RE.Arise", signalConfidenceNum: 99, entryPriceNum: 0.5,
      metricFormulaVersion: "v2-lite-growth-safe",
      providerEventId: PROVIDER_EVENT_ID, providerEventStartIso: EVENT_START,
    }),
  ];
  const h = harness(rows, productionReservation());
  await h.run();
  assert.equal(h.queue.length, 1);
  assert.equal(
    (h.queue[0].diagnostics as Record<string, unknown>).selected_signal_pair_id,
    ANCHOR_PAIR_ID,
    "a foreign score domain must not out-rank the Reservation's own domain",
  );
  assert.equal(h.queue[0].score, 60);
});

test("C1-6: wrong provider event / start / physical identity are all rejected", async () => {
  // Wrong provider event id on the sibling: loader must drop it, leaving only the anchor.
  const wrongEvent = [
    producerShapedRow({
      id: ANCHOR_PAIR_ID, conditionId: CONDITION_ID, selectedTokenId: "tok-anchor",
      selectedOutcome: "Ilbirs eSports", signalConfidenceNum: 62, entryPriceNum: 0.325,
      metricFormulaVersion: SCORED_VERSION,
      providerEventId: PROVIDER_EVENT_ID, providerEventStartIso: EVENT_START,
    }),
    producerShapedRow({
      id: SIBLING_PAIR_ID, conditionId: CONDITION_ID, selectedTokenId: "tok-foreign",
      selectedOutcome: "RE.Arise", signalConfidenceNum: 99, entryPriceNum: 0.5,
      metricFormulaVersion: SCORED_VERSION,
      providerEventId: "999999", providerEventStartIso: EVENT_START,
    }),
  ];
  const hEvent = harness(wrongEvent, productionReservation());
  await hEvent.run();
  assert.equal(hEvent.queue.length, 1);
  assert.equal(hEvent.queue[0].score, 62, "foreign provider event must not compete");

  // Wrong authoritative start on the Reservation: nothing may match.
  const hStart = harness(
    productionSiblings(),
    productionReservation({
      event_start_iso: "2026-08-09T19:30:00Z",
      game_start_iso: "2026-08-09T19:30:00Z",
    } as Partial<NightEventReservationRow>),
  );
  const startResult = await hStart.run(Date.parse("2026-08-09T18:30:00.000Z"));
  assert.equal(startResult.queued_count, 0, "authoritative start mismatch must fail closed");

  // Wrong physical identity on the Reservation: nothing may match.
  const hPhys = harness(
    productionSiblings(),
    productionReservation({
      physical_event_id: "provider:polymarket:000000:2026-08-09",
    } as Partial<NightEventReservationRow>),
  );
  const physResult = await hPhys.run();
  assert.equal(physResult.queued_count, 0, "physical identity mismatch must fail closed");

  // An unparsable persisted Reservation timestamp must never become an
  // implicit match for otherwise-valid provider siblings.
  const hInvalidStart = harness(
    productionSiblings(),
    productionReservation({
      event_start_iso: "not-a-timestamp",
      game_start_iso: "not-a-timestamp",
    } as Partial<NightEventReservationRow>),
  );
  const invalidResult = await hInvalidStart.run();
  assert.equal(invalidResult.queued_count, 0, "invalid event-start timestamps must fail closed");
});

test("C1-7: repeated natural cadence creates no duplicate Queue for the same identity", async () => {
  const h = harness(productionSiblings(), productionReservation());
  const first = await h.run();
  assert.equal(first.queued_count, 1);

  const idem = h.queue[0].idempotency_key;
  const orderKey = h.queue[0].order_key;

  // Two further ordinary cadence cycles.
  const second = await h.run(NOW + 5 * 60_000);
  const third = await h.run(NOW + 10 * 60_000);

  assert.equal(second.queued_count, 0);
  assert.equal(third.queued_count, 0);
  assert.equal(h.queue.length, 1, "no second Queue row for the same authorized identity");
  assert.equal(h.queue[0].idempotency_key, idem);
  assert.equal(h.queue[0].order_key, orderKey);
});

test("C1-8: frozen accepted price and stake survive the serialization boundary", async () => {
  const h = harness(productionSiblings(), productionReservation());
  await h.run();
  const diag = h.queue[0].diagnostics as Record<string, unknown>;
  // Round-trip the Queue row the way the queue table would store it.
  const roundTripped = JSON.parse(JSON.stringify(h.queue[0])) as EventExecutionQueueRow;
  const rtDiag = roundTripped.diagnostics as Record<string, unknown>;
  assert.equal(rtDiag.max_entry_price, diag.max_entry_price);
  assert.equal(rtDiag.max_entry_price, 0.325);
  assert.equal(roundTripped.stake_usd, EXECUTABLE_STAKE_USD);
  assert.equal(rtDiag.selected_signal_score, 62);
});
