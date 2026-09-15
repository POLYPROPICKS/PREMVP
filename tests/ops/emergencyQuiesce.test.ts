import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isEmergencyQuiesceActive,
  buildEmergencyQuiesceResult,
  parseQuiesceScopes,
  EMERGENCY_QUIESCE_RESULT,
} from "../../lib/ops/emergencyQuiesce";

// EMERGENCY_QUIESCE_PROD_DB_BACKGROUND_LOAD_V1 — fail-open by default (both
// EMERGENCY_QUIESCE and EMERGENCY_QUIESCE_SCOPES unset/any other value never
// quiesce anything), so this can never silently activate.

test("inactive when neither EMERGENCY_QUIESCE nor EMERGENCY_QUIESCE_SCOPES is set", () => {
  assert.equal(isEmergencyQuiesceActive("generate-signals", {} as unknown as NodeJS.ProcessEnv), false);
});

test("EMERGENCY_QUIESCE inactive for any value other than the exact string '1'", () => {
  for (const value of ["0", "true", "TRUE", "yes", " 1", "1 ", ""]) {
    assert.equal(
      isEmergencyQuiesceActive("generate-signals", { EMERGENCY_QUIESCE: value } as unknown as NodeJS.ProcessEnv),
      false,
      `value=${JSON.stringify(value)}`,
    );
  }
});

test("EMERGENCY_QUIESCE=1 quiesces every source (global mode, unchanged legacy behavior)", () => {
  const env = { EMERGENCY_QUIESCE: "1" } as unknown as NodeJS.ProcessEnv;
  for (const source of ["generate-signals", "resolve-signals", "cron/event-rebalance", "cron/night-event-reservations", "research-clone-sync"]) {
    assert.equal(isEmergencyQuiesceActive(source, env), true, `source=${source}`);
  }
});

test("parseQuiesceScopes: trims, drops empties, ignores unset", () => {
  assert.deepEqual([...parseQuiesceScopes({} as unknown as NodeJS.ProcessEnv)], []);
  assert.deepEqual(
    [...parseQuiesceScopes({ EMERGENCY_QUIESCE_SCOPES: " generate-signals ,, research-clone-sync ," } as unknown as NodeJS.ProcessEnv)],
    ["generate-signals", "research-clone-sync"],
  );
});

test("EMERGENCY_QUIESCE_SCOPES quiesces only the exact listed sources -- Reservation/Rebalance untouched", () => {
  const env = { EMERGENCY_QUIESCE_SCOPES: "generate-signals,research-clone-sync" } as unknown as NodeJS.ProcessEnv;
  assert.equal(isEmergencyQuiesceActive("generate-signals", env), true);
  assert.equal(isEmergencyQuiesceActive("research-clone-sync", env), true);
  // The money path is never named in this scope list, so it stays active --
  // this is the exact STABILIZE_PRODUCTION_DB_BY_SELECTIVE_QUIESCE_V1 guarantee.
  assert.equal(isEmergencyQuiesceActive("cron/event-rebalance", env), false);
  assert.equal(isEmergencyQuiesceActive("cron/night-event-reservations", env), false);
  assert.equal(isEmergencyQuiesceActive("resolve-signals", env), false);
});

test("a source not present in EMERGENCY_QUIESCE_SCOPES stays fully active even with other sources scoped", () => {
  const env = { EMERGENCY_QUIESCE_SCOPES: "resolve-signals" } as unknown as NodeJS.ProcessEnv;
  assert.equal(isEmergencyQuiesceActive("resolve-signals", env), true);
  assert.equal(isEmergencyQuiesceActive("generate-signals", env), false);
});

test("buildEmergencyQuiesceResult returns a deterministic ok:true shape per source", () => {
  const a = buildEmergencyQuiesceResult("cron/event-rebalance");
  const b = buildEmergencyQuiesceResult("generate-signals");
  const c = buildEmergencyQuiesceResult("research-clone-sync");
  assert.equal(a.ok, true);
  assert.equal(a.result, EMERGENCY_QUIESCE_RESULT);
  assert.equal(a.source, "cron/event-rebalance");
  assert.equal(b.source, "generate-signals");
  assert.equal(c.source, "research-clone-sync");
  assert.ok(Number.isFinite(Date.parse(a.generated_at_iso)));
});
