// The ambient foreign-binding guard applies to ANY non-default contour, not only moneyMovement=disabled.
import { test } from "node:test";
import assert from "node:assert/strict";

import { composeContour } from "../../lib/constructor/contracts";
import { DEV_LIVE_COMPONENT_MANIFEST, DEV_LIVE_PROFILE, DEV_LIVE_INSTANCE } from "../../lib/constructor/devLive";
import { getContour } from "../../lib/constructor/registry";
import { describeRuntimeContract, validateContourRuntime } from "../../lib/constructor/runtimeContract";

const SYNTH = composeContour({
  profile: { ...DEV_LIVE_PROFILE, contourId: "SYNTH_MONEY_ON" },
  manifest: { ...DEV_LIVE_COMPONENT_MANIFEST, manifestId: "synth", contourId: "SYNTH_MONEY_ON" },
  instance: {
    ...DEV_LIVE_INSTANCE,
    instanceId: "SYNTH_INSTANCE",
    profileRef: { contourId: "SYNTH_MONEY_ON" },
    manifestRef: { manifestId: "synth", version: DEV_LIVE_COMPONENT_MANIFEST.version },
    envBindings: {
      reservationTimesMinsk: "SYNTH_RESERVATION_TIMES_MINSK",
      executorCandidatesSecret: "SYNTH_EXECUTOR_CANDIDATES_SECRET",
      supabaseUrl: "SYNTH_SUPABASE_URL",
      supabaseServiceRoleKey: "SYNTH_SUPABASE_SERVICE_ROLE_KEY",
    },
  },
});
const OWN = { SYNTH_EXECUTOR_CANDIDATES_SECRET: "s", SYNTH_SUPABASE_URL: "http://synth.invalid", SYNTH_SUPABASE_SERVICE_ROLE_KEY: "k" };

test("synthetic NON-default contour WITH money movement still rejects ambient DEV bindings", () => {
  assert.equal(SYNTH.profile.capabilities.moneyMovement, "enabled");
  assert.doesNotThrow(() => validateContourRuntime(SYNTH, OWN));
  assert.throws(() => validateContourRuntime(SYNTH, { ...OWN, SUPABASE_URL: "http://dev.invalid" }), /AMBIENT_FOREIGN_BINDING_PRESENT:.*SUPABASE_URL/);
  assert.throws(() => validateContourRuntime(SYNTH, { SYNTH_SUPABASE_URL: "x" }), /MISSING_REQUIRED_BINDINGS/);
  assert.ok(describeRuntimeContract(SYNTH).forbiddenAmbientEnv.includes("SUPABASE_URL"));
});

test("PROD_SHADOW rejects foreign DEV ambient bindings; DEV (default) stays unrestricted", () => {
  const shadowOwn = { SHADOW_EXECUTOR_CANDIDATES_SECRET: "s", SHADOW_SUPABASE_URL: "u", SHADOW_SUPABASE_SERVICE_ROLE_KEY: "k" };
  assert.throws(() => validateContourRuntime(getContour("PROD_SHADOW"), { ...shadowOwn, SUPABASE_SERVICE_ROLE_KEY: "dev" }), /AMBIENT_FOREIGN_BINDING_PRESENT/);
  assert.doesNotThrow(() => validateContourRuntime(getContour("DEV_LIVE"), { SUPABASE_URL: "x", SHADOW_SUPABASE_URL: "ambient-is-fine-for-default" }));
  assert.deepEqual(describeRuntimeContract(getContour("DEV_LIVE")).forbiddenAmbientEnv, []);
});
