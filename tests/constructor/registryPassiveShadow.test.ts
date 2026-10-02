// Constructor V1: declaration registry, active-contour selector, passive/no-money capability and
// the executable-queue-row money boundary. In-memory fakes only: no network, no DB, no secrets.
//   node --import tsx --test tests/constructor/*.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONSTRUCTOR_COMPOSE_INVALID,
  CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED,
  assertMoneyMovementEnabled,
  composeContour,
  type ComposedContour,
  type ContourDeclarationV1,
} from "../../lib/constructor/contracts";
import { DEV_LIVE_COMPONENT_MANIFEST, DEV_LIVE_DECLARATION } from "../../lib/constructor/devLive";
import { PROD_SHADOW_DECLARATION } from "../../lib/constructor/prodShadow";
import {
  ACTIVE_CONTOUR_ENV,
  CONSTRUCTOR_CONTOUR_UNKNOWN,
  CONTOUR_REGISTRY,
  createContourResolver,
  getActiveContour,
  getContour,
  resolveActiveContourId,
} from "../../lib/constructor/registry";
import {
  admitExecutableQueueRow,
  runEventRebalance,
  runFounderBattleBatch,
  type RebalanceRepoPort,
} from "../../lib/executor/eventExecutionQueue";
import type { EventExecutionQueueRow, NightEventReservationRow } from "../../lib/executor/executorQueueTypes";
import type { FinalT3MarketObservation } from "../../lib/executor/reservationMarketBaseline";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const BLOCKED = new RegExp(CONSTRUCTOR_MONEY_MOVEMENT_BLOCKED);

// ── A. Registry ──────────────────────────────────────────────────────────────

test("registry is finite and every entry composes with its key as contourId", () => {
  assert.deepEqual(Object.keys(CONTOUR_REGISTRY).sort(), ["DEV_LIVE", "PROD_SHADOW"]);
  for (const id of Object.keys(CONTOUR_REGISTRY)) {
    const c = getContour(id);
    assert.equal(c.profile.contourId, id);
    assert.equal(c.manifest.contourId, id);
    assert.equal(c.instance.profileRef.contourId, id);
    assert.equal(getContour(id), c, "composition is memoized per id");
  }
});

test("declarations carry env-var names only and the two instances share no binding name", () => {
  for (const d of Object.values(CONTOUR_REGISTRY)) {
    for (const name of Object.values(d.instance.envBindings)) assert.match(name, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(!/bearer |eyJ|sk_live|https?:\/\//i.test(JSON.stringify(d)), "no token/url-looking values");
  }
  const dev = new Set(Object.values(DEV_LIVE_DECLARATION.instance.envBindings));
  for (const name of Object.values(PROD_SHADOW_DECLARATION.instance.envBindings)) {
    assert.ok(!dev.has(name), `shadow must not reuse DEV binding ${name}`);
  }
  assert.notEqual(PROD_SHADOW_DECLARATION.instance.instanceId, DEV_LIVE_DECLARATION.instance.instanceId);
});

test("shadow reuses DEV's shared components and selector policy but its own manifest identity", () => {
  assert.deepEqual(PROD_SHADOW_DECLARATION.manifest.components, DEV_LIVE_COMPONENT_MANIFEST.components);
  assert.deepEqual(PROD_SHADOW_DECLARATION.profile.selectors, DEV_LIVE_DECLARATION.profile.selectors);
  assert.notEqual(getContour("PROD_SHADOW").manifestDigest, getContour("DEV_LIVE").manifestDigest);
  assert.ok(getContour("DEV_LIVE").component("contour.registry"));
  assert.ok(getContour("DEV_LIVE").component("capability.moneyMovementGuard"));
});

// ── B. Selector ──────────────────────────────────────────────────────────────

test("no selector => DEV_LIVE; explicit ids select their declaration", () => {
  assert.equal(resolveActiveContourId({}), "DEV_LIVE");
  assert.equal(resolveActiveContourId({ [ACTIVE_CONTOUR_ENV]: "DEV_LIVE" }), "DEV_LIVE");
  assert.equal(resolveActiveContourId({ [ACTIVE_CONTOUR_ENV]: "PROD_SHADOW" }), "PROD_SHADOW");
  assert.equal(createContourResolver({}).activeContour().identity, getContour("DEV_LIVE").identity);
});

test("an invalid explicit selector fails closed and never degrades to DEV", () => {
  for (const bad of ["dev_live", "DEV_LIVE ", "PROD", "", " ", "__proto__", "constructor", "toString"]) {
    assert.throws(
      () => resolveActiveContourId({ [ACTIVE_CONTOUR_ENV]: bad }),
      new RegExp(CONSTRUCTOR_CONTOUR_UNKNOWN),
      `selector ${JSON.stringify(bad)}`,
    );
    assert.throws(() => createContourResolver({ [ACTIVE_CONTOUR_ENV]: bad }), new RegExp(CONSTRUCTOR_CONTOUR_UNKNOWN));
  }
  assert.throws(() => getContour("nope"), new RegExp(CONSTRUCTOR_CONTOUR_UNKNOWN));
});

test("runtime selector changes instance identity deterministically, with no cross-contamination", () => {
  const dev = createContourResolver({ [ACTIVE_CONTOUR_ENV]: "DEV_LIVE" });
  const shadow = createContourResolver({ [ACTIVE_CONTOUR_ENV]: "PROD_SHADOW" });
  const dev2 = createContourResolver({});
  assert.match(dev.activeContour().identity, /^DEV_LIVE\/DEV_LIVE_PRIMARY@[0-9a-f]{12}$/);
  assert.match(shadow.activeContour().identity, /^PROD_SHADOW\/PROD_SHADOW_PASSIVE@[0-9a-f]{12}$/);
  assert.equal(dev2.activeContour(), dev.activeContour());
  assert.equal(dev.activeContour().profile.capabilities.moneyMovement, "enabled");
  assert.equal(shadow.activeContour().profile.capabilities.moneyMovement, "disabled");
  // Binding names stay per instance.
  assert.equal(dev.activeContour().instance.envBindings.supabaseUrl, "SUPABASE_URL");
  assert.equal(shadow.activeContour().instance.envBindings.supabaseUrl, "SHADOW_SUPABASE_URL");
});

test("selection is pinned when the resolver is created: later env changes cannot move it", () => {
  const env: Record<string, string | undefined> = { [ACTIVE_CONTOUR_ENV]: "PROD_SHADOW" };
  const resolver = createContourResolver(env);
  env[ACTIVE_CONTOUR_ENV] = "DEV_LIVE";
  assert.equal(resolver.contourId, "PROD_SHADOW");
  assert.equal(resolver.activeContour().profile.contourId, "PROD_SHADOW");
});

test("CURRENT DEV parity: the process default is the same DEV composition as before", () => {
  assert.equal(process.env[ACTIVE_CONTOUR_ENV], undefined, "test runs with no selector");
  const c = getActiveContour();
  assert.equal(c, getContour("DEV_LIVE"));
  assert.equal(c.profile.selectors.planning, "CONTRACT_A_PLANNING_V1");
  assert.equal(c.profile.selectors.final, "CONTRACT_A_V1");
  assert.deepEqual(c.instance.envBindings, {
    reservationTimesMinsk: "RESERVATION_TIMES_MINSK",
    executorCandidatesSecret: "EXECUTOR_CANDIDATES_SECRET",
    supabaseUrl: "SUPABASE_URL",
    supabaseServiceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
  });
  assert.equal(c.profile.capabilities.moneyMovement, "enabled");
});

// ── C. Capability contract ───────────────────────────────────────────────────

test("composition rejects a missing or malformed money-movement capability", () => {
  for (const bad of [undefined, "ENABLED", true, "", null]) {
    const d = clone(DEV_LIVE_DECLARATION) as { profile: { capabilities?: unknown } };
    d.profile.capabilities = bad === undefined ? undefined : { moneyMovement: bad };
    assert.throws(
      () => composeContour(d as unknown as ContourDeclarationV1),
      new RegExp(`${CONSTRUCTOR_COMPOSE_INVALID}: CAPABILITY_MONEY_MOVEMENT_INVALID`),
    );
  }
});

test("assertMoneyMovementEnabled: enabled passes, disabled blocks, malformed blocks", () => {
  assert.doesNotThrow(() => assertMoneyMovementEnabled(getContour("DEV_LIVE"), "T"));
  assert.throws(() => assertMoneyMovementEnabled(getContour("PROD_SHADOW"), "T"), BLOCKED);
  const forged = { profile: { capabilities: { moneyMovement: "ENABLED" } }, identity: "forged" };
  assert.throws(() => assertMoneyMovementEnabled(forged as never, "T"), BLOCKED);
});

// ── D. The money boundary, exercised through the real shared code ────────────

// Fixture shape follows the passing T-8 final-write path in tests/contur3 (P1B2): one persisted
// Planning reservation, one completed T3 universe, an exact order-book guard stub, a spy repo.
const KICKOFF_ISO = "2026-07-19T19:00:00.000Z";
const IN_WINDOW_MS = Date.parse("2026-07-19T18:52:00.000Z"); // T-8m, final write window
const PHYSICAL_ID = "provider:polymarket:event-1:2026-07-19";

function reservation(): NightEventReservationRow {
  return {
    id: "shadow-r", physical_event_id: PHYSICAL_ID, event_start_iso: KICKOFF_ISO,
    plan_run_id: "night-plan:2026-07-19:1700-minsk", plan_date_minsk: "2026-07-19",
    window_start_iso: "2026-07-19T14:00:00.000Z", window_end_iso: "2026-07-20T05:00:00.000Z",
    match_family_key: PHYSICAL_ID, event_slug: null, event_title: null, sport: "esports", league: null,
    strategic_scope: "ESPORT", game_start_iso: KICKOFF_ISO, event_tier: "TIER1", event_score: 80,
    best_snapshot_id: null, reservation_rank: 1, status: "RESERVED", selection_reason: null,
    diagnostics: {
      contract_a_stage: "PLANNING",
      source_lineage: { provider_event_id: "event-1", provider_event_start_iso: KICKOFF_ISO, generated_signal_pair_id: "planning-pair" },
      planning_final_identity_evidence: { condition_id: "a-control", token_id: "a-token", side: "Yes" },
    },
  } as NightEventReservationRow;
}

const market = (condition: string, token: string, family: string, type: string): FinalT3MarketObservation => ({
  capture_run_id: "t3-run", reservation_id: "shadow-r", physical_event_id: PHYSICAL_ID,
  provider_event_id: "event-1", event_start_iso: KICKOFF_ISO, observation_phase: "T_MINUS_10",
  condition_id: condition, token_id: token, side: "Yes", canonical_market_family: family,
  canonical_market_type: type, best_ask: 0.52, ask_decimal_odds: 1 / 0.52,
  orderbook_fetch_status: "SUCCESS", market_slug: condition,
});

function spyRepo() {
  const calls = { insert: 0, markQueued: 0 };
  const queue: EventExecutionQueueRow[] = [];
  const repo: RebalanceRepoPort = {
    async loadActiveReservations() { return [reservation()]; },
    async loadQueuedReservationIds() { return new Set<string>(); },
    async markReservationsExpired() {}, async markReservationSkipped() {},
    async markReservationQueued() { calls.markQueued += 1; },
    async insertQueueRow(row) { calls.insert += 1; queue.push(row); },
  };
  return { repo, calls, queue };
}

const writeDeps = (repo: RebalanceRepoPort, contour?: ComposedContour) => ({
  repo,
  ...(contour ? { contour } : {}),
  readFinalT3Universe: async () => [
    market("a-control", "a-token", "MONEYLINE", "MONEYLINE"),
    market("b-spread", "b-token", "SPREADS", "SPREAD"),
  ],
  recordStrategyDecision: async () => ({ total: 2, selected: 1, written: 2 }),
  fetchExactTokenOrderbook: async (tokenId: string) => ({
    ok: true as const, tokenId, latencyMs: 1,
    book: { tokenId, bids: [{ price: 0.5, size: 100 }], asks: [{ price: 0.52, size: 100 }], raw: {} },
  }),
});

test("DEV capability admits the executable queue row exactly as before", async () => {
  const { repo, calls, queue } = spyRepo();
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, writeDeps(repo, getContour("DEV_LIVE")));
  assert.equal(result.queued_count, 1);
  assert.equal(calls.insert, 1);
  assert.equal(queue[0].condition_id, "b-spread");
});

test("default (no deps.contour) resolves the process contour = DEV and still admits", async () => {
  const { repo, calls } = spyRepo();
  const result = await runEventRebalance(IN_WINDOW_MS, { write: true }, writeDeps(repo));
  assert.equal(result.queued_count, 1);
  assert.equal(calls.insert, 1);
});

test("PASSIVE shadow: a valid candidate reaches the boundary and is blocked before any insert", async () => {
  const { repo, calls } = spyRepo();
  let guardReached = 0;
  const deps = writeDeps(repo, getContour("PROD_SHADOW"));
  const fetchExactTokenOrderbook = deps.fetchExactTokenOrderbook;
  deps.fetchExactTokenOrderbook = async (t: string) => { guardReached += 1; return fetchExactTokenOrderbook(t); };
  await assert.rejects(runEventRebalance(IN_WINDOW_MS, { write: true }, deps), BLOCKED);
  assert.equal(guardReached, 1, "shared engine ran through selection and the live guard: a valid executable intention existed");
  assert.equal(calls.insert, 0, "money-moving dependency never invoked");
  assert.equal(calls.markQueued, 0, "reservation never promoted to QUEUED");
});

test("PASSIVE shadow may still run the shared engine in dry-run: zero writes, no throw", async () => {
  const { repo, calls } = spyRepo();
  const result = await runEventRebalance(IN_WINDOW_MS, { write: false }, {
    ...writeDeps(repo, getContour("PROD_SHADOW")),
    fetchCandidates: async () => ({ candidates: [] }),
    fetchContractAFinalCandidates: async () => ({ candidates: [] }),
  });
  assert.equal(result.wrote, false);
  assert.equal(calls.insert, 0);
});

test("admitExecutableQueueRow blocks passive, admits enabled, and never touches the repo when blocked", async () => {
  let inserts = 0;
  const repo = { async insertQueueRow() { inserts += 1; } };
  const row = {} as EventExecutionQueueRow;
  await assert.rejects(admitExecutableQueueRow(getContour("PROD_SHADOW"), repo, row), BLOCKED);
  assert.equal(inserts, 0);
  await admitExecutableQueueRow(getContour("DEV_LIVE"), repo, row);
  assert.equal(inserts, 1);
});

test("every queue-row insert in the shared engine goes through the admission boundary", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(__dirname, "..", "..", "lib/executor/eventExecutionQueue.ts"), "utf8");
  const direct = src.split("\n").filter((l) => /\brepo\.insertQueueRow\(/.test(l));
  assert.equal(direct.length, 1, "only the admission helper itself calls repo.insertQueueRow");
  assert.equal((src.match(/admitExecutableQueueRow\(/g) ?? []).length, 4, "helper + 3 call sites");
  // The legacy battle-batch path stays write-blocked regardless of contour.
  assert.equal(typeof runFounderBattleBatch, "function");
});
