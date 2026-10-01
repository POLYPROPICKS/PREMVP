// Behavior-parity + composition tests for Constructor V1 / CURRENT DEV_LIVE:
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONSTRUCTOR_COMPOSE_INVALID,
  composeContour,
  computeManifestDigest,
  type ContourDeclarationV1,
} from "../../lib/constructor/contracts";
import {
  DEV_LIVE_COMPONENT_MANIFEST,
  DEV_LIVE_INSTANCE,
  DEV_LIVE_PROFILE,
  getActiveContour,
} from "../../lib/constructor/devLive";
import { parseReservationTimesMinsk } from "../../lib/executor/nightWindow";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const DEV_LIVE: ContourDeclarationV1 = {
  profile: DEV_LIVE_PROFILE,
  instance: DEV_LIVE_INSTANCE,
  manifest: DEV_LIVE_COMPONENT_MANIFEST,
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const composeError = (d: ContourDeclarationV1) => {
  try {
    composeContour(d);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

// ── 1. CURRENT DEV resolves, deterministically ───────────────────────────────

test("CURRENT DEV_LIVE composes and the active contour is that composition", () => {
  const c = getActiveContour();
  assert.equal(c.profile.contourId, "DEV_LIVE");
  assert.equal(c.instance.instanceId, "DEV_LIVE_PRIMARY");
  assert.equal(c, getActiveContour(), "composed once per process");
  assert.match(c.identity, /^DEV_LIVE\/DEV_LIVE_PRIMARY@[0-9a-f]{12}$/);
});

test("manifest digest is deterministic and pinned (a composition change must be deliberate)", () => {
  const a = composeContour(DEV_LIVE).manifestDigest;
  const b = composeContour(clone(DEV_LIVE)).manifestDigest;
  assert.equal(a, b);
  assert.equal(a, computeManifestDigest(DEV_LIVE_COMPONENT_MANIFEST));
  assert.equal(a, "775f23a09f0ebf2c83821b4e4b25ad3177b20b65b445a78bea0241597ffc4663");
});

// ── 2. OLD DEV intent == NEW Constructor-composed DEV intent ─────────────────

test("selector policy equals the literals previously hard-coded in the active DEV path", () => {
  const { selectors } = getActiveContour().profile;
  assert.equal(selectors.planning, "CONTRACT_A_PLANNING_V1");
  assert.equal(selectors.final, "CONTRACT_A_V1");
});

test("anchor-schedule binding resolves to the same env key the cron read before", () => {
  const c = getActiveContour();
  const env = { RESERVATION_TIMES_MINSK: "10:00,17:00" };
  assert.equal(c.resolveEnv("reservationTimesMinsk", env), env.RESERVATION_TIMES_MINSK);
  assert.deepEqual(
    parseReservationTimesMinsk(c.resolveEnv("reservationTimesMinsk", env)),
    parseReservationTimesMinsk(env.RESERVATION_TIMES_MINSK),
  );
  // unset binding keeps the historical 17:00 default
  assert.deepEqual(parseReservationTimesMinsk(c.resolveEnv("reservationTimesMinsk", {})), [
    { hour: 17, minute: 0, hhmm: "1700" },
  ]);
});

// ── 3. Manifest is real: it names code that exists, at the pinned versions ───

test("every manifest component points at an existing module and exported symbol", () => {
  for (const comp of DEV_LIVE_COMPONENT_MANIFEST.components) {
    assert.ok(existsSync(join(ROOT, comp.module)), `${comp.id}: missing module ${comp.module}`);
    if (comp.symbol) {
      const re = new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${comp.symbol}\\b`);
      assert.match(read(comp.module), re, `${comp.id}: ${comp.symbol} not exported from ${comp.module}`);
    }
  }
});

test("pinned selector/decision versions exist in the shared engine source", () => {
  const fire = read("lib/executor/buildFireModelCandidates.ts");
  for (const mode of [DEV_LIVE_PROFILE.selectors.planning, DEV_LIVE_PROFILE.selectors.final]) {
    assert.ok(fire.includes(`"${mode}"`), `selector mode ${mode} not known to the engine`);
  }
  const decisionVersion = DEV_LIVE_COMPONENT_MANIFEST.components.find((c) => c.id === "policy.contractA")!;
  assert.ok(read(decisionVersion.module).includes(`"${decisionVersion.contractVersion}"`));
});

// ── 4. The migrated active path consumes the contour, not literals ───────────

test("migrated active-path call sites no longer hard-code the selector mode", () => {
  const sites = [
    "app/api/cron/night-event-reservations/route.ts",
    "app/api/cron/night-plan-email/route.ts",
    "app/api/executor/candidates/route.ts",
    "app/api/executor/night-plan/route.ts",
  ];
  for (const rel of sites) {
    const src = read(rel);
    assert.ok(src.includes("getActiveContour"), `${rel} must consume the composed contour`);
    assert.ok(!/["']CONTRACT_A_PLANNING_V1["']/.test(src.replace(/\/\/.*$/gm, "")), `${rel} still hard-codes the selector`);
  }
  const queue = read("lib/executor/eventExecutionQueue.ts");
  assert.ok(queue.includes("deps.contour ?? getActiveContour()"));
  assert.ok(!/buildFireModelCandidates\(PLAN_POOL, "all", true, undefined, "CONTRACT_A_(PLANNING_)?V1"?\)/.test(queue));
  assert.ok(!queue.includes('undefined, "CONTRACT_A_V1")'));
  assert.ok(!queue.includes('undefined, "CONTRACT_A_PLANNING_V1")'));
});

// ── 5. Repeat instantiation: the engine no longer assumes one fixed identity ─

test("a second instance of the same profile+manifest composes with its own identity and bindings", () => {
  const fixture = clone(DEV_LIVE);
  (fixture.instance as { instanceId: string }).instanceId = "DEV_LIVE_TEST_FIXTURE";
  (fixture.instance as { envBindings: object }).envBindings = {
    ...fixture.instance.envBindings,
    reservationTimesMinsk: "FIXTURE_RESERVATION_TIMES",
  };
  const second = composeContour(fixture);
  assert.notEqual(second.identity, getActiveContour().identity);
  assert.equal(second.manifestDigest, getActiveContour().manifestDigest);
  assert.equal(second.resolveEnv("reservationTimesMinsk", { FIXTURE_RESERVATION_TIMES: "09:30" }), "09:30");
  assert.equal(second.resolveEnv("reservationTimesMinsk", { RESERVATION_TIMES_MINSK: "09:30" }), undefined);
});

// ── 6. Composition fails closed ──────────────────────────────────────────────

test("composition rejects inconsistent declarations", () => {
  const cases: Array<[string, (d: ContourDeclarationV1) => void]> = [
    ["INSTANCE_PROFILE_MISMATCH", (d) => ((d.instance.profileRef as { contourId: string }).contourId = "OTHER")],
    ["INSTANCE_MANIFEST_MISMATCH", (d) => ((d.instance.manifestRef as { version: string }).version = "9.9.9")],
    ["MANIFEST_PROFILE_MISMATCH", (d) => ((d.manifest as { contourId: string }).contourId = "OTHER")],
    ["REQUIRED_COMPONENT_MISSING:queue.api", (d) => ((d.manifest as unknown as { components: unknown[] }).components = d.manifest.components.filter((c) => c.id !== "queue.api"))],
    ["COMPONENT_DUPLICATE:selector.planning", (d) => ((d.manifest as unknown as { components: unknown[] }).components = [...d.manifest.components, d.manifest.components[0]])],
    ["ENV_BINDING_MISSING:supabaseUrl", (d) => {
      const { supabaseUrl: _omit, ...rest } = d.instance.envBindings;
      void _omit;
      (d.instance as { envBindings: object }).envBindings = rest;
    }],
    ["SELECTOR_PLANNING_NOT_PINNED_BY_MANIFEST", (d) => ((d.profile.selectors as { planning: string }).planning = "CONTRACT_A_V1")],
    ["ENV_BINDING_NOT_AN_ENV_NAME:reservationTimesMinsk", (d) => ((d.instance.envBindings as { reservationTimesMinsk: string }).reservationTimesMinsk = "not an env name")],
  ];
  for (const [code, mutate] of cases) {
    const d = clone(DEV_LIVE);
    mutate(d);
    assert.equal(composeError(d), `${CONSTRUCTOR_COMPOSE_INVALID}: ${code}`);
  }
});

test("composed contour is immutable", () => {
  const c = getActiveContour();
  assert.throws(() => {
    (c.profile.selectors as { planning: string }).planning = "CONTUR3_CURRENT";
  }, TypeError);
  assert.equal(c.profile.selectors.planning, "CONTRACT_A_PLANNING_V1");
});

// ── 7. No secret values in the declaration ───────────────────────────────────

test("declaration carries env-var names only, never values", () => {
  for (const name of Object.values(DEV_LIVE_INSTANCE.envBindings)) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
  const blob = JSON.stringify(DEV_LIVE);
  assert.ok(!/bearer |eyJ|sk_live|https?:\/\//i.test(blob), "no token/url-looking values in the declaration");
});
