// PROD_SHADOW runtime contract: fail-closed startup validation, no DEV binding fallback, and a real
// process-level boot proof. Dummy values only; no network, no DB, no secrets.
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTOUR_REGISTRY, getContour } from "../../lib/constructor/registry";
import {
  CONSTRUCTOR_RUNTIME_INVALID,
  OPTIONAL_RUNTIME_BINDINGS,
  REQUIRED_RUNTIME_BINDINGS,
  describeRuntimeContract,
  validateContourRuntime,
} from "../../lib/constructor/runtimeContract";

const ROOT = join(__dirname, "..", "..");
const SHADOW_OK = {
  SHADOW_SUPABASE_URL: "http://shadow.invalid",
  SHADOW_SUPABASE_SERVICE_ROLE_KEY: "shadow-key-placeholder",
  SHADOW_EXECUTOR_CANDIDATES_SECRET: "shadow-secret-placeholder",
};
const DEV_ENV = {
  SUPABASE_URL: "http://dev.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "dev-key-placeholder",
  EXECUTOR_CANDIDATES_SECRET: "dev-secret-placeholder",
  RESERVATION_TIMES_MINSK: "10:00,17:00",
};
const shadow = () => getContour("PROD_SHADOW");
const dev = () => getContour("DEV_LIVE");
const runtimeError = (reason: string) => new RegExp(`${CONSTRUCTOR_RUNTIME_INVALID}: ${reason}`);

// ── In-process validation ────────────────────────────────────────────────────

test("shadow with exactly its own required bindings validates; the schedule binding is optional by design", () => {
  assert.doesNotThrow(() => validateContourRuntime(shadow(), SHADOW_OK));
  assert.doesNotThrow(() => validateContourRuntime(shadow(), { ...SHADOW_OK, SHADOW_RESERVATION_TIMES_MINSK: "09:00" }));
  assert.deepEqual([...OPTIONAL_RUNTIME_BINDINGS], ["reservationTimesMinsk"]);
});

test("every missing required shadow binding fails closed, naming the SHADOW_* variable", () => {
  for (const key of REQUIRED_RUNTIME_BINDINGS) {
    const name = shadow().instance.envBindings[key];
    assert.match(name, /^SHADOW_/);
    for (const broken of [undefined, "", "   "]) {
      const env: Record<string, string | undefined> = { ...SHADOW_OK, [name]: broken };
      assert.throws(() => validateContourRuntime(shadow(), env), runtimeError(`MISSING_REQUIRED_BINDINGS:.*${name}`));
    }
  }
  assert.throws(() => validateContourRuntime(shadow(), {}), runtimeError("MISSING_REQUIRED_BINDINGS"));
});

test("shadow never falls back to DEV names: DEV-only env cannot satisfy it, and DEV names present are refused", () => {
  // Only DEV names present: shadow's own are missing AND the foreign names are present -> refused.
  assert.throws(() => validateContourRuntime(shadow(), DEV_ENV), runtimeError("AMBIENT_FOREIGN_BINDING_PRESENT"));
  // Complete shadow env plus ANY single DEV binding -> refused (direct SUPABASE_URL readers must never see DEV).
  for (const name of Object.values(dev().instance.envBindings)) {
    assert.throws(
      () => validateContourRuntime(shadow(), { ...SHADOW_OK, [name]: "x" }),
      runtimeError(`AMBIENT_FOREIGN_BINDING_PRESENT:${name}`),
      name,
    );
  }
  // And the factory path itself reads only the shadow names.
  assert.equal(shadow().resolveEnv("supabaseUrl", DEV_ENV), undefined);
  assert.throws(() => shadow().requireEnv("supabaseServiceRoleKey", DEV_ENV), /SHADOW_SUPABASE_SERVICE_ROLE_KEY/);
});

test("DEV startup semantics are unchanged: validation is a no-op for the money-enabled contour", () => {
  assert.doesNotThrow(() => validateContourRuntime(dev(), {}));
  assert.doesNotThrow(() => validateContourRuntime(dev(), DEV_ENV));
  assert.doesNotThrow(() => validateContourRuntime(dev(), { ...DEV_ENV, ...SHADOW_OK }), "DEV never inspects shadow names");
});

test("binding names are pairwise disjoint across the registry (a structural no-fallback guarantee)", () => {
  const seen = new Map<string, string>();
  for (const d of Object.values(CONTOUR_REGISTRY)) {
    for (const name of Object.values(d.instance.envBindings)) {
      assert.equal(seen.get(name), undefined, `${name} shared by ${seen.get(name)} and ${d.profile.contourId}`);
      seen.set(name, d.profile.contourId);
    }
  }
});

test("runtime contract states selector, identity, manifest, capability, bindings and expected behavior (names only)", () => {
  const c = describeRuntimeContract(shadow());
  assert.equal(c.selector.envVar, "CONSTRUCTOR_ACTIVE_CONTOUR");
  assert.equal(c.selector.value, "PROD_SHADOW");
  assert.equal(c.instanceId, "PROD_SHADOW_PASSIVE");
  assert.equal(c.manifest.manifestId, "premvp-prod-shadow");
  assert.equal(c.manifest.digest, shadow().manifestDigest);
  assert.equal(c.moneyMovement, "disabled");
  assert.deepEqual(c.bindings.supabaseUrl, { envVar: "SHADOW_SUPABASE_URL", required: true });
  assert.deepEqual(c.bindings.supabaseServiceRoleKey, { envVar: "SHADOW_SUPABASE_SERVICE_ROLE_KEY", required: true });
  assert.deepEqual(c.bindings.executorCandidatesSecret, { envVar: "SHADOW_EXECUTOR_CANDIDATES_SECRET", required: true });
  assert.deepEqual(c.bindings.reservationTimesMinsk, { envVar: "SHADOW_RESERVATION_TIMES_MINSK", required: false });
  assert.deepEqual([...c.forbiddenAmbientEnv].sort(), Object.values(dev().instance.envBindings).sort());
  assert.ok(c.expectedBehavior.some((l) => /CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED/.test(l)));
  assert.ok(!/https?:\/\/|eyJ|sk_live/i.test(JSON.stringify(c)), "names only");
});

// ── Process-level boot proof (real child process, clean env) ─────────────────

function boot(extraEnv: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[k]) base[k] = process.env[k]!;
  }
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/constructor/shadow-boot-check.ts"], {
    cwd: ROOT,
    env: { ...base, ...extraEnv } as NodeJS.ProcessEnv,
    encoding: "utf8" as const,
    timeout: 120_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("BOOT PROOF: explicit PROD_SHADOW + complete shadow bindings -> boots, resources resolve, money boundary blocks", () => {
  const r = boot({ CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW", ...SHADOW_OK });
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out) as { ok: boolean; contract: { contourId: string; moneyMovement: string; instanceId: string } };
  assert.equal(report.ok, true);
  assert.equal(report.contract.contourId, "PROD_SHADOW");
  assert.equal(report.contract.instanceId, "PROD_SHADOW_PASSIVE");
  assert.equal(report.contract.moneyMovement, "disabled");
  assert.ok(!r.out.includes("shadow-key-placeholder") && !r.out.includes("shadow-secret-placeholder"), "no secret values printed");
});

test("BOOT PROOF: missing selector is refused (a shadow service can never silently become DEV)", () => {
  const r = boot({ ...SHADOW_OK });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /SHADOW_BOOT_REFUSED/);
});

test("BOOT PROOF: malformed or DEV selector is refused", () => {
  for (const sel of ["prod_shadow", "PROD_SHADOW ", "", "DEV_LIVE", "NOPE"]) {
    const r = boot({ CONSTRUCTOR_ACTIVE_CONTOUR: sel, ...SHADOW_OK });
    assert.notEqual(r.code, 0, `selector ${JSON.stringify(sel)}`);
    assert.match(r.err, /CONSTRUCTOR_CONTOUR_UNKNOWN|SHADOW_BOOT_REFUSED/);
  }
});

test("BOOT PROOF: missing shadow bindings fail clearly, and DEV bindings cannot substitute", () => {
  const missing = boot({ CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW" });
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /MISSING_REQUIRED_BINDINGS:.*SHADOW_SUPABASE_URL/);

  const devOnly = boot({ CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW", ...DEV_ENV });
  assert.notEqual(devOnly.code, 0);
  assert.match(devOnly.err, /AMBIENT_FOREIGN_BINDING_PRESENT/);

  const mixed = boot({ CONSTRUCTOR_ACTIVE_CONTOUR: "PROD_SHADOW", ...SHADOW_OK, SUPABASE_URL: "http://dev.invalid" });
  assert.notEqual(mixed.code, 0);
  assert.match(mixed.err, /AMBIENT_FOREIGN_BINDING_PRESENT:SUPABASE_URL/);
});

// ── Deployment template ──────────────────────────────────────────────────────

test("Railway template pins the selector in the start command, runs the boot check first, and holds no values", () => {
  const toml = readFileSync(join(ROOT, "ops/railway/prod-shadow-web.toml"), "utf8");
  const start = /startCommand = "(.*)"/.exec(toml)?.[1] ?? "";
  assert.match(start, /export CONSTRUCTOR_ACTIVE_CONTOUR=PROD_SHADOW/);
  assert.ok(start.indexOf("shadow:boot-check") > start.indexOf("CONSTRUCTOR_ACTIVE_CONTOUR=PROD_SHADOW"));
  assert.ok(start.indexOf("npm start") > start.indexOf("shadow:boot-check"), "boot check gates the server start");
  for (const name of Object.values(shadow().instance.envBindings)) assert.ok(toml.includes(name), name);
  assert.ok(!/eyJ|sk_live|https?:\/\/[a-z0-9-]+\.supabase\.co/i.test(toml));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["shadow:boot-check"], "tsx scripts/constructor/shadow-boot-check.ts");
});
