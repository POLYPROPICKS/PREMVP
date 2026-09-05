import { test } from "node:test";
import assert from "node:assert/strict";

import { isEmergencyQuiesceActive, buildEmergencyQuiesceResult, EMERGENCY_QUIESCE_RESULT } from "../../lib/ops/emergencyQuiesce";

// EMERGENCY_QUIESCE_PROD_DB_BACKGROUND_LOAD_V1 — the shared kill switch is
// fail-open by default and activates on exactly one explicit value, so it
// can never silently quiesce production.

test("inactive when EMERGENCY_QUIESCE is unset", () => {
  assert.equal(isEmergencyQuiesceActive({} as unknown as NodeJS.ProcessEnv), false);
});

test("inactive for any value other than the exact string '1'", () => {
  for (const value of ["0", "true", "TRUE", "yes", " 1", "1 ", ""]) {
    assert.equal(isEmergencyQuiesceActive({ EMERGENCY_QUIESCE: value } as unknown as NodeJS.ProcessEnv), false, `value=${JSON.stringify(value)}`);
  }
});

test("active only for the exact string '1'", () => {
  assert.equal(isEmergencyQuiesceActive({ EMERGENCY_QUIESCE: "1" } as unknown as NodeJS.ProcessEnv), true);
});

test("buildEmergencyQuiesceResult returns a deterministic ok:true shape per source", () => {
  const a = buildEmergencyQuiesceResult("cron/event-rebalance");
  const b = buildEmergencyQuiesceResult("generate-signals");
  assert.equal(a.ok, true);
  assert.equal(a.result, EMERGENCY_QUIESCE_RESULT);
  assert.equal(a.source, "cron/event-rebalance");
  assert.equal(b.source, "generate-signals");
  assert.ok(Number.isFinite(Date.parse(a.generated_at_iso)));
});
