import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingResolutionQuerySpec,
  PENDING_RESOLUTION_SELECT_COLUMNS,
} from "../../scripts/resolve-signals";

// Concrete stuck row from Railway (Valorant: Crest Gaming Zst vs Insomnia),
// metric_formula_version=shadow-strategic-sports-v1, expires_at in the past,
// signal_result/resolved_at NULL — must be eligible under this spec.
const CONCRETE_STUCK_ROW = {
  id: "71133492-e81c-4373-b25a-9b702edd8c85",
  condition_id:
    "0xaf318a24691530b1a8dadbcdad027f2cc4742b514f4d3cfa717dc69642b22469",
  selected_token_id:
    "86709938698828930887404798600628041803434316051109258637816146177749787028460",
  selected_outcome: "Crest Gaming Zst",
  entry_price_num: 0.725,
  metric_formula_version: "shadow-strategic-sports-v1",
  expires_at: "2026-06-25T16:00:00.000Z",
  signal_result: null as string | null,
};

function isEligibleUnderSpec(
  row: typeof CONCRETE_STUCK_ROW,
  spec: ReturnType<typeof buildPendingResolutionQuerySpec>,
): boolean {
  if (row.signal_result !== null) return false;
  if (!row.condition_id) return false;
  if (!row.selected_token_id) return false;
  if (row.entry_price_num === null || row.entry_price_num === undefined) return false;
  if (!row.metric_formula_version) return false;
  if (spec.filters.expiresAtLt && !(row.expires_at < spec.filters.expiresAtLt)) return false;
  return true;
}

test("pending-resolution spec: only-expired + oldest + max-age filters and order", () => {
  const expiredCutoff = "2026-07-02T06:03:33.773Z";
  const createdAfter = "2026-06-02T06:03:33.773Z";

  const spec = buildPendingResolutionQuerySpec({
    onlyExpired: true,
    expiredCutoff,
    createdAfter,
    orderMode: "oldest",
    limit: 500,
  });

  // Required eligibility predicates.
  assert.equal(spec.filters.signalResultIsNull, true);
  assert.equal(spec.filters.conditionIdNotNull, true);
  assert.equal(spec.filters.selectedTokenIdNotNull, true);
  assert.equal(spec.filters.entryPriceNumNotNull, true);
  assert.equal(spec.filters.metricFormulaVersionNotNull, true);
  assert.equal(spec.filters.expiresAtLt, expiredCutoff);
  assert.equal(spec.filters.createdAtGte, createdAfter);

  // Deterministic order: expires_at, then created_at, then id tiebreaker —
  // never an unbounded/ambiguous full-table order.
  assert.deepEqual(
    spec.order.map((o) => o.column),
    ["expires_at", "created_at", "id"],
  );
  assert.equal(spec.order[0].ascending, true);
  assert.equal(spec.order[0].nullsFirst, false);

  assert.equal(spec.limit, 500);

  // Narrow column selection — no premium_signal/diagnostics JSON blobs during
  // candidate discovery.
  assert.ok(!PENDING_RESOLUTION_SELECT_COLUMNS.includes("premium_signal"));
  assert.ok(!PENDING_RESOLUTION_SELECT_COLUMNS.includes("diagnostics"));
  assert.ok(PENDING_RESOLUTION_SELECT_COLUMNS.includes("expires_at"));
  assert.ok(PENDING_RESOLUTION_SELECT_COLUMNS.includes("id"));
});

test("pending-resolution spec: newest mode has no expires_at/created_at bound but stays ordered+bounded", () => {
  const spec = buildPendingResolutionQuerySpec({
    onlyExpired: false,
    expiredCutoff: "2026-07-02T06:03:33.773Z",
    createdAfter: null,
    orderMode: "newest",
    limit: 25,
  });

  assert.equal(spec.filters.expiresAtLt, null);
  assert.equal(spec.filters.createdAtGte, null);
  assert.deepEqual(
    spec.order.map((o) => o.column),
    ["created_at", "id"],
  );
  assert.equal(spec.limit, 25);
});

test("concrete stuck shadow-strategic-sports-v1 row is eligible under the spec, not filtered out by formula version", () => {
  const spec = buildPendingResolutionQuerySpec({
    onlyExpired: true,
    expiredCutoff: "2026-07-02T06:03:33.773Z",
    createdAfter: "2026-06-02T06:03:33.773Z",
    orderMode: "oldest",
    limit: 500,
  });

  assert.equal(isEligibleUnderSpec(CONCRETE_STUCK_ROW, spec), true);
});
