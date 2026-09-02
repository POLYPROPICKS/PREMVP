import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUGUST_C4_BASELINE,
  AUGUST_FROZEN_HYPOTHESES,
  AUGUST_FROZEN_RESEARCH_CONTEXT,
  FORWARD_EVALUATION_KEYS,
} from "../../../lib/modeling/forward-rich";

test("August C4 baseline is persisted exactly", () => {
  assert.equal(AUGUST_C4_BASELINE.n, 4117);
  assert.equal(AUGUST_C4_BASELINE.pnlUnits, 474.56);
  assert.equal(AUGUST_C4_BASELINE.roiPct, 11.5269);
  assert.equal(AUGUST_C4_BASELINE.maxDrawdownUnits, -16.41);
  assert.deepEqual(AUGUST_C4_BASELINE.decisionPeriod, {
    fromInclusive: "2026-08-05",
    toInclusive: "2026-08-25",
  });
});

test("three frozen hypotheses persisted exactly with frozen status flags", () => {
  const byId = Object.fromEntries(AUGUST_FROZEN_HYPOTHESES.map((h) => [h.id, h]));

  assert.deepEqual(
    { n: byId.C4_SOCCER_FIRST_TO_SCORE.n, pnl: byId.C4_SOCCER_FIRST_TO_SCORE.pnlUnits, roi: byId.C4_SOCCER_FIRST_TO_SCORE.roiPct, dd: byId.C4_SOCCER_FIRST_TO_SCORE.maxDrawdownUnits },
    { n: 621, pnl: 103.29, roi: 16.63, dd: -13.31 },
  );
  assert.deepEqual(
    { n: byId.C4_SOCCER_EXACT_SCORE.n, pnl: byId.C4_SOCCER_EXACT_SCORE.pnlUnits, roi: byId.C4_SOCCER_EXACT_SCORE.roiPct, dd: byId.C4_SOCCER_EXACT_SCORE.maxDrawdownUnits },
    { n: 196, pnl: 113.13, roi: 57.72, dd: -6.0 },
  );
  assert.deepEqual(
    { n: byId.C4_UWCL.n, pnl: byId.C4_UWCL.pnlUnits, roi: byId.C4_UWCL.roiPct, dd: byId.C4_UWCL.maxDrawdownUnits },
    { n: 87, pnl: 22.35, roi: 25.69, dd: -3.0 },
  );

  for (const h of AUGUST_FROZEN_HYPOTHESES) {
    assert.deepEqual(
      [...h.status].sort(),
      ["FROZEN_DIAGNOSTIC_HYPOTHESIS", "NOT_FORWARD_VALIDATED", "NO_PRODUCTION_MODEL_CHANGE"].sort(),
    );
  }
});

test("forward evaluation keys cover the three hypothesis selectors", () => {
  assert.deepEqual(FORWARD_EVALUATION_KEYS, [
    { field: "marketTypeRaw", value: "soccer_first_to_score" },
    { field: "marketTypeRaw", value: "soccer_exact_score" },
    { field: "providerSportCode", value: "uwcl" },
  ]);
  assert.equal(AUGUST_FROZEN_RESEARCH_CONTEXT.nextSemanticTransition, "FORWARD_RICH_CAPTURE_RELEASE_V1");
});

test("context object is frozen (immutable canonical surface)", () => {
  assert.ok(Object.isFrozen(AUGUST_FROZEN_RESEARCH_CONTEXT));
  assert.ok(Object.isFrozen(AUGUST_FROZEN_HYPOTHESES));
});
