import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baselineCompleteness, inventoryTokens, stableTelemetryId, captureReservationMarketBaseline, classifyReservationMarketPhase, captureReservationMarketObservation, captureReservationMarketMilestones, strategyRowsForMarketObservations } from "../../lib/executor/reservationMarketBaseline";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

test("T30, T10 and T3 each fetch the one reserved event and preserve every supplied token", async () => {
  const start = "2026-10-01T00:00:00Z";
  const reservation = { id: "33333333-3333-4333-8333-333333333333", plan_run_id: "plan",
    physical_event_id: "provider:polymarket:123:2026-10-01", event_start_iso: start,
    diagnostics: { source_lineage: { provider_event_id: "123", provider_event_start_iso: start } },
  } as unknown as NightEventReservationRow;
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ id: "123", endDate: start, markets: [
      { conditionId: "money", clobTokenIds: '["m1","m2"]', outcomes: '["Home","Away"]', sportsMarketType: "moneyline", slug: "match-money" },
      { conditionId: "corners", clobTokenIds: '["c1","c2"]', outcomes: '["Yes","No"]', sportsMarketType: "corners", slug: "corners" },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const snapshots: Array<{ run: Record<string, unknown>; rows: Record<string, unknown>[]; strategies: Record<string, unknown>[] }> = [];
    for (const [phase, minutes] of [["T_MINUS_30", 30], ["T_MINUS_10", 10], ["T_MINUS_3", 8]] as const) {
      await captureReservationMarketObservation(reservation, phase, {
        observedAt: new Date(Date.parse(start) - minutes * 60_000).toISOString(),
        alreadyCaptured: async () => false,
        fetchBooks: async (ids) => ids.map((tokenId) => ({ ok: true, tokenId, latencyMs: 1,
          book: { tokenId, bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.5, size: 10 }] } })),
        write: async (run, rows, strategies = []) => { snapshots.push({ run, rows, strategies }); },
      });
    }
    assert.deepEqual(urls, Array(3).fill("https://gamma-api.polymarket.com/events/123"));
    assert.equal(snapshots.length, 3);
    assert.equal(new Set(snapshots.map((s) => s.run.id)).size, 3);
    for (const snapshot of snapshots) {
      assert.equal(snapshot.rows.length, 4);
      assert.equal(snapshot.strategies.length, 12);
      assert.deepEqual(new Set(snapshot.rows.map((row) => row.provider_market_type_raw)), new Set(["moneyline", "corners"]));
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
  assert.equal(classifyReservationMarketPhase(start, at(30)), "T_MINUS_30");
  assert.equal(classifyReservationMarketPhase(start, at(20)), null);
  assert.equal(classifyReservationMarketPhase(start, at(15)), "T_MINUS_10");
  assert.equal(classifyReservationMarketPhase(start, at(9)), "T_MINUS_3");
  assert.equal(classifyReservationMarketPhase(start, at(3)), null);
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
  for (const [status, minutes, expected] of [["QUEUED", 10, "T_MINUS_10"], ["SKIPPED", 5, "T_MINUS_3"]] as const) {
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
  const market = { provider_event_id: "e", event_start_iso: "2026-10-01T00:00:00Z", condition_id: "c", clob_token_ids: ["t1", "t2"], outcomes: ["Yes", "No"], sports_market_type: "total", provider_market_slug: "total", sibling_market_count: 1, last_observed_at: "2026-09-30T00:00:00Z" };
  const set = inventoryTokens([market]);
  assert.equal(set.expected, 2);
  assert.equal(set.tokens.length, 2);
  assert.deepEqual(baselineCompleteness({ markets: 1, siblingCounts: [1], expected: 2, observed: 2, failed: 0, missingIdentity: 0 }), { complete: false, status: "INCOMPLETE_MARKET_SET" });
});

test("one reservation records distinct tokens and survives one failed orderbook", async () => {
  const market = { provider_event_id: "e", event_start_iso: "2026-10-01T00:00:00Z", condition_id: "c", clob_token_ids: ["t1", "t2"], outcomes: ["Yes", "No"], sports_market_type: "total", provider_market_slug: "total", sibling_market_count: 1, last_observed_at: "2026-09-30T00:00:00Z" };
  const reservation = { id: "11111111-1111-4111-8111-111111111111", plan_run_id: "plan", physical_event_id: "provider:polymarket:e:2026-10-01", event_start_iso: "2026-10-01T00:00:00Z", diagnostics: { source_lineage: { provider_event_id: "e", provider_event_start_iso: "2026-10-01T00:00:00Z" } } } as unknown as NightEventReservationRow;
  let savedRun: Record<string, unknown> | null = null;
  let savedRows: Record<string, unknown>[] = [];
  await captureReservationMarketBaseline(reservation, {
    observedAt: "2026-09-30T00:00:00Z",
    readInventory: async () => [market],
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

test("all supplied books succeeding still leaves source-set completeness unproven", async () => {
  const reservation = { id: "22222222-2222-4222-8222-222222222222", plan_run_id: "plan", physical_event_id: "provider:polymarket:e:2026-10-01", event_start_iso: "2026-10-01T00:00:00Z", diagnostics: { source_lineage: { provider_event_id: "e", provider_event_start_iso: "2026-10-01T00:00:00Z" } } } as unknown as NightEventReservationRow;
  let run: Record<string, unknown> = {};
  await captureReservationMarketBaseline(reservation, {
    observedAt: "2026-09-30T00:00:00Z",
    readInventory: async () => [{ provider_event_id: "e", event_start_iso: "2026-10-01T00:00:00Z", condition_id: "c", clob_token_ids: ["t1", "t2"], outcomes: ["Yes", "No"], sports_market_type: "total", provider_market_slug: "total", sibling_market_count: 1, last_observed_at: "2026-09-30T00:00:00Z" }],
    fetchBooks: async (ids) => ids.map((tokenId) => ({ ok: true, tokenId, latencyMs: 1, book: { tokenId, bids: [{ price: 0.4, size: 1 }], asks: [{ price: 0.5, size: 1 }], raw: {} } })),
    write: async (captureRun) => { run = captureRun; },
  });
  assert.equal(run.market_tokens_expected_n, 2);
  assert.equal(run.orderbooks_success_n, 2);
  assert.equal(run.capture_complete, false);
  assert.equal(run.capture_status, "INCOMPLETE_MARKET_SET");
});
