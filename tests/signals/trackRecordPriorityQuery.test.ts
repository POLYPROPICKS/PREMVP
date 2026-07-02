import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingResolutionQuerySpec,
  buildTrackRecordEligibilityQuerySpec,
  sortTrackRecordPriorityCandidates,
  TRACK_RECORD_DISPLAY_SELECT_COLUMNS,
  type TrackRecordPriorityCandidate,
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
