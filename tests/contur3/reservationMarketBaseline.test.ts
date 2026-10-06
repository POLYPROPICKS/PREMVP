import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASELINE_SOURCE_VERSION, baselineCompleteness, inventoryTokens, stableTelemetryId, captureReservationMarketBaseline, classifyReservationMarketPhase, captureReservationMarketObservation, captureReservationMarketMilestones, strategyRowsForMarketObservations, classifyObservationalMarket, classifyExactEventMarket, liveGuardTelemetryRows, recordReservationStrategyDecision, readCompletedFinalT3Universe, selectReservationT3AbDecisions, persistReservationT3AbDecisions, type ReservationStrategyDecisionStore, type FinalT3MarketObservation } from "../../lib/executor/reservationMarketBaseline";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

test("Reservation baseline writes only a V2 reference envelope without market or book work", async () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "55555555-5555-4555-8555-555555555555", plan_run_id: "plan",
    physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: start,
    diagnostics: { source_lineage: { provider_event_id: "123", provider_event_start_iso: start } },
  } as unknown as NightEventReservationRow;
  let writes = 0;
  let run: Record<string, unknown> = {};
  await captureReservationMarketBaseline(reservation, {
    observedAt: "2026-09-30T23:30:00Z",
    readInventory: async () => { throw new Error("inventory forbidden"); },
    readExactEvent: async () => { throw new Error("provider forbidden"); },
    fetchBooks: async () => { throw new Error("books forbidden"); },
    write: async (captureRun, rows, strategies = []) => {
      writes++; run = captureRun;
      assert.equal(rows.length, 0);
      assert.equal(strategies.length, 0);
    },
  });
  assert.equal(writes, 1);
  assert.equal(run.capture_status, "REFERENCE_ONLY");
  assert.equal(run.source_version, BASELINE_SOURCE_VERSION);
  assert.equal(BASELINE_SOURCE_VERSION, "RESERVATION_REFERENCE_BASELINE_V2");
  assert.equal(run.market_tokens_observed_n, 0);
  assert.equal(run.markets_discovered_n, 0);
  assert.equal(run.orderbooks_success_n, 0);
  assert.equal(run.orderbooks_failed_n, 0);
  assert.equal(run.provider_event_id, "123");
});
test("T30, T10 and T3 each fetch the one reserved event and preserve every supplied supported token", async () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "33333333-3333-4333-8333-333333333333", plan_run_id: "plan",
    physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: start,
    diagnostics: { source_lineage: { provider_event_id: "123", provider_event_start_iso: start } },
  } as unknown as NightEventReservationRow;
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const event = { id: "123", gameId: "999", endDate: start, markets: [
      { conditionId: "money", clobTokenIds: '["m1","m2"]', outcomes: '["Home","Away"]', sportsMarketType: "moneyline", slug: "match-money" },
      { conditionId: "corners", clobTokenIds: '["c1","c2"]', outcomes: '["Yes","No"]', sportsMarketType: "total_corners", slug: "corners" },
    ] };
    const body = String(input).includes("game_id=") ? [event] : event;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const snapshots: Array<{ run: Record<string, unknown>; rows: Record<string, unknown>[]; strategies: Record<string, unknown>[] }> = [];
    for (const [phase, minutes] of [["T_MINUS_30", 30], ["T_MINUS_10", 10], ["T_MINUS_3", 8]] as const) {
      await captureReservationMarketObservation(reservation, phase, {
        observedAt: new Date(Date.parse(start) - minutes * 60_000).toISOString(),
        alreadyCaptured: async () => false,
        fetchBooks: async (ids) => ids.map((tokenId) => ({ ok: true, tokenId, latencyMs: 1,
          book: { tokenId, bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.5, size: 10 }] } })),
        // The exact Gamma URL list below is the discovery contract; telemetry reads are injected, not fetched.
        fetchFeeSchedule: async (tokenId) => ({ ok: false, tokenId, errorCode: "FEE_TEST_OFFLINE", latencyMs: 0 }),
        write: async (run, rows, strategies = []) => { snapshots.push({ run, rows, strategies }); },
      });
    }
    assert.deepEqual(urls, Array(3).fill(["https://gamma-api.polymarket.com/events/123", "https://gamma-api.polymarket.com/events?game_id=999&limit=50"]).flat(),
      "each milestone reads the exact lineage event once and ONE bounded same-game query");
    assert.equal(snapshots.length, 3);
    assert.equal(new Set(snapshots.map((s) => s.run.id)).size, 3);
    for (const snapshot of snapshots) {
      assert.equal(snapshot.rows.length, 4);
      assert.equal(snapshot.strategies.length, 12);
      assert.deepEqual(new Set(snapshot.rows.map((row) => row.provider_market_type_raw)), new Set(["moneyline", "total_corners"]));
      for (const row of snapshot.rows) assert.equal(snapshot.strategies.filter((s) => s.market_observation_id === row.id).length, 3);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("empty exact event records a typed source failure", async () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "44444444-4444-4444-8444-444444444444", plan_run_id: "plan",
    physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: start,
    diagnostics: { source_lineage: { provider_event_id: "123", provider_event_start_iso: start } },
  } as unknown as NightEventReservationRow;
  let run: Record<string, unknown> = {};
  await captureReservationMarketObservation(reservation, "T_MINUS_30", {
    observedAt: "2026-09-30T23:30:00Z", alreadyCaptured: async () => false,
    readExactEvent: async () => [], fetchBooks: async () => [],
    write: async (captureRun) => { run = captureRun; },
  });
  assert.equal(run.failure_reason, "RESERVED_EVENT_MARKET_SET_UNAVAILABLE");
  assert.equal(run.markets_discovered_n, 0);
});

test("milestone windows have deterministic non-overlapping boundaries", () => {
  const start = "2026-10-01T00:00:00Z";
  const at = (minutes: number) => Date.parse(start) - minutes * 60_000;
  // LIVE_BETTING_RECOVERY_FINAL_HOTFIX_V2: the Final Rebalance source (T_MINUS_10) window opens at T-20, adjacent to the early window.
  // T40_T20_CAPTURE_ALIGNMENT_V1: the early window (persisted label T_MINUS_30, business target T40) is (20, 40].
  assert.equal(classifyReservationMarketPhase(start, at(40.5)), null, "before the early window opens");
  assert.equal(classifyReservationMarketPhase(start, at(40)), "T_MINUS_30", "T-40.0 => early phase eligible");
  assert.equal(classifyReservationMarketPhase(start, at(39.9)), "T_MINUS_30", "T-39.9 => early phase");
  assert.equal(classifyReservationMarketPhase(start, at(30)), "T_MINUS_30", "T-30 => early phase");
  assert.equal(classifyReservationMarketPhase(start, at(20.5)), "T_MINUS_30");
  assert.equal(classifyReservationMarketPhase(start, at(20.1)), "T_MINUS_30", "T-20.1 => early phase");
  assert.equal(classifyReservationMarketPhase(start, at(20)), "T_MINUS_10", "T-20.0 => final/money phase; first Queue / economic-action instant");
  assert.equal(classifyReservationMarketPhase(start, at(19.9)), "T_MINUS_10", "T-19.9 => final/money phase");
  assert.equal(classifyReservationMarketPhase(start, at(15)), "T_MINUS_10");
  assert.equal(classifyReservationMarketPhase(start, at(9.5)), "T_MINUS_10");
  assert.equal(classifyReservationMarketPhase(start, at(9)), null);
  assert.equal(classifyReservationMarketPhase(start, at(5)), null); // no live T_MINUS_3 capture
  assert.equal(classifyReservationMarketPhase(start, at(3)), null);
});

test("T40_T20_CAPTURE_ALIGNMENT_V1: the early phase is captured once at the first eligible tick (~T-40) and never recaptured through T-20", async () => {
  const start = "2026-10-01T00:00:00Z";
  const startMs = Date.parse(start);
  const reservation = { id: "66666666-6666-4666-8666-666666666666", plan_run_id: "plan",
    physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: start,
    diagnostics: { source_lineage: { provider_event_id: "123", provider_event_start_iso: start } },
  } as unknown as NightEventReservationRow;
  const market = { provider_event_id: "123", event_start_iso: start, condition_id: "money",
    clob_token_ids: '["m1","m2"]', outcomes: '["Home","Away"]', sports_market_type: "moneyline",
    provider_market_slug: "match-money", sibling_market_count: 1, last_observed_at: "2026-09-30T23:00:00Z" };
  // Persisted-run stand-in: same contract as defaultAlreadyCaptured (any run that is not WRITE_INCOMPLETE blocks a recapture).
  const persisted: Array<{ phase: string; status: unknown; minutes: number }> = [];
  let bookFetches = 0;
  let loadedCohort: { lower: string; upper: string } | null = null;
  let upperEdgeLoadedAtT40 = false;
  for (let minute = 41; minute >= 8; minute -= 1) {
    const nowMs = startMs - minute * 60_000;
    await captureReservationMarketMilestones(nowMs, {
      load: async (lower, upper) => {
        loadedCohort = { lower, upper };
        // A real loader returns reservations with lower < start <= upper.
        return startMs > Date.parse(lower) && startMs <= Date.parse(upper) ? [reservation] : [];
      },
      capture: (r, phase, observedAt) => captureReservationMarketObservation(r, phase, {
        observedAt,
        alreadyCaptured: async (_id, ph) => persisted.some((p) => p.phase === ph && p.status !== "WRITE_INCOMPLETE"),
        readExactEvent: async () => [market],
        readGameEvents: async () => [],
        fetchBooks: async (ids) => { bookFetches++; return ids.map((tokenId) => ({ ok: true, tokenId, latencyMs: 1,
          book: { tokenId, bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.5, size: 10 }] } })); },
        fetchFeeSchedule: async (tokenId) => ({ ok: false, tokenId, errorCode: "FEE_TEST_OFFLINE", latencyMs: 0 }),
        write: async (run) => { persisted.push({ phase: String(run.observation_phase), status: run.capture_status === "WRITE_INCOMPLETE" ? "WRITE_INCOMPLETE" : "COMPLETE", minutes: Number(run.minutes_to_start) }); },
      }),
      onError: (code) => { throw new Error(`unexpected milestone error ${code} at T-${minute}`); },
    });
    if (minute === 40) upperEdgeLoadedAtT40 = persisted.some((p) => p.phase === "T_MINUS_30");
  }
  assert.ok(loadedCohort, "the cohort loader ran");
  assert.equal(upperEdgeLoadedAtT40, true, "the cohort upper bound reaches T-40, so the first eligible tick captures");
  const early = persisted.filter((p) => p.phase === "T_MINUS_30");
  const final = persisted.filter((p) => p.phase === "T_MINUS_10");
  assert.equal(early.length, 1, "early phase persisted exactly once across T-40..T-20");
  assert.equal(early[0].minutes, 40, "first eligible tick is ~T-40");
  assert.equal(final.length, 1, "final/money phase persisted exactly once, first at T-20");
  assert.equal(final[0].minutes, 20);
  assert.equal(bookFetches, 2, "no CLOB re-read after a completed phase: one fetch per phase, not one per tick");
});

test("persisted milestone skips inventory and CLOB on a repeated tick", async () => {
  const reservation = { id: "33333333-3333-4333-8333-333333333333" } as NightEventReservationRow;
  await captureReservationMarketObservation(reservation, "T_MINUS_30", {
    alreadyCaptured: async () => true,
    readInventory: async () => { throw new Error("unexpected inventory read"); },
    fetchBooks: async () => { throw new Error("unexpected CLOB read"); },
  });
});

test("QUEUED and SKIPPED persisted reservations remain in the telemetry cohort", async () => {
  const start = "2026-10-01T00:00:00Z";
  const captured: string[] = [];
  for (const [status, minutes, expected] of [["QUEUED", 10, "T_MINUS_10"], ["SKIPPED", 12, "T_MINUS_10"]] as const) {
    const row = { id: status, status, event_start_iso: start } as unknown as NightEventReservationRow;
    await captureReservationMarketMilestones(Date.parse(start) - minutes * 60_000, {
      load: async () => [row],
      capture: async (reservation, phase) => { captured.push(`${reservation.status}:${phase}`); },
    });
    assert.equal(captured.at(-1), `${status}:${expected}`);
    assert.equal(row.status, status);
  }
});

test("every market observation produces S1/S2/S3 scalar-only rows", () => {
  const rows = strategyRowsForMarketObservations([{ id: "m1", capture_run_id: "r", reservation_id: "q", physical_event_id: "p", condition_id: "c", token_id: "t", side: "Yes", observation_phase: "T_MINUS_30", observed_at: "2026-09-30T23:30:00Z", minutes_to_start: 30, best_ask: 0.5, ask_decimal_odds: 2, spread_abs: 0.1, raw: { forbidden: true } }]);
  assert.deepEqual(rows.map((row) => row.strategy_variant), ["S1_TAKER_HOLD", "S2_FIXED_MAKER_HOLD", "S3_MAKER_VALUE_BAND_HOLD"]);
  assert.equal(rows[0].market_observation_id, "m1");
  assert.equal(rows[0].available_best_ask, 0.5);
  assert.equal(rows[1].maker_target_state, "NOT_DEFINED_YET");
  assert.equal(rows[1].maker_target_price, null);
  assert.equal(rows[2].maker_band_state, "NOT_DEFINED_YET");
  assert.equal(rows[2].maker_band_min_price, null);
  assert.equal(JSON.stringify(rows).includes("forbidden"), false);
});

test("persisted strategy reread carries measured LIVE_GUARD ask depth into S1", () => {
  const source = readFileSync(new URL("../../lib/executor/reservationMarketBaseline.ts", import.meta.url), "utf8");
  const projection = source.match(/\.select\("([^"]+)"\)\s*\.eq\("capture_run_id", run\.id\)/)?.[1];
  assert.ok(projection, "persisted observation reread projection exists");
  assert.ok(projection.split(",").includes("ask_depth_relevant_usd"));
  const persisted = {
    id: "m-live", capture_run_id: "r", reservation_id: "q", physical_event_id: "p",
    condition_id: "c", token_id: "t", side: "Yes", observation_phase: "LIVE_GUARD",
    observed_at: "2026-09-30T23:30:00Z", minutes_to_start: 30,
    ask_depth_relevant_usd: 1.61,
  };
  const reread = Object.fromEntries(Object.entries(persisted).filter(([key]) => projection.split(",").includes(key)));
  const rows = strategyRowsForMarketObservations([reread]);
  assert.equal(rows[0].strategy_variant, "S1_TAKER_HOLD");
  assert.equal(rows[0].executable_depth_usd, 1.61);
});

test("baseline IDs and incomplete market accounting are deterministic", () => {
  assert.equal(stableTelemetryId("r", "phase", "v1"), stableTelemetryId("r", "phase", "v1"));
  assert.notEqual(stableTelemetryId("r", "phase", "v1"), stableTelemetryId("r2", "phase", "v1"));
  const market = { provider_event_id: "123", provider_game_id: "999", event_start_iso: "2026-10-01T00:00:00Z", condition_id: "c", clob_token_ids: ["t1", "t2"], outcomes: ["Yes", "No"], sports_market_type: "totals", provider_market_slug: "total", sibling_market_count: 1, last_observed_at: "2026-09-30T00:00:00Z" };
  const set = inventoryTokens([market]);
  assert.equal(set.expected, 2);
  assert.equal(set.tokens.length, 2);
  assert.deepEqual(baselineCompleteness({ markets: 1, siblingCounts: [1], expected: 2, observed: 2, failed: 0, missingIdentity: 0 }), { complete: true, status: "COMPLETE" });
});

test("source-set completeness covers supplied identities, independently of book success", () => {
  const source = { markets: 4, siblingCounts: [4, 4, 4, 4], expected: 8, observed: 8, failed: 1, missingIdentity: 0 };
  assert.deepEqual(baselineCompleteness(source), { complete: true, status: "COMPLETE" });
  for (const change of [{ siblingCounts: [4, 4, 3, 4] }, { missingIdentity: 1 }, { observed: 7 }]) {
    assert.equal(baselineCompleteness({ ...source, ...change }).complete, false);
  }
});

test("completed T3 reader returns only one exact same-event capture and rejects foreign or incomplete rows", async () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "reservation", physical_event_id: "event", event_start_iso: start,
    diagnostics: { source_lineage: { provider_event_id: "provider" } } } as unknown as NightEventReservationRow;
  const run = { id: "run-t3", reservation_id: "reservation", physical_event_id: "event", provider_event_id: "provider",
    event_start_iso: start, observation_phase: "T_MINUS_10", source_version: "RESERVATION_MARKET_BASELINE_V1",
    capture_complete: true, capture_status: "COMPLETE", market_tokens_expected_n: 2, market_tokens_observed_n: 2 };
  const first = { id: "a", capture_run_id: "run-t3", reservation_id: "reservation", physical_event_id: "event",
    provider_event_id: "provider", event_start_iso: start, observation_phase: "T_MINUS_10", condition_id: "spread",
    token_id: "spread-token", side: "Yes", canonical_market_family: "SPREADS", canonical_market_type: "SPREAD",
    best_ask: 0.5, ask_decimal_odds: 2, orderbook_fetch_status: "SUCCESS" };
  const second = { ...first, id: "b", condition_id: "corners", token_id: "corners-token", canonical_market_family: "TOTAL_CORNERS", orderbook_fetch_status: "FAILED" };
  const read = (runs: Record<string, unknown>[], rows: Record<string, unknown>[]) => readCompletedFinalT3Universe(reservation, {
    readRuns: async () => runs, readObservations: async () => rows,
  });
  assert.deepEqual((await read([run], [first, second])).map((row) => row.token_id), ["spread-token", "corners-token"]);
  for (const bad of [
    { ...run, capture_complete: false }, { ...run, reservation_id: "foreign" },
    { ...run, physical_event_id: "foreign" }, { ...run, provider_event_id: "foreign" },
    { ...run, event_start_iso: "2026-10-02T00:00:00Z" }, { ...run, observation_phase: "T_MINUS_3" },
  ]) await assert.rejects(read([bad], [first, second]), /FINAL_T3_SOURCE_UNAVAILABLE/);
  for (const bad of [
    { ...second, capture_run_id: "other" }, { ...second, reservation_id: "foreign" },
    { ...second, physical_event_id: "foreign" }, { ...second, event_start_iso: "2026-10-02T00:00:00Z" },
    { ...second, observation_phase: "T_MINUS_30" }, { ...second, condition_id: null },
    { ...second, token_id: "" }, { ...second, side: null },
  ]) await assert.rejects(read([run], [first, bad]), /FINAL_T3_SOURCE_UNAVAILABLE/);
  await assert.rejects(read([run, { ...run, id: "run-2" }], [first, second]), /FINAL_T3_SOURCE_UNAVAILABLE/);
});

test("one T30 snapshot records distinct tokens and survives one failed orderbook", async () => {
  const market = { provider_event_id: "123", provider_game_id: "999", event_start_iso: "2026-10-01T00:00:00Z", condition_id: "c", clob_token_ids: ["t1", "t2"], outcomes: ["Yes", "No"], sports_market_type: "totals", provider_market_slug: "total", sibling_market_count: 1, last_observed_at: "2026-09-30T00:00:00Z" };
  const reservation = { id: "11111111-1111-4111-8111-111111111111", plan_run_id: "plan", physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: "2026-10-01T00:00:00Z", diagnostics: { source_lineage: { provider_event_id: "123", provider_event_start_iso: "2026-10-01T00:00:00Z" } } } as unknown as NightEventReservationRow;
  let savedRun: Record<string, unknown> | null = null;
  let savedRows: Record<string, unknown>[] = [];
  await captureReservationMarketObservation(reservation, "T_MINUS_30", {
    observedAt: "2026-09-30T00:00:00Z",
    alreadyCaptured: async () => false,
    readExactEvent: async () => [market], readGameEvents: async () => [market],
    fetchBooks: async () => [
      { ok: true, tokenId: "t1", latencyMs: 12, book: { tokenId: "t1", bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.5, size: 10 }], raw: {} } },
      { ok: false, tokenId: "t2", latencyMs: 99, errorCode: "TIMEOUT", errorMessage: "timeout" },
    ],
    write: async (run, rows) => { savedRun = run; savedRows = rows; },
  });
  const capturedRun = savedRun as Record<string, unknown> | null;
  assert.equal(capturedRun?.market_tokens_expected_n, 2);
  assert.equal(capturedRun?.orderbooks_success_n, 1);
  assert.equal(capturedRun?.orderbooks_failed_n, 1);
  assert.equal(savedRows.length, 2);
  assert.notEqual(savedRows[0].id, savedRows[1].id);
  assert.equal(savedRows[1].orderbook_failure_reason, "TIMEOUT");
});

test("all supplied T10 identities certify source-set completeness", async () => {
  const reservation = { id: "22222222-2222-4222-8222-222222222222", plan_run_id: "plan", physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: "2026-10-01T00:00:00Z", diagnostics: { source_lineage: { provider_event_id: "123", provider_event_start_iso: "2026-10-01T00:00:00Z" } } } as unknown as NightEventReservationRow;
  let run: Record<string, unknown> = {};
  await captureReservationMarketObservation(reservation, "T_MINUS_10", {
    observedAt: "2026-09-30T00:00:00Z",
    alreadyCaptured: async () => false,
    readExactEvent: async () => [{ provider_event_id: "123", provider_game_id: "999", event_start_iso: "2026-10-01T00:00:00Z", condition_id: "c", clob_token_ids: ["t1", "t2"], outcomes: ["Yes", "No"], sports_market_type: "totals", provider_market_slug: "total", sibling_market_count: 1, last_observed_at: "2026-09-30T00:00:00Z" }],
    readGameEvents: async () => [{ provider_event_id: "123", provider_game_id: "999", event_start_iso: "2026-10-01T00:00:00Z", condition_id: "c", clob_token_ids: ["t1", "t2"], outcomes: ["Yes", "No"], sports_market_type: "totals", provider_market_slug: "total", sibling_market_count: 1, last_observed_at: "2026-09-30T00:00:00Z" }],
    fetchBooks: async (ids) => ids.map((tokenId) => ({ ok: true, tokenId, latencyMs: 1, book: { tokenId, bids: [{ price: 0.4, size: 1 }], asks: [{ price: 0.5, size: 1 }], raw: {} } })),
    write: async (captureRun) => { run = captureRun; },
  });
  assert.equal(run.market_tokens_expected_n, 2);
  assert.equal(run.orderbooks_success_n, 2);
  assert.equal(run.capture_complete, true);
  assert.equal(run.capture_status, "COMPLETE");
});

test("classifyObservationalMarket maps structured provider types only", () => {
  assert.deepEqual(classifyObservationalMarket("moneyline"), { family: "MONEYLINE", type: "MONEYLINE" });
  assert.deepEqual(classifyObservationalMarket("spread"), { family: "SPREADS", type: "SPREAD" });
  assert.deepEqual(classifyObservationalMarket("spreads"), { family: "SPREADS", type: "SPREAD" });
  assert.deepEqual(classifyObservationalMarket("total"), { family: "TOTALS", type: "TOTAL" });
  assert.deepEqual(classifyObservationalMarket("totals"), { family: "TOTALS", type: "TOTAL" });
  assert.deepEqual(classifyObservationalMarket("total_corners"), { family: "TOTAL_CORNERS", type: "TOTAL_CORNERS" });
  assert.deepEqual(classifyObservationalMarket("both_teams_to_score"), { family: "OTHER_STRUCTURED", type: "OTHER_STRUCTURED" });
  assert.deepEqual(classifyObservationalMarket("corners"), { family: "OTHER_STRUCTURED", type: "OTHER_STRUCTURED" });
  for (const raw of [null, undefined, "", "   ", "Will the home team win by 2+?", "a/b", 42]) {
    assert.deepEqual(classifyObservationalMarket(raw), { family: "UNKNOWN", type: "UNKNOWN" });
  }
});

test("T-phase rows carry canonical family/type for the supported live universe without changing eligibility", async () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "66666666-6666-4666-8666-666666666666", plan_run_id: "plan",
    physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: start,
    diagnostics: { source_lineage: { provider_event_id: "123", provider_event_start_iso: start } },
  } as unknown as NightEventReservationRow;
  const types = ["moneyline", "spreads", "totals", "total_corners", "btts", "Free text title?"];
  const market = (t: string, i: number) => ({ provider_event_id: "123", provider_game_id: "999", event_start_iso: start, condition_id: `c${i}`,
    clob_token_ids: [`a${i}`, `b${i}`], outcomes: ["Yes", "No"], sports_market_type: t, provider_market_slug: `slug-${t}`,
    sibling_market_count: types.length, last_observed_at: "2026-09-30T00:00:00Z" });
  let rows: Record<string, unknown>[] = [];
  await captureReservationMarketObservation(reservation, "T_MINUS_30", {
    observedAt: "2026-09-30T23:30:00Z", alreadyCaptured: async () => false,
    readExactEvent: async () => types.map(market), readGameEvents: async () => types.map(market),
    fetchBooks: async (ids) => ids.map((tokenId) => ({ ok: true, tokenId, latencyMs: 1,
      book: { tokenId, bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.5, size: 10 }], raw: {} } })),
    write: async (_run, observations) => { rows = observations; },
  });
  assert.equal(rows.length, 4 * 2, "only the supported live families are captured");
  const byRaw = new Map(rows.map((row) => [row.provider_market_type_raw, [row.canonical_market_family, row.canonical_market_type]]));
  assert.deepEqual(byRaw.get("moneyline"), ["MONEYLINE", "MONEYLINE"]);
  assert.deepEqual(byRaw.get("spreads"), ["SPREADS", "SPREAD"]);
  assert.deepEqual(byRaw.get("totals"), ["TOTALS", "TOTAL"]);
  assert.deepEqual(byRaw.get("total_corners"), ["TOTAL_CORNERS", "TOTAL_CORNERS"]);
  assert.equal(byRaw.has("btts"), false, "OTHER_STRUCTURED is not captured at milestones");
  assert.equal(byRaw.has("Free text title?"), false, "UNKNOWN is never guessed or captured");
  for (const row of rows) {
    assert.equal(row.live_policy_eligibility, null);
    assert.equal(row.live_policy_rejection_reason, null);
    assert.equal(row.best_bid, 0.4);
    assert.equal(row.best_ask, 0.5);
    assert.equal(row.source_version, "RESERVATION_MARKET_BASELINE_V1");
  }
});

test("LIVE_GUARD preserves measured fields and never guesses a market family", () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "77777777-7777-4777-8777-777777777777", plan_run_id: "plan",
    physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: start } as unknown as NightEventReservationRow;
  const { observation } = liveGuardTelemetryRows(reservation, {
    attemptId: "att", observedAt: "2026-09-30T23:55:00Z", conditionId: "c", tokenId: "t", side: "Yes",
    marketSlug: "will-total-goals-be-over-2-5", referenceEntryPrice: 0.5, executionPriceCap: 0.52, requestedStakeUsd: 2,
    pass: false, rejectionReason: "DEPTH", fetchStatus: "SUCCESS", fetchFailureReason: null, fetchLatencyMs: 7,
    bestBid: 0.48, bestAsk: 0.5, spread: 0.02, capEligibleAskDepthUsd: 1.61, fullStakeExecutableVwap: 0.505,
  });
  assert.equal(observation.canonical_market_family, null);
  assert.equal(observation.canonical_market_type, null);
  assert.equal(observation.provider_market_type_raw, null);
  assert.equal(observation.ask_depth_relevant_usd, 1.61);
  assert.equal(observation.full_stake_executable_vwap, 0.505);
  assert.equal(observation.reference_entry_price, 0.5);
  assert.equal(observation.execution_price_cap, 0.52);
  assert.equal(observation.requested_stake_usd, 2);
  assert.equal(observation.live_policy_eligibility, false);
  assert.equal(observation.live_policy_rejection_reason, "DEPTH");
});

const RUN = "run-1";
function decisionStore(candidates: Record<string, unknown>[], persisted: Record<string, unknown>[] = []) {
  const decisions = [...persisted];
  const page = (rows: Record<string, unknown>[], after: string, limit: number) =>
    [...rows].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1).filter((r) => String(r.id) > after).slice(0, limit);
  const store: ReservationStrategyDecisionStore = {
    readObservations: async (run, after, limit) => page(candidates.filter((c) => c.capture_run_id === run), after, limit),
    readDecisions: async (_run, variant, after, limit) => page(decisions.filter((d) => d.strategy_variant === variant), after, limit),
    upsertDecisions: async (rows) => { for (const r of rows) if (!decisions.some((d) => d.market_observation_id === r.market_observation_id && d.strategy_variant === r.strategy_variant)) decisions.push(r); },
  };
  return { store, decisions };
}
const candidates = (run = RUN) => ["m1", "m2", "m3", "m4"].map((id, i) => ({ id, capture_run_id: run, reservation_id: "q", physical_event_id: "p",
  condition_id: `c${i}`, token_id: `t${i}`, side: "Yes", observation_phase: "T_MINUS_10", observed_at: "2026-09-30T23:50:00Z",
  minutes_to_start: 10, best_ask: 0.5, ask_decimal_odds: 2, spread_abs: 0.01, ask_depth_relevant_usd: null }));
const decide = (over: Record<string, unknown> = {}) => ({ captureRunId: RUN, strategyVariant: "A_CURRENT_CONTROL" as const, strategyVersion: "v1",
  selectedIdentity: { conditionId: "c1", tokenId: "t1", side: "Yes" }, decisionReason: "CHOSEN", ...over });

test("A/B decision selects exactly one candidate and marks siblings not selected", async () => {
  for (const variant of ["A_CURRENT_CONTROL", "B_FOUR_MARKET_PRIORITY_V1"] as const) {
    const { store, decisions } = decisionStore(candidates());
    const result = await recordReservationStrategyDecision(decide({ strategyVariant: variant }), { store });
    assert.deepEqual(result, { total: 4, selected: 1, written: 4 });
    const selected = decisions.filter((d) => d.evaluation_state === "SELECTED");
    assert.equal(selected.length, 1);
    assert.equal(selected[0].market_observation_id, "m2");
    assert.equal(selected[0].eligible, true);
    assert.equal(selected[0].rejection_reason, null);
    assert.equal(selected[0].strategy_variant, variant);
    const siblings = decisions.filter((d) => d.evaluation_state !== "SELECTED");
    assert.equal(siblings.length, 3);
    for (const row of siblings) {
      assert.equal(row.evaluation_state, "EVALUATED_NOT_SELECTED");
      assert.equal(row.eligible, false);
      assert.equal(row.rejection_reason, "NOT_SELECTED_BY_STRATEGY");
    }
  }
});

test("A/B SKIP decision selects nothing and carries the supplied reason", async () => {
  const { store, decisions } = decisionStore(candidates());
  const result = await recordReservationStrategyDecision(decide({ selectedIdentity: null, decisionReason: "NO_PRIORITY_MARKET" }), { store });
  assert.equal(result.selected, 0);
  assert.equal(decisions.length, 4);
  for (const row of decisions) {
    assert.equal(row.evaluation_state, "EVALUATED_NOT_SELECTED");
    assert.equal(row.eligible, false);
    assert.equal(row.rejection_reason, "NO_PRIORITY_MARKET");
  }
});

test("A/B decision is independent of candidate input order", async () => {
  const forward = decisionStore(candidates());
  const reversed = decisionStore(candidates().reverse());
  await recordReservationStrategyDecision(decide(), { store: forward.store });
  await recordReservationStrategyDecision(decide(), { store: reversed.store });
  const sorted = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  assert.deepEqual(sorted(reversed.decisions), sorted(forward.decisions));
});

test("A/B decision replay is idempotent and repairs an interrupted write", async () => {
  const { store, decisions } = decisionStore(candidates());
  await recordReservationStrategyDecision(decide(), { store });
  assert.deepEqual(await recordReservationStrategyDecision(decide(), { store }), { total: 4, selected: 1, written: 0 });
  assert.equal(decisions.length, 4);
  decisions.splice(2, 2);
  assert.deepEqual(await recordReservationStrategyDecision(decide(), { store }), { total: 4, selected: 1, written: 2 });
  assert.equal(decisions.length, 4);
  assert.equal(new Set(decisions.map((d) => d.id)).size, 4);
});

test("A/B decision fails closed on empty, ambiguous, missing, foreign or unsupported input", async () => {
  await assert.rejects(recordReservationStrategyDecision(decide(), { store: decisionStore([]).store }), /STRATEGY_DECISION_NO_OBSERVATIONS/);
  await assert.rejects(recordReservationStrategyDecision(decide({ selectedIdentity: { conditionId: "zz", tokenId: "t1", side: "Yes" } }), { store: decisionStore(candidates()).store }), /SELECTED_IDENTITY_NOT_FOUND/);
  const dup = candidates(); dup[3] = { ...dup[3], condition_id: "c1", token_id: "t1" };
  await assert.rejects(recordReservationStrategyDecision(decide(), { store: decisionStore(dup).store }), /SELECTED_IDENTITY_AMBIGUOUS/);
  const foreign = decisionStore(candidates()).store;
  await assert.rejects(recordReservationStrategyDecision(decide(), { store: { ...foreign, readObservations: async (...a) => (await foreign.readObservations(...a)).map((r, i) => i === 0 ? { ...r, capture_run_id: "other" } : r) } }), /CAPTURE_RUN_MISMATCH/);
  await assert.rejects(recordReservationStrategyDecision(decide({ strategyVariant: "S1_TAKER_HOLD" as never }), { store: decisionStore(candidates()).store }), /UNSUPPORTED_VARIANT/);
  const { store, decisions } = decisionStore(candidates());
  await assert.rejects(recordReservationStrategyDecision(decide({ selectedIdentity: null, decisionReason: " " }), { store }), /STRATEGY_DECISION_INPUT_INVALID/);
  assert.equal(decisions.length, 0);
});

test("A/B decision conflicting with a persisted decision throws STRATEGY_DECISION_CONFLICT and writes nothing", async () => {
  const { store, decisions } = decisionStore(candidates());
  await recordReservationStrategyDecision(decide(), { store });
  const before = JSON.stringify(decisions);
  await assert.rejects(recordReservationStrategyDecision(decide({ selectedIdentity: { conditionId: "c2", tokenId: "t2", side: "Yes" } }), { store }), /STRATEGY_DECISION_CONFLICT/);
  await assert.rejects(recordReservationStrategyDecision(decide({ selectedIdentity: null, decisionReason: "SKIP" }), { store }), /STRATEGY_DECISION_CONFLICT/);
  assert.equal(JSON.stringify(decisions), before);
  // A different strategy variant on the same run is independent.
  await recordReservationStrategyDecision(decide({ strategyVariant: "B_FOUR_MARKET_PRIORITY_V1", selectedIdentity: { conditionId: "c2", tokenId: "t2", side: "Yes" } }), { store });
  assert.equal(decisions.length, 8);
});

test("S1/S2/S3 rows are unchanged by A/B telemetry", () => {
  const rows = strategyRowsForMarketObservations([{ id: "m1", capture_run_id: "r", best_ask: 0.5, ask_decimal_odds: 2, spread_abs: 0.1, ask_depth_relevant_usd: 3 }]);
  assert.deepEqual(rows.map((r) => [r.evaluation_state, r.strategy_version]), Array(3).fill(["NOT_EVALUATED", null]));
  assert.equal(rows[0].executable_depth_usd, 3);
  assert.equal(rows[1].maker_target_state, "NOT_DEFINED_YET");
  assert.equal(rows[2].maker_band_state, "NOT_DEFINED_YET");
});

test("one exact T3 universe yields Planning A and deterministic priority B", () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "r", physical_event_id: "p", event_start_iso: start,
    diagnostics: { planning_final_identity_evidence: { condition_id: "m", token_id: "m1", side: "Yes" } },
  } as unknown as NightEventReservationRow;
  const row = (condition_id: string, family: string, odds: number, extra: Partial<FinalT3MarketObservation> = {}): FinalT3MarketObservation => ({
    capture_run_id: "t3", reservation_id: "r", physical_event_id: "p", provider_event_id: "e", event_start_iso: start,
    observation_phase: "T_MINUS_10", condition_id, token_id: `${condition_id}1`, side: "Yes",
    canonical_market_family: family, canonical_market_type: ({ SPREADS: "SPREAD", TOTAL_CORNERS: "TOTAL_CORNERS", MONEYLINE: "MONEYLINE", TOTALS: "TOTAL" } as Record<string, string>)[family],
    best_ask: 1 / odds, ask_decimal_odds: odds, orderbook_fetch_status: "SUCCESS", ...extra,
  });
  const corners = row("c", "TOTAL_CORNERS", 2.3, { provider_market_type_raw: "total_corners", market_slug: "total-corners" });
  const money = row("m", "MONEYLINE", 1.9);
  const totals = row("t", "TOTALS", 1.9);
  const spreadZ = row("z", "SPREADS", 1.9);
  const spreadA = row("a", "SPREADS", 1.9);
  const choose = (rows: FinalT3MarketObservation[]) => selectReservationT3AbDecisions(reservation, rows);
  assert.deepEqual(choose([spreadZ, corners, money, totals, spreadA]).a.selectedIdentity,
    { conditionId: "m", tokenId: "m1", side: "Yes" });
  assert.equal(choose([spreadZ, corners, money, totals, spreadA]).b.selectedIdentity?.conditionId, "a");
  assert.deepEqual(choose([spreadZ, corners, money, totals, spreadA]), choose([spreadA, totals, money, corners, spreadZ]));
  assert.equal(choose([row("z", "SPREADS", 2.01), corners, money, totals]).b.selectedIdentity?.conditionId, "c");
  assert.equal(choose([row("z", "SPREADS", 2.01), row("c", "TOTAL_CORNERS", 2.51), money, totals]).b.selectedIdentity?.conditionId, "m");
  assert.equal(choose([totals]).b.selectedIdentity?.conditionId, "t");
  assert.equal(choose([row("t", "TOTALS", 2.01)]).b.selectedIdentity, null);
  assert.equal(choose([corners]).a.decisionReason, "PLANNING_IDENTITY_NOT_IN_T3");
  assert.equal(choose([row("m", "MONEYLINE", 1.9, { orderbook_fetch_status: "FAILED" })]).a.decisionReason, "PLANNING_T3_BOOK_UNAVAILABLE");
  assert.throws(() => choose([money, { ...corners, physical_event_id: "foreign" }]), /AB_T3_UNIVERSE_LINEAGE_INVALID/);
  assert.deepEqual(classifyExactEventMarket("total_corners", "total-corners"), { family: "TOTAL_CORNERS", type: "TOTAL_CORNERS" });
  for (const slug of ["home-team-total-corners", "first-half-total-corners", "last-corner", "corner-race", "odd-even-total-corners"]) {
    assert.notEqual(classifyExactEventMarket("total_corners", slug).family, "TOTAL_CORNERS");
    assert.equal(choose([{ ...corners, market_slug: slug }]).b.selectedIdentity, null);
  }
  assert.equal(choose([{ ...corners, provider_market_type_raw: "corners" }]).b.selectedIdentity, null);
});

test("A and B persist on the same completed T3 capture", async () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "r", physical_event_id: "p", event_start_iso: start,
    diagnostics: { planning_final_identity_evidence: { condition_id: "m", token_id: "m1", side: "Yes" } },
  } as unknown as NightEventReservationRow;
  const universe: FinalT3MarketObservation[] = [{ capture_run_id: "t3", reservation_id: "r", physical_event_id: "p",
    provider_event_id: "e", event_start_iso: start, observation_phase: "T_MINUS_10", condition_id: "m", token_id: "m1", side: "Yes",
    canonical_market_family: "MONEYLINE", canonical_market_type: "MONEYLINE", best_ask: 0.52, ask_decimal_odds: 1.92,
    orderbook_fetch_status: "SUCCESS" }];
  const recorded: string[] = [];
  let reads = 0;
  const decisions = await persistReservationT3AbDecisions(reservation, {
    readUniverse: async () => { reads++; return universe; },
    recordDecision: async (decision) => { recorded.push(`${decision.captureRunId}:${decision.strategyVariant}`); return { total: 1, selected: 1, written: 1 }; },
  });
  assert.equal(reads, 1);
  assert.deepEqual(recorded, ["t3:A_CURRENT_CONTROL", "t3:B_FOUR_MARKET_PRIORITY_V1"]);
  assert.deepEqual(decisions.a.selectedIdentity, decisions.b.selectedIdentity);
});
