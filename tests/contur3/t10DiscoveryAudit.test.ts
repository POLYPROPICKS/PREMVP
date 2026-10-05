// T10_DISCOVERY_AUDIT_AND_TOTAL_CORNERS_PROOF_V1 — pre-filter same-game discovery audit.
//   node --import tsx --test tests/contur3/t10DiscoveryAudit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVERY_AUDIT_MAX_MARKET_TYPES, DISCOVERY_AUDIT_OVERFLOW, DISCOVERY_AUDIT_VERSION,
  FINAL_REBALANCE_PHASE, buildDiscoveryAudit, captureReservationMarketMilestones,
  captureReservationMarketObservation, classifyReservationMarketPhase, type DiscoveryAuditV1,
} from "../../lib/executor/reservationMarketBaseline";
import {
  FIXTURE_GAME_ID, FIXTURE_START_ISO, captureFixture, fixtureBooks, fixtureReservation, market,
  ownEventMarkets, siblingEventMarkets, type FixtureMarket,
} from "./helpers/t10SameGameFixture";

const audit = (run: Record<string, unknown>) => run.discovery_audit_v1 as DiscoveryAuditV1;
const reasons = (a: DiscoveryAuditV1, key: string) => a.market_types[key].exclusion_reason_counts;

test("A: exact full-match total_corners is classified TOTAL_CORNERS/TOTAL_CORNERS and admitted with identity unchanged", async () => {
  const { run, rows } = await captureFixture("T_MINUS_10");
  const entry = audit(run).market_types.total_corners;
  assert.equal(entry.canonical_market_family, "TOTAL_CORNERS");
  assert.equal(entry.canonical_market_type, "TOTAL_CORNERS");
  assert.equal(entry.raw_discovered_n, 1);
  assert.equal(entry.same_game_n, 1);
  assert.equal(entry.same_start_n, 1);
  assert.equal(entry.identity_valid_n, 1);
  assert.equal(entry.admitted_n, 1);
  assert.equal(entry.excluded_n, 0);
  assert.deepEqual(entry.exclusion_reason_counts, {});
  const corners = rows.filter((r) => r.provider_market_type_raw === "total_corners");
  assert.deepEqual(corners.map((r) => [r.condition_id, r.token_id, r.side]).sort(),
    [["c-tc", "t-tc-no", "Under"], ["c-tc", "t-tc-yes", "Over"]]);
  for (const r of corners) {
    assert.equal(r.canonical_market_family, "TOTAL_CORNERS");
    assert.equal(r.canonical_market_type, "TOTAL_CORNERS");
  }
});

for (const [label, key, reason] of [
  ["B: team total corners", "soccer_team_total_corners", "CORNER_DERIVATIVE_TEAM"],
  ["C: first-half corners", "soccer_first_half_total_corners", "CORNER_DERIVATIVE_FIRST_HALF"],
  ["D: second-half corners", "soccer_second_half_total_corners", "CORNER_DERIVATIVE_SECOND_HALF"],
  ["E: corners odd/even", "soccer_game_corners_odd_even", "CORNER_DERIVATIVE_ODD_EVEN"],
  ["F: first corner (first/last)", "soccer_first_corner", "CORNER_DERIVATIVE_FIRST_LAST"],
  ["G: exact score", "soccer_exact_score", "UNSUPPORTED_STRUCTURED_MARKET_TYPE"],
  ["H: halftime", "soccer_halftime_result", "UNSUPPORTED_STRUCTURED_MARKET_TYPE"],
] as const) {
  test(`${label} is seen, excluded with ${reason}, counted, and never reaches the live universe`, async () => {
    const { run, rows } = await captureFixture("T_MINUS_10");
    const entry = audit(run).market_types[key];
    assert.ok(entry, "market type was seen pre-filter");
    assert.equal(entry.raw_discovered_n, 1);
    assert.equal(entry.admitted_n, 0);
    assert.equal(entry.excluded_n, 1);
    assert.deepEqual(entry.exclusion_reason_counts, { [reason]: 1 });
    assert.equal(rows.some((r) => r.provider_market_type_raw === key), false);
  });
}

test("a raw total_corners demoted by a derivative slug is excluded and named, not silently dropped", () => {
  const sibling = market("124", 2, "total_corners", "epl-ars-che-2026-07-19-first-half-total-corners", "c-x", ["a", "b"], ["Over", "Under"]);
  const exact = market("124", 2, "total_corners", "epl-ars-che-2026-07-19-total-corners-9pt5", "c-y", ["c", "d"], ["Over", "Under"]);
  const a = buildDiscoveryAudit(FIXTURE_GAME_ID, Date.parse(FIXTURE_START_ISO), [sibling, exact]);
  assert.equal(a.market_types.total_corners.admitted_n, 1);
  assert.deepEqual(reasons(a, "total_corners"), { CORNER_DERIVATIVE_FIRST_HALF: 1 });
});

test("I/J/K/L/M: other gameId, other start, invalid event id, missing structured type and missing identity are excluded and counted", async () => {
  const discovered: FixtureMarket[] = [
    ...siblingEventMarkets(),
    market("130", 1, "moneyline", "other-game", "c-og", ["og1", "og2"], ["Home", "Away"], { provider_game_id: "888" }),
    market("131", 1, "moneyline", "other-start", "c-os", ["os1", "os2"], ["Home", "Away"], { event_start_iso: "2026-07-20T19:00:00.000Z" }),
    market("not-numeric", 1, "moneyline", "bad-event", "c-be", ["be1", "be2"], ["Home", "Away"]),
    market("132", 3, null, "no-type", "c-nt", ["nt1", "nt2"], ["Yes", "No"]),
    market("132", 3, "totals", "no-condition", null, ["nc1", "nc2"], ["Over", "Under"]),
    market("132", 3, "spreads", "no-outcome", "c-no", ["no1", "no2"], ["Home", ""]),
  ];
  const { run } = await captureFixture("T_MINUS_10", { discovered });
  const a = audit(run);
  assert.deepEqual(reasons(a, "moneyline"), { OTHER_GAME_ID: 1, OTHER_EVENT_START: 1, PROVIDER_EVENT_ID_INVALID: 1 });
  assert.equal(a.market_types.moneyline.admitted_n, 1);
  assert.equal(a.market_types.moneyline.raw_discovered_n, 4);
  assert.equal(a.market_types.moneyline.same_game_n, 3, "other-game market is not same-game");
  assert.equal(a.market_types.moneyline.same_start_n, 3, "other-start market is not same-start");
  assert.deepEqual(reasons(a, "__missing__"), { STRUCTURED_MARKET_TYPE_MISSING: 1 });
  assert.deepEqual(reasons(a, "totals"), { MARKET_TOKEN_IDENTITY_MISSING: 1 });
  assert.deepEqual(reasons(a, "spreads"), { MARKET_TOKEN_IDENTITY_MISSING: 1 });
  assert.equal(a.market_types.totals.identity_valid_n, 1);
  // Identity-missing markets still flow through the legacy path: the run stays incomplete (fail closed).
  assert.equal(run.capture_complete, false);
  assert.equal(run.failure_reason, "MARKET_TOKEN_IDENTITY_MISSING");
});

test("N: raw = admitted + excluded for the whole audit and for every market type; events counted", async () => {
  const discovered: FixtureMarket[] = [
    ...siblingEventMarkets(),
    market("130", 1, "moneyline", "other-game", "c-og", ["og1", "og2"], ["Home", "Away"], { provider_game_id: "888" }),
    market("132", 1, null, "no-type", "c-nt", ["nt1", "nt2"], ["Yes", "No"]),
  ];
  const { run } = await captureFixture("T_MINUS_30", { discovered });
  const a = audit(run);
  assert.equal(a.raw_markets_discovered_n, ownEventMarkets().length + discovered.length);
  assert.equal(a.raw_markets_discovered_n, a.admitted_markets_n + a.excluded_markets_n);
  assert.equal(a.provider_events_discovered_n, 5);
  let raw = 0;
  for (const entry of Object.values(a.market_types)) {
    assert.equal(entry.raw_discovered_n, entry.admitted_n + entry.excluded_n);
    assert.equal(entry.excluded_n, Object.values(entry.exclusion_reason_counts).reduce((s, n) => s + (n ?? 0), 0));
    raw += entry.raw_discovered_n;
  }
  assert.equal(raw, a.raw_markets_discovered_n);
  assert.equal(a.provider_game_id, FIXTURE_GAME_ID);
  assert.equal(a.version, DISCOVERY_AUDIT_VERSION);
});

test("acceptance fixture: every market is seen pre-filter; the canonical universe is exactly MONEYLINE/SPREADS/TOTALS/TOTAL_CORNERS", async () => {
  const { run, rows } = await captureFixture("T_MINUS_10");
  const a = audit(run);
  assert.deepEqual(Object.keys(a.market_types).sort(), [
    "moneyline", "soccer_exact_score", "soccer_first_corner", "soccer_first_half_total_corners",
    "soccer_game_corners_odd_even", "soccer_halftime_result", "soccer_second_half_total_corners",
    "soccer_team_total_corners", "spreads", "total_corners", "totals"]);
  assert.equal(a.raw_markets_discovered_n, 11);
  assert.equal(a.admitted_markets_n, 4);
  assert.equal(a.excluded_markets_n, 7);
  assert.deepEqual([...new Set(rows.map((r) => r.canonical_market_family))].sort(), ["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
  assert.equal(run.markets_discovered_n, 4, "legacy universe unchanged by the audit");
  assert.equal(run.capture_complete, true);
  assert.equal(run.failure_reason, null);
});

test("O/P: both T_MINUS_30 and T_MINUS_10 persist the identical bounded audit on the capture run", async () => {
  const t30 = await captureFixture("T_MINUS_30");
  const t10 = await captureFixture("T_MINUS_10");
  assert.equal(t30.run.observation_phase, "T_MINUS_30");
  assert.equal(t10.run.observation_phase, "T_MINUS_10");
  assert.ok(audit(t30.run) && audit(t10.run));
  assert.deepEqual(audit(t30.run), audit(t10.run));
});

test("audit is bounded compact counts: no slugs, condition ids, token ids or payloads are persisted", async () => {
  const { run } = await captureFixture("T_MINUS_10");
  const json = JSON.stringify(audit(run));
  for (const forbidden of ["epl-ars", "c-tc", "t-tc-yes", "c-ml", "slug", "clob", "outcomes", "orderbook", "bids", "asks"]) {
    assert.equal(json.includes(forbidden), false, `must not persist ${forbidden}`);
  }
  assert.ok(json.length < 4_000);
});

test("audit overflow (>64 distinct market types) fails the capture closed with a typed condition, never truncating", async () => {
  const wide: FixtureMarket[] = Array.from({ length: DISCOVERY_AUDIT_MAX_MARKET_TYPES + 1 }, (_, i) =>
    market("124", DISCOVERY_AUDIT_MAX_MARKET_TYPES + 1, `soccer_prop_${i}`, `prop-${i}`, `c-p${i}`, [`p${i}a`, `p${i}b`], ["Yes", "No"]));
  const { run, rows } = await captureFixture("T_MINUS_10", { discovered: wide });
  const a = audit(run);
  assert.equal(a.audit_overflow, true);
  assert.equal(a.distinct_market_types_n, DISCOVERY_AUDIT_MAX_MARKET_TYPES + 1 + 4, "65 provider props + the 4 own-event types");
  assert.deepEqual(a.market_types, {});
  assert.equal(run.failure_reason, DISCOVERY_AUDIT_OVERFLOW);
  assert.equal(run.capture_status, "CAPTURE_FAILED");
  assert.equal(rows.length, 0);
});

test("the default gameId reader hands the RAW bounded set to the audit (other game/start/id are seen, never dropped silently)", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const tc = (slug: string, type: string, cond: string) => ({ conditionId: cond, clobTokenIds: `["${cond}-a","${cond}-b"]`, outcomes: '["Over","Under"]', sportsMarketType: type, slug });
  const own = { id: "123", gameId: "999", endDate: FIXTURE_START_ISO, markets: [
    { conditionId: "c-ml", clobTokenIds: '["m1","m2"]', outcomes: '["Home","Away"]', sportsMarketType: "moneyline", slug: "ml" }] };
  const events = [own,
    { id: "124", gameId: "999", endDate: FIXTURE_START_ISO, markets: [tc("total-corners-9pt5", "total_corners", "c-tc"), tc("team-total-corners", "soccer_team_total_corners", "c-team")] },
    { id: "130", gameId: "888", endDate: FIXTURE_START_ISO, markets: [tc("x", "moneyline", "c-og")] },
    { id: "131", gameId: "999", endDate: "2026-07-21T19:00:00.000Z", markets: [tc("y", "moneyline", "c-os")] },
    { id: "abc", gameId: "999", endDate: FIXTURE_START_ISO, markets: [tc("z", "moneyline", "c-bad")] }];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(String(input).includes("game_id=") ? events : own), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    let run: Record<string, unknown> = {};
    await captureReservationMarketObservation(fixtureReservation(), "T_MINUS_10", {
      observedAt: "2026-07-19T18:50:00.000Z", alreadyCaptured: async () => false, fetchBooks: fixtureBooks({}),
      // Telemetry reads are injected so the URL list below stays the pure discovery contract.
      fetchFeeSchedule: async (tokenId) => ({ ok: false, tokenId, errorCode: "FEE_TEST_OFFLINE", latencyMs: 0 }),
      write: async (r) => { run = r; },
    });
    assert.equal(urls.length, 2, "one exact-event read and ONE bounded same-game query");
    const a = audit(run);
    assert.equal(a.raw_markets_discovered_n, 6);
    assert.equal(a.provider_events_discovered_n, 5);
    assert.deepEqual(reasons(a, "moneyline"), { OTHER_GAME_ID: 1, OTHER_EVENT_START: 1, PROVIDER_EVENT_ID_INVALID: 1 });
    assert.equal(a.market_types.total_corners.admitted_n, 1);
    assert.deepEqual(reasons(a, "soccer_team_total_corners"), { CORNER_DERIVATIVE_TEAM: 1 });
    assert.equal(run.markets_discovered_n, 2, "only the own moneyline and the exact corners market are in the live universe");
  } finally { globalThis.fetch = originalFetch; }
});

test("Q: T_MINUS_3 live capture stays disabled; T10 is the only Final Rebalance source", async () => {
  assert.equal(FINAL_REBALANCE_PHASE, "T_MINUS_10");
  const phases = new Set<string>();
  const reservation = fixtureReservation();
  for (let minute = 31; minute >= 0; minute -= 0.5) {
    const now = Date.parse(FIXTURE_START_ISO) - minute * 60_000;
    const seen = classifyReservationMarketPhase(FIXTURE_START_ISO, now);
    if (seen) phases.add(seen);
    await captureReservationMarketMilestones(now, { load: async () => [reservation], capture: async (_r, phase) => { phases.add(phase); } });
  }
  assert.deepEqual([...phases].sort(), ["T_MINUS_10", "T_MINUS_30"]);
});
