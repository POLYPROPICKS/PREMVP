import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { aggregateSettledCoverage, collectPlanDateAggregate } from "../../scripts/modeling/refresh-live-modeling-dashboard";
import { sanitizePublicLive } from "../../lib/modeling/publicLiveSanitizer";

const html = readFileSync("modeling/evidence/modeling-dashboard-v1/MODELING_DASHBOARD.html", "utf8");
const renderSource = html.split("// LIVE_SETTLEMENT_RENDER_START")[1].split("// LIVE_SETTLEMENT_RENDER_END")[0];
const render = vm.runInNewContext(renderSource + "; renderLiveSettlement", {
  esc: (s: unknown) => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)),
  fmtN: (n: unknown) => String(n),
  fmtUsd: (n: number) => (n >= 0 ? "+" : "") + "$" + n.toFixed(2),
});
const row = (real_pnl: number | null, fee_status: string | null = "REPORTED") => ({
  exchange_order_id: "order-private", settled_at: "2026-10-17T12:00:00Z", real_pnl, fee_status,
});

test("A: complete net coverage retains the complete realized total", () => {
  const result = aggregateSettledCoverage([row(1), row(-2), row(0)]);
  assert.equal(result.settled_n, 3);
  assert.equal(result.known_net_n, 3);
  assert.equal(result.net_unknown_n, 0);
  assert.equal(result.net_coverage_status, "COMPLETE");
  assert.equal(result.realized_pnl_usd, -1);
  assert.match(render(result), /COMPLETE 3\/3/);
  assert.match(render(result), /Complete realized net/);
});

test("B: partial coverage exposes only the known subtotal; unknown fee requires explicit evidence", async () => {
  const rows = [
    row(-9.262926), ...Array.from({ length: 27 }, () => row(0)),
    ...Array.from({ length: 27 }, () => row(null, "NOT_REPORTED")),
  ];
  const result = aggregateSettledCoverage(rows);
  assert.equal(result.count, 55);
  assert.equal(result.known_net_n, 28);
  assert.equal(result.net_unknown_n, 27);
  assert.equal(result.fee_unreported_n, 27);
  assert.equal(result.other_net_unknown_n, 0);
  assert.equal(result.realized_pnl_usd, null);
  assert.equal(result.known_net_pnl_usd, -9.262926);
  assert.equal(result.net_coverage_status, "PARTIAL");
  const markup = render(result);
  assert.match(markup, /PARTIAL 28\/55/);
  assert.match(markup, /Known net subtotal \(partial\)/);
  assert.doesNotMatch(markup, /Complete realized net P&amp;L: <b>/);

  const body = sanitizePublicLive({ status: "OK", days: [{ planFunnel: { settled: result } }],
    rawOrderId: "0x12345678901234567890", wallet: { balance: 2 }, transaction_hash: "0x12345678901234567890" });
  const response = NextResponse.json(body);
  const serialized = await response.json();
  assert.equal(serialized.days[0].planFunnel.settled.known_net_pnl_usd, -9.262926);
  assert.equal(serialized.days[0].planFunnel.settled.realized_pnl_usd, null);
  assert.equal(serialized.days[0].planFunnel.settled.fee_unreported_n, 27);
  assert.doesNotMatch(JSON.stringify(serialized), /order-private|0x12345678901234567890|rawOrderId|transaction_hash|"balance":/);
});

test("C: no net evidence never becomes zero; null alone is not fee-unreported", () => {
  const result = aggregateSettledCoverage([row(null, "NOT_REPORTED"), row(null, null), row(null, "REPORTED")]);
  assert.equal(result.known_net_n, 0);
  assert.equal(result.known_net_pnl_usd, null);
  assert.equal(result.realized_pnl_usd, null);
  assert.equal(result.fee_unreported_n, 1);
  assert.equal(result.other_net_unknown_n, 2);
  assert.equal(result.net_coverage_status, "NONE");
  assert.match(render(result), /NO NET EVIDENCE 0\/3/);
  assert.doesNotMatch(render(result), /\$0\.00|Complete realized net P&amp;L: <b>/);
});

test("D: no settlements retains pending semantics and excludes unsettled money", () => {
  const result = aggregateSettledCoverage([{ ...row(100), settled_at: null }]);
  assert.equal(result.status, "PENDING_NOT_SETTLED");
  assert.equal(result.settled_n, 0);
  assert.equal(result.known_net_pnl_usd, null);
  assert.equal(result.realized_pnl_usd, null);
  assert.match(render(result), /PENDING \/ NOT SETTLED/);
});

function fakeDb(ledger: ReturnType<typeof row>[], failLedger = false) {
  const calls: { table: string; columns: string; filters: unknown[] }[] = [];
  return {
    calls,
    from(table: string) {
      const call = { table, columns: "", filters: [] as unknown[] }; calls.push(call);
      const query: any = {
        select(columns: string) { call.columns = columns; return query; },
        eq(...args: unknown[]) { call.filters.push(args); return query; },
        in(...args: unknown[]) { call.filters.push(args); return query; },
        gte() { return query; }, lte() { return query; }, limit() { return query; },
        then(resolve: (v: unknown) => unknown) {
          const data = table === "night_event_reservations" ? [{ id: "reservation-private", status: "QUEUED", sport: "TENNIS", league: null }]
            : table === "event_execution_queue" ? [{ status: "EXECUTED", idempotency_key: "key-private", reservation_id: "reservation-private" }]
            : table === "executor_order_events" ? [{ idempotency_key: "key-private", clob_order_id: "order-private", stake_usd: 2.5, raw_event_json: null }]
            : ledger;
          return Promise.resolve({ data, error: failLedger && table === "bet_execution_ledger" ? { code: "SYNTHETIC_FAILURE" } : null }).then(resolve);
        },
      };
      return query;
    },
  };
}

test("E: ledger query failure stays MEASUREMENT_MISSING with unknown counts and no money", async () => {
  const db = fakeDb([], true);
  const result = await collectPlanDateAggregate(db as any, "2026-10-17", "2026-10-17");
  const settled = result.planFunnel.settled;
  assert.equal(settled.status, "MEASUREMENT_MISSING");
  assert.equal(settled.net_coverage_status, "MEASUREMENT_MISSING");
  assert.equal(settled.settled_n, null);
  assert.equal(settled.known_net_n, null);
  assert.equal(settled.realized_pnl_usd, null);
  assert.equal(settled.known_net_pnl_usd, null);
  assert.match(render(settled), /MEASUREMENT MISSING/);
  assert.doesNotMatch(render(settled), /\$0\.00|PENDING \/ NOT SETTLED/);
});

test("request-time aggregation preserves all exact plan lineage joins and projects fee status only", async () => {
  const db = fakeDb([row(1), row(null, "NOT_REPORTED")]);
  const result = await collectPlanDateAggregate(db as any, "2026-10-17", "2026-10-17");
  assert.equal(result.planFunnel.settled.net_coverage_status, "PARTIAL");
  assert.deepEqual(db.calls.find(c => c.table === "night_event_reservations")!.filters, [["plan_date_minsk", "2026-10-17"]]);
  assert.deepEqual(db.calls.find(c => c.table === "event_execution_queue")!.filters, [["reservation_id", ["reservation-private"]]]);
  const ledger = db.calls.find(c => c.table === "bet_execution_ledger")!;
  assert.deepEqual(ledger.filters, [["exchange_order_id", ["order-private"]]]);
  assert.match(ledger.columns, /fee_status:raw_order->settlement_v1->reconciliation->>fee_status/);
  assert.doesNotMatch(ledger.columns, /(^|,)raw_order(,|$)|\*/);
  assert.doesNotMatch(JSON.stringify(result), /order-private|reservation-private|key-private/);
});

test("F: legacy snapshot never claims its historical sum is a complete realized total", () => {
  const legacy = { status: "AVAILABLE", count: 55, realized_pnl_usd: -9.26 };
  const markup = render(legacy);
  assert.match(markup, /UNKNOWN LEGACY COVERAGE/);
  assert.doesNotMatch(markup, /\$-?9\.26|Complete realized net P&amp;L: <b>/);
  assert.match(html, /fetch\("\/api\/founder\/modeling\/live", \{ cache: "no-store" \}\)/);
  assert.match(html, /renderLiveSettlement\(pf\.settled\)/);
});

function requestTimeRoute(reader: () => Promise<Record<string, unknown>>) {
  const source = readFileSync("app/api/founder/modeling/live/route.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "next/server") return { NextResponse };
      if (name === "@/lib/modeling/publicLiveSanitizer") return { sanitizePublicLive };
      if (name === "@/scripts/modeling/refresh-live-modeling-dashboard") return { readLiveModelingRuntime: reader };
      if (name === "@/lib/auth/founderModeling") return { PUBLIC_MODELING_HEADERS: {}, PUBLIC_MODELING_ERROR_HEADERS: {} };
      throw new Error("Unexpected route dependency: " + name);
    },
  });
  return exports.GET as () => Promise<Response>;
}

test("actual request-time GET serializes partial aggregate coverage through the public sanitizer", async () => {
  const db = fakeDb([row(1), row(null, "NOT_REPORTED")]);
  const aggregate = await collectPlanDateAggregate(db as any, "2026-10-17", "2026-10-17");
  const get = requestTimeRoute(async () => ({
    status: "OK", days: [aggregate], wallet: { balance: 100 }, exchange_order_id: "private-order",
  }));
  const response = await get();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.days[0].planFunnel.settled.net_coverage_status, "PARTIAL");
  assert.equal(payload.days[0].planFunnel.settled.realized_pnl_usd, null);
  assert.equal(payload.days[0].planFunnel.settled.known_net_pnl_usd, 1);
  assert.doesNotMatch(JSON.stringify(payload), /private-order|"wallet":|"balance":/);
});

test("actual request-time GET failure returns STOPPED instead of static money", async () => {
  const get = requestTimeRoute(async () => { throw new Error("Synthetic unavailable reader"); });
  const response = await get();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ARTIFACT: "LIVE_RUNTIME_DATA_V1", status: "STOPPED", stopReason: "RUNTIME_STOPPED", days: [] });
});
