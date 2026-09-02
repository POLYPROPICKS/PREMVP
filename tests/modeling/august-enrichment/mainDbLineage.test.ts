import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pointInTimeSafe,
  asNumber,
  round4,
  buildFeature,
  buildScoreFeature,
} from "../../../lib/modeling/august-enrichment/mainDbLineage";

const DEC = "2026-08-10T12:00:00.000Z";

test("pointInTimeSafe: null observed_at is decision-row derived => safe", () => {
  assert.equal(pointInTimeSafe(null, DEC), true);
});

test("pointInTimeSafe: observation at or before decision is safe, after is not", () => {
  assert.equal(pointInTimeSafe("2026-08-10T11:59:59.000Z", DEC), true);
  assert.equal(pointInTimeSafe(DEC, DEC), true);
  assert.equal(pointInTimeSafe("2026-08-10T12:00:00.001Z", DEC), false);
});

test("pointInTimeSafe: unparseable timestamps are rejected", () => {
  assert.equal(pointInTimeSafe("not-a-date", DEC), false);
  assert.equal(pointInTimeSafe("2026-08-10T11:00:00Z", "garbage"), false);
});

test("asNumber: coerces finite numbers and numeric strings only", () => {
  assert.equal(asNumber(12.5), 12.5);
  assert.equal(asNumber("12.5"), 12.5);
  assert.equal(asNumber(""), null);
  assert.equal(asNumber(null), null);
  assert.equal(asNumber(NaN), null);
  assert.equal(asNumber("abc"), null);
});

test("round4", () => {
  assert.equal(round4(12.48863), 12.4886);
  assert.equal(round4(0), 0);
});

test("buildFeature: present + point-in-time safe => RECOVERED with full lineage", () => {
  const f = buildFeature({
    value: 6792.58,
    table: "public.generated_signal_pairs",
    field: "diagnostics.volumeUsd",
    semantic: "provider raw market volume (USD)",
    observedAt: "2026-08-10T11:00:00.000Z",
    joinKey: "id=row-1",
    sourceRowId: "row-1",
    decisionIso: DEC,
  });
  assert.equal(f.status, "RECOVERED");
  assert.equal(f.value, 6792.58);
  assert.equal(f.observed_at, "2026-08-10T11:00:00.000Z");
  assert.equal(f.source_table, "public.generated_signal_pairs");
  assert.equal(f.source_field, "diagnostics.volumeUsd");
  assert.equal(f.join_key, "id=row-1");
  assert.equal(f.source_row_id, "row-1");
});

test("buildFeature: missing value => ENRICHMENT_UNRESOLVED, null value, no observed_at", () => {
  const f = buildFeature({
    value: null, table: "t", field: "f", semantic: "s",
    observedAt: null, joinKey: "id=x", sourceRowId: "x", decisionIso: DEC,
  });
  assert.equal(f.status, "ENRICHMENT_UNRESOLVED");
  assert.equal(f.value, null);
  assert.equal(f.observed_at, null);
  assert.equal(f.join_key, "id=x"); // lineage retained even when unresolved
});

test("buildFeature: post-decision value is dropped (leakage guard), never RECOVERED", () => {
  const f = buildFeature({
    value: 123, table: "t", field: "f", semantic: "s",
    observedAt: "2026-08-10T18:00:00.000Z", joinKey: "k", sourceRowId: "r", decisionIso: DEC,
  });
  assert.equal(f.status, "ENRICHMENT_UNRESOLVED");
  assert.equal(f.value, null);
  assert.match(f.note ?? "", /point-in-time/);
});

test("buildScoreFeature: shadow-strategic NULL score => NEVER_PERSISTED_FOR_POPULATION", () => {
  const f = buildScoreFeature({
    value: null, table: "public.generated_signal_pairs", field: "signal_confidence_num",
    semantic: "persisted Signal Score", observedAt: null, id: "row-1", decisionIso: DEC,
    gspRowPresent: true,
  });
  assert.equal(f.status, "NEVER_PERSISTED_FOR_POPULATION");
  assert.equal(f.value, null);
  assert.equal(f.source_row_id, "row-1");
  assert.match(f.note ?? "", /literal NULL/);
});

test("buildScoreFeature: a genuine point-in-time score value is RECOVERED", () => {
  const f = buildScoreFeature({
    value: 61.2, table: "public.generated_signal_research_snapshots", field: "diagnostics.formulaScore",
    semantic: "formula score", observedAt: "2026-08-10T10:00:00.000Z", id: "row-1", decisionIso: DEC,
    gspRowPresent: true,
  });
  assert.equal(f.status, "RECOVERED");
  assert.equal(f.value, 61.2);
});

test("buildScoreFeature: post-decision score is not leaked", () => {
  const f = buildScoreFeature({
    value: 61.2, table: "t", field: "f", semantic: "s",
    observedAt: "2026-08-10T20:00:00.000Z", id: "row-1", decisionIso: DEC, gspRowPresent: true,
  });
  assert.equal(f.status, "NEVER_PERSISTED_FOR_POPULATION");
  assert.equal(f.value, null);
});
