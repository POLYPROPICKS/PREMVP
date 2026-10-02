// Constructor V1 runtime-instance boot: one select -> compose -> validate sequence shared by every
// entry point, usable for two instances in one process without touching process-pinned selection.
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { bootContourRuntime, CONSTRUCTOR_SELECTOR_NOT_EXPLICIT } from "../../lib/constructor/bootstrap";
import { CONSTRUCTOR_CONTOUR_UNKNOWN } from "../../lib/constructor/registry";
import { CONSTRUCTOR_RUNTIME_INVALID } from "../../lib/constructor/runtimeContract";
import { assertMoneyMovementEnabled } from "../../lib/constructor/contracts";

const ROOT = path.resolve(__dirname, "../..");
const SHADOW_ENV = {
  CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW",
  SHADOW_EXECUTOR_CANDIDATES_SECRET: "s",
  SHADOW_SUPABASE_URL: "http://shadow.invalid",
  SHADOW_SUPABASE_SERVICE_ROLE_KEY: "k",
};

test("DEV parity: unset selector boots DEV_LIVE with money enabled and no validation requirements", () => {
  const { contour, contract } = bootContourRuntime({});
  assert.equal(contour.profile.contourId, "DEV_LIVE");
  assert.equal(contract.moneyMovement, "enabled");
  assert.doesNotThrow(() => assertMoneyMovementEnabled(contour, "T"));
  assert.equal(contract.bindings.supabaseUrl.envVar, "SUPABASE_URL");
  assert.deepEqual(contract.forbiddenAmbientEnv, []);
});

test("PROD_SHADOW boots from its own bindings only; money movement is blocked", () => {
  const { contour, contract } = bootContourRuntime(SHADOW_ENV);
  assert.equal(contour.profile.contourId, "PROD_SHADOW");
  assert.equal(contract.moneyMovement, "disabled");
  assert.throws(() => assertMoneyMovementEnabled(contour, "T"), /CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/);
});

test("two instances boot independently in one process (no module-level singleton leaks between them)", () => {
  const shadow = bootContourRuntime(SHADOW_ENV);
  const dev = bootContourRuntime({});
  const shadowAgain = bootContourRuntime(SHADOW_ENV);
  assert.notEqual(dev.contour.instance.instanceId, shadow.contour.instance.instanceId);
  assert.equal(shadow.contour, shadowAgain.contour, "composition is memoized per id, not per caller");
  assert.equal(dev.contour.profile.capabilities.moneyMovement, "enabled");
});

test("fail-closed: unknown selector, missing shadow bindings, ambient DEV bindings", () => {
  assert.throws(() => bootContourRuntime({ CONSTRUCTOR_ACTIVE_CONTOUR: "prod_shadow" }), new RegExp(CONSTRUCTOR_CONTOUR_UNKNOWN));
  const { SHADOW_SUPABASE_URL: _omit, ...partial } = SHADOW_ENV;
  assert.throws(() => bootContourRuntime(partial), new RegExp(`${CONSTRUCTOR_RUNTIME_INVALID}: MISSING_REQUIRED_BINDINGS:SHADOW_SUPABASE_URL`));
  assert.throws(() => bootContourRuntime({ ...SHADOW_ENV, SUPABASE_URL: "http://dev" }), new RegExp(`${CONSTRUCTOR_RUNTIME_INVALID}: AMBIENT_FOREIGN_BINDING_PRESENT`));
});

test("requireExplicitSelector refuses an unset selector instead of defaulting to DEV", () => {
  assert.throws(() => bootContourRuntime({}, { requireExplicitSelector: true }), new RegExp(CONSTRUCTOR_SELECTOR_NOT_EXPLICIT));
  assert.equal(bootContourRuntime(SHADOW_ENV, { requireExplicitSelector: true }).contour.profile.contourId, "PROD_SHADOW");
});

test("entry points share the boot: no hand-rolled select+validate remains in instrumentation/supabase server/boot-check", () => {
  for (const f of ["instrumentation.ts", "lib/supabase/server.ts", "scripts/constructor/shadow-boot-check.ts"]) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    assert.match(src, /bootProcessRuntime/, f);
    assert.doesNotMatch(src, /validateContourRuntime|getActiveContour/, `${f} must not re-derive select+validate`);
  }
});

test("REALISTIC PASSIVE PATH (child process): PROD_SHADOW -> bootstrap -> shadow-bound supabase client -> engine dry-run -> money boundary blocks", () => {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[k]) base[k] = process.env[k]!;
  }
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/constructor/fixtures/shadowPassivePath.ts"], {
    cwd: ROOT,
    env: { ...base, ...SHADOW_ENV } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop()!) as { blocked: boolean; inserts: number; instance: string };
  assert.deepEqual(out, { blocked: true, inserts: 0, instance: "PROD_SHADOW_PASSIVE" });
});

test("manifest delta is exactly the bootstrap component; DEV bindings/capability/selectors untouched, shadow shares the set", async () => {
  const { DEV_LIVE_DECLARATION } = await import("../../lib/constructor/devLive");
  const { PROD_SHADOW_DECLARATION } = await import("../../lib/constructor/prodShadow");
  const ids = DEV_LIVE_DECLARATION.manifest.components.map((c) => c.id);
  assert.equal(ids.length, 14);
  assert.ok(ids.includes("runtime.bootstrap"));
  assert.deepEqual([...DEV_LIVE_DECLARATION.profile.requiredComponents].sort(), [...ids].sort());
  assert.deepEqual(PROD_SHADOW_DECLARATION.manifest.components, DEV_LIVE_DECLARATION.manifest.components);
  assert.deepEqual(DEV_LIVE_DECLARATION.instance.envBindings, {
    reservationTimesMinsk: "RESERVATION_TIMES_MINSK",
    executorCandidatesSecret: "EXECUTOR_CANDIDATES_SECRET",
    supabaseUrl: "SUPABASE_URL",
    supabaseServiceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
  });
  assert.equal(DEV_LIVE_DECLARATION.profile.capabilities.moneyMovement, "enabled");
});
