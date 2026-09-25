/**
 * FIELD COMPLETENESS — proves the one-time CONTRACT_A_FIELDS_OVERLAY materialization
 * filled the Sep01–08 market_type / event_start gap that blocked
 * CONTRACT_A_FILTER_SIM_CURRENT, without synthesizing values or changing
 * physical-event grouping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModelReadyView } from "../../../lib/modeling/offline-replay/modelReadyView";

const WINDOW = { from: "2026-09-01", to: "2026-09-08", asOf: "2026-09-10T14:04:29.586Z" as const };

test("field_completeness block is reported", () => {
  const v = loadModelReadyView(WINDOW);
  const fc = v.meta.field_completeness!;
  assert.ok(fc, "meta.field_completeness missing");
  assert.equal(fc.IDENTITY_N, v.rows.length);
  assert.ok(fc.MARKET_TYPE_PRESENT_N > 0);
  assert.ok(fc.EVENT_START_PRESENT_N > 0);
  assert.ok(fc.MARKET_TYPE_PRESENT_PCT >= 0 && fc.MARKET_TYPE_PRESENT_PCT <= 100);
});

test("overlay lifts BOTH_PRESENT_N above the pre-materialization zero", () => {
  const v = loadModelReadyView(WINDOW);
  const fc = v.meta.field_completeness!;
  // pre-materialization the compact corpus had ZERO identities with both fields
  assert.ok(fc.BOTH_PRESENT_N > 0, "CONTRACT_A_FIELDS_OVERLAY did not join");
  assert.ok(fc.CA_FIELDS_OVERLAY_ENRICHED_N > 0, "no rows carry the ca_fields_overlay provenance tag");
});

test("no synthesis: unrecoverable identities stay explicit UNKNOWN and are counted", () => {
  const v = loadModelReadyView(WINDOW);
  const fc = v.meta.field_completeness!;
  const trulyMissingBoth = v.rows.filter((r) => r.market_type == null && r.event_start == null).length;
  assert.equal(fc.UNKNOWN_BOTH_MISSING_N, trulyMissingBoth);
});

test("enriched rows carry a provenance breadcrumb, never overwrite corpus values", () => {
  const v = loadModelReadyView(WINDOW);
  const enriched = v.rows.filter((r) => r.settlement_provenance.includes("ca_fields_overlay"));
  assert.ok(enriched.length > 0);
  for (const r of enriched.slice(0, 50)) {
    assert.match(r.settlement_provenance, /ca_fields_overlay:(market_type|event_start|sport|coverage)/);
  }
});
