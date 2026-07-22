import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingResolutionQuerySpec,
  buildTrackRecordEligibilityQuerySpec,
  sortTrackRecordPriorityCandidates,
  TRACK_RECORD_DISPLAY_SELECT_COLUMNS,
  PENDING_RESOLUTION_SELECT_COLUMNS,
  type TrackRecordPriorityCandidate,
  isUuidLike,
  extractLiveQueueSourceSignalIds,
  buildLiveLedgerEligibilityQuerySpec,
  LIVE_QUEUE_SOURCE_STATUSES,
  type LiveQueueSourceRow,
} from "../../scripts/resolve-signals";

// Confirmed-stuck resolver_rank cases from track_record_display_signals SQL
// evidence: resolver_rank 18,508 / 31,245 / 91,527 are far outside any
// generic backlog window (--limit=500), so the generic queue alone never
// reaches them. The track-record priority mode must select them directly by
// display score_rank/window_days, independent of resolver_rank.
const CASE_1_CONCRETE_VALORANT = {
  id: "71133492-e81c-4373-b25a-9b702edd8c85",
  condition_id:
    "0xaf318a24691530b1a8dadbcdad027f2cc4742b514f4d3cfa717dc69642b22469",
  selected_token_id:
    "86709938698828930887404798600628041803434316051109258637816146177749787028460",
  entry_price_num: 0.725,
  metric_formula_version: "shadow-strategic-sports-v1",
  resolved_at: null as string | null,
  signal_result: null as string | null,
  expires_at: "2026-06-25T16:00:00.000Z",
  created_at: "2026-06-10T00:00:00.000Z",
};

test("normal expired query is unaffected: priority mode does not change buildPendingResolutionQuerySpec", () => {
  const spec = buildPendingResolutionQuerySpec({
    onlyExpired: true,
    expiredCutoff: "2026-07-02T06:03:33.773Z",
    createdAfter: "2026-06-02T06:03:33.773Z",
    orderMode: "oldest",
    limit: 500,
  });

  assert.deepEqual(
    spec.order.map((o) => o.column),
    ["expires_at", "created_at", "id"],
  );
  assert.equal(spec.filters.signalResultIsNull, true);
});

test("track-record eligibility spec: narrow select, ids-scoped, resolved_at/signal_result/identity filters", () => {
  const spec = buildTrackRecordEligibilityQuerySpec({
    ids: [CASE_1_CONCRETE_VALORANT.id, "other-id"],
    nowIso: "2026-07-02T06:03:33.773Z",
    createdAfter: "2026-06-02T06:03:33.773Z",
  });

  assert.deepEqual(spec.ids, [CASE_1_CONCRETE_VALORANT.id, "other-id"]);
  assert.equal(spec.filters.resolvedAtIsNull, true);
  assert.equal(spec.filters.signalResultNotWonLost, true);
  assert.equal(spec.filters.conditionIdNotNull, true);
  assert.equal(spec.filters.selectedTokenIdNotNull, true);
  assert.equal(spec.filters.entryPriceNumNotNull, true);
  assert.equal(spec.filters.metricFormulaVersionNotNull, true);
  assert.equal(spec.filters.expiresAtLte, "2026-07-02T06:03:33.773Z");
  assert.equal(spec.filters.createdAtGte, "2026-06-02T06:03:33.773Z");

  assert.ok(!spec.select.includes("premium_signal"));
  assert.ok(!spec.select.includes("diagnostics"));

  assert.ok(TRACK_RECORD_DISPLAY_SELECT_COLUMNS.includes("source_row_id"));
  assert.ok(TRACK_RECORD_DISPLAY_SELECT_COLUMNS.includes("window_days"));
  assert.ok(TRACK_RECORD_DISPLAY_SELECT_COLUMNS.includes("score_rank"));
});

test("track-record priority order: window_days desc, score_rank asc nulls last, then expires_at/created_at/id", () => {
  const candidates: TrackRecordPriorityCandidate[] = [
    { id: "c-low-rank-7d", window_days: 7, score_rank: 5, expires_at: "2026-06-20T00:00:00Z", created_at: "2026-06-01T00:00:00Z" },
    { id: "d-high-rank-7d", window_days: 7, score_rank: 1, expires_at: "2026-06-21T00:00:00Z", created_at: "2026-06-02T00:00:00Z" },
    { id: "a-null-rank-14d", window_days: 14, score_rank: null, expires_at: "2026-06-19T00:00:00Z", created_at: "2026-06-03T00:00:00Z" },
    { id: "b-ranked-14d", window_days: 14, score_rank: 2, expires_at: "2026-06-22T00:00:00Z", created_at: "2026-06-04T00:00:00Z" },
  ];

  const sorted = sortTrackRecordPriorityCandidates(candidates);

  // 14D window (larger window_days) comes before 7D; within 14D, ranked
  // before null (nulls last); within 7D, rank 1 before rank 5.
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["b-ranked-14d", "a-null-rank-14d", "d-high-rank-7d", "c-low-rank-7d"],
  );
});

test("CASE_1/2/3 shape is eligible for track-record priority regardless of generic resolver_rank (18508/31245/91527)", () => {
  // Same predicate the resolver applies to generated_signal_pairs rows found
  // via track_record_display_signals.source_row_id — independent of the
  // generic backlog's resolver_rank ordering.
  function isEligible(row: typeof CASE_1_CONCRETE_VALORANT): boolean {
    if (row.resolved_at !== null) return false;
    if (row.signal_result === "won" || row.signal_result === "lost") return false;
    if (!row.condition_id) return false;
    if (!row.selected_token_id) return false;
    if (row.entry_price_num === null) return false;
    if (!row.metric_formula_version) return false;
    return true;
  }

  assert.equal(isEligible(CASE_1_CONCRETE_VALORANT), true);
});

test("no resolved/future/missing-identity rows are selected", () => {
  const nowIso = "2026-07-02T06:03:33.773Z";

  function isEligible(row: {
    resolved_at: string | null;
    signal_result: string | null;
    condition_id: string | null;
    selected_token_id: string | null;
    entry_price_num: number | null;
    metric_formula_version: string | null;
    expires_at: string;
  }): boolean {
    if (row.resolved_at !== null) return false;
    if (row.signal_result === "won" || row.signal_result === "lost") return false;
    if (!row.condition_id || !row.selected_token_id) return false;
    if (row.entry_price_num === null) return false;
    if (!row.metric_formula_version) return false;
    if (row.expires_at > nowIso) return false; // future — not expired yet
    return true;
  }

  const alreadyResolved = { ...CASE_1_CONCRETE_VALORANT, resolved_at: "2026-06-26T00:00:00Z", signal_result: "won" };
  const stillFuture = { ...CASE_1_CONCRETE_VALORANT, expires_at: "2026-12-01T00:00:00Z" };
  const missingToken = { ...CASE_1_CONCRETE_VALORANT, selected_token_id: null };
  const missingFormula = { ...CASE_1_CONCRETE_VALORANT, metric_formula_version: null };

  assert.equal(isEligible(alreadyResolved), false);
  assert.equal(isEligible(stillFuture), false);
  assert.equal(isEligible(missingToken), false);
  assert.equal(isEligible(missingFormula), false);
  assert.equal(isEligible(CASE_1_CONCRETE_VALORANT), true);
});

// --- Live-ledger (event_execution_queue-first) priority resolution --------
//
// Production incident, 2026-07-21: founder battle batch had 4 EXECUTED + 4
// FAILED event_execution_queue rows, all 8 with a valid
// diagnostics.source_signal_id pointing at generated_signal_pairs.id. The
// old --priority-live-ledger path only read executor_order_events
// (dry_run=false, live_confirm/success within 24h) and joined by
// (condition_id, selected_token_id) — it logged
// LIVE_PRIORITY_LEDGER_SUPABASE_EMPTY_LAST_24H and matched 0 rows, so those
// 8 source signals were never reached ahead of the generic backlog (which
// itself never got that deep). This new path resolves directly from the
// queue's own diagnostics.source_signal_id, independent of
// executor_order_events / clob_order_id.

const LIVE_SOURCE_ID = "71133492-e81c-4373-b25a-9b702edd8c85";

test("PhysEvent/LiveLedger-1: EXECUTED queue row with a valid diagnostics.source_signal_id is extracted", () => {
  const rows: LiveQueueSourceRow[] = [
    { id: "q1", status: "EXECUTED", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: { source_signal_id: LIVE_SOURCE_ID } },
  ];
  assert.deepEqual(extractLiveQueueSourceSignalIds(rows), [LIVE_SOURCE_ID]);
});

test("LiveLedger-2: FAILED (rejected) queue rows are included too — no clob_order_id or executor_order_events row required", () => {
  const rows: LiveQueueSourceRow[] = [
    { id: "q-failed", status: "FAILED", updated_at: "2026-07-21T20:05:00.000Z", diagnostics: { source_signal_id: LIVE_SOURCE_ID } },
  ];
  assert.deepEqual(extractLiveQueueSourceSignalIds(rows), [LIVE_SOURCE_ID]);
  assert.deepEqual([...LIVE_QUEUE_SOURCE_STATUSES], ["EXECUTED", "FAILED"]);
});

test("LiveLedger-3: invalid/non-UUID source_signal_id values are ignored, not thrown, and don't poison other rows", () => {
  const otherId = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
  const rows: LiveQueueSourceRow[] = [
    { id: "q-bad-1", status: "EXECUTED", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: { source_signal_id: "not-a-uuid" } },
    { id: "q-bad-2", status: "EXECUTED", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: { source_signal_id: 12345 } },
    { id: "q-bad-3", status: "EXECUTED", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: {} },
    { id: "q-bad-4", status: "EXECUTED", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: null },
    { id: "q-good", status: "EXECUTED", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: { source_signal_id: otherId } },
  ];
  assert.deepEqual(extractLiveQueueSourceSignalIds(rows), [otherId]);
  assert.equal(isUuidLike("not-a-uuid"), false);
  assert.equal(isUuidLike(12345), false);
  assert.equal(isUuidLike(otherId), true);
});

test("LiveLedger-4: a READY/CLAIMED/SENT queue row (not EXECUTED/FAILED) is not treated as a live-priority source", () => {
  const rows: LiveQueueSourceRow[] = [
    { id: "q-ready", status: "READY", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: { source_signal_id: LIVE_SOURCE_ID } },
    { id: "q-claimed", status: "CLAIMED", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: { source_signal_id: LIVE_SOURCE_ID } },
  ];
  assert.deepEqual(extractLiveQueueSourceSignalIds(rows), []);
});

test("LiveLedger-5: repeated queue rows pointing at the same source_signal_id dedupe to one id", () => {
  const rows: LiveQueueSourceRow[] = [
    { id: "q1", status: "EXECUTED", updated_at: "2026-07-21T20:00:00.000Z", diagnostics: { source_signal_id: LIVE_SOURCE_ID } },
    { id: "q2", status: "FAILED", updated_at: "2026-07-21T20:01:00.000Z", diagnostics: { source_signal_id: LIVE_SOURCE_ID } },
  ];
  assert.deepEqual(extractLiveQueueSourceSignalIds(rows), [LIVE_SOURCE_ID]);
});

test("LiveLedger-6: eligibility spec applies normal resolver eligibility (signal_result null + identity + formula-version), scoped to source ids", () => {
  const spec = buildLiveLedgerEligibilityQuerySpec([LIVE_SOURCE_ID, "other-id"]);

  assert.deepEqual(spec.ids, [LIVE_SOURCE_ID, "other-id"]);
  assert.equal(spec.filters.signalResultIsNull, true);
  assert.equal(spec.filters.conditionIdNotNull, true);
  assert.equal(spec.filters.selectedTokenIdNotNull, true);
  assert.equal(spec.filters.entryPriceNumNotNull, true);
  assert.equal(spec.filters.metricFormulaVersionNotNull, true);
  // Same narrow select used by the generic backlog spec — no
  // premium_signal/diagnostics blobs during candidate discovery.
  assert.equal(spec.select, PENDING_RESOLUTION_SELECT_COLUMNS);
});

test("LiveLedger-7: a row excluded by metric_formula_version IS NULL under the shared eligibility predicate is not resolved", () => {
  function isEligible(row: {
    signal_result: string | null;
    condition_id: string | null;
    selected_token_id: string | null;
    entry_price_num: number | null;
    metric_formula_version: string | null;
  }): boolean {
    if (row.signal_result !== null) return false;
    if (!row.condition_id || !row.selected_token_id) return false;
    if (row.entry_price_num === null) return false;
    if (!row.metric_formula_version) return false;
    return true;
  }

  const eligibleRow = {
    signal_result: null,
    condition_id: "cond-x",
    selected_token_id: "token-x",
    entry_price_num: 0.4,
    metric_formula_version: "v2-lite-growth-safe",
  };
  const nullFormulaRow = { ...eligibleRow, metric_formula_version: null };

  assert.equal(isEligible(eligibleRow), true);
  assert.equal(isEligible(nullFormulaRow), false);
});

test("LiveLedger-8 (regression, production incident 2026-07-21): 4 EXECUTED + 4 FAILED queue rows with valid source_signal_id all yield a resolvable id set, before-patch would have been 0 via executor_order_events alone", () => {
  const rows: LiveQueueSourceRow[] = [
    { id: "q-exec-1", status: "EXECUTED", updated_at: "2026-07-21T21:00:00.000Z", diagnostics: { source_signal_id: "11111111-1111-4111-8111-111111111111" } },
    { id: "q-exec-2", status: "EXECUTED", updated_at: "2026-07-21T21:01:00.000Z", diagnostics: { source_signal_id: "22222222-2222-4222-8222-222222222222" } },
    { id: "q-exec-3", status: "EXECUTED", updated_at: "2026-07-21T21:02:00.000Z", diagnostics: { source_signal_id: "33333333-3333-4333-8333-333333333333" } },
    { id: "q-exec-4", status: "EXECUTED", updated_at: "2026-07-21T21:03:00.000Z", diagnostics: { source_signal_id: "44444444-4444-4444-8444-444444444444" } },
    { id: "q-fail-1", status: "FAILED", updated_at: "2026-07-21T21:04:00.000Z", diagnostics: { source_signal_id: "55555555-5555-4555-8555-555555555555" } },
    { id: "q-fail-2", status: "FAILED", updated_at: "2026-07-21T21:05:00.000Z", diagnostics: { source_signal_id: "66666666-6666-4666-8666-666666666666" } },
    { id: "q-fail-3", status: "FAILED", updated_at: "2026-07-21T21:06:00.000Z", diagnostics: { source_signal_id: "77777777-7777-4777-8777-777777777777" } },
    { id: "q-fail-4", status: "FAILED", updated_at: "2026-07-21T21:07:00.000Z", diagnostics: { source_signal_id: "88888888-8888-4888-8888-888888888888" } },
  ];

  const ids = extractLiveQueueSourceSignalIds(rows);
  assert.equal(ids.length, 8, "all 8 source signals must be selected by the new queue-first path");

  const spec = buildLiveLedgerEligibilityQuerySpec(ids);
  assert.equal(spec.ids.length, 8);
  assert.equal(spec.filters.signalResultIsNull, true);
  assert.equal(spec.filters.metricFormulaVersionNotNull, true);
});

test("LiveLedger-9 (canonical Contract A lane, not founder-battle-batch): a queue row with no plan_run_id/battle-batch naming at all is picked up identically -- LiveQueueSourceRow has no plan_run_id field, so extraction is structurally source-path-agnostic", () => {
  // Deliberately no plan_run_id anywhere in this fixture (unlike battle-batch
  // rows, which use a "founder-battle-batch:..." prefix) -- LiveQueueSourceRow
  // itself carries only id/status/updated_at/diagnostics, proving the
  // resolver's live-priority query cannot distinguish, and does not need to
  // distinguish, canonical Contract A rows from founder-battle-batch rows.
  const canonicalId = "99999999-9999-4999-8999-999999999999";
  const canonicalShapeRow: LiveQueueSourceRow = {
    id: "queue-canonical-1",
    status: "EXECUTED",
    updated_at: "2026-07-22T09:00:00.000Z",
    diagnostics: {
      source_signal_id: canonicalId,
      selector_id: "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M",
      battle_trace_id: "contur3:night-plan:2026-07-22:1700-minsk:pair:team-a-vs-team-b:cond-1:tok-1",
    },
  };
  assert.deepEqual(extractLiveQueueSourceSignalIds([canonicalShapeRow]), [canonicalId]);
});
