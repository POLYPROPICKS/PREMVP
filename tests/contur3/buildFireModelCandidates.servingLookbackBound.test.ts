// MISSION regression: fetchContractAPlanningServingRowSets' scored
// current_signal_pair_serving query must carry the same PLANNING_LOOKBACK_HOURS
// (72h) lower bound the pre-cutover generated_signal_pairs scored query always
// applied.
//
// Before (778346c "serve Contract A from current pairs"): the scored serving
// query had no source_created_at lower bound, so the ordered scan covered the
// entire ACTIVE projection. Under 17:00 Minsk load this produced SQLSTATE
// 57014 (statement timeout) in production, which is why night-event-reservations
// returned HTTP 500 and (compounded by the separate job_runs.diagnostics
// NOT NULL defect) left zero job_runs evidence of any status since 2026-08-27.
//
// After: the scored query adds .gte("source_created_at", <snapshotAsOfIso -
// 72h>), pinned to the same snapshotAsOfIso the query's own expires_at upper
// bound already uses, restoring exact lookback parity with the legacy GSP path.
//
// Run: node --experimental-test-module-mocks --import tsx --test tests/contur3/buildFireModelCandidates.servingLookbackBound.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;
type Filter = { op: string; args: unknown[] };
type CallLog = { table: string; filters: Filter[]; selectCols: string | null };

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  let out = rows.slice();
  for (const f of filters) {
    switch (f.op) {
      case "in": {
        const [col, arr] = f.args as [string, unknown[]];
        out = out.filter((r) => arr.includes(r[col]));
        break;
      }
      case "is": {
        const [col, val] = f.args as [string, unknown];
        out = out.filter((r) => (r[col] ?? null) === val);
        break;
      }
      case "gt": {
        const [col, val] = f.args as [string, string];
        out = out.filter((r) => typeof r[col] === "string" && (r[col] as string) > val);
        break;
      }
      case "gte": {
        const [col, val] = f.args as [string, string | number];
        out = out.filter((r) => {
          const v = r[col];
          return v != null && (v as string | number) >= val;
        });
        break;
      }
      case "lte": {
        const [col, val] = f.args as [string, string | number];
        out = out.filter((r) => {
          const v = r[col];
          return v != null && (v as string | number) <= val;
        });
        break;
      }
      case "not": {
        const [col, op2, val] = f.args as [string, string, unknown];
        if (op2 === "is" && val === null) out = out.filter((r) => r[col] != null);
        break;
      }
      case "eq": {
        const [col, val] = f.args as [string, unknown];
        out = out.filter((r) => r[col] === val);
        break;
      }
      default:
        throw new Error(`unhandled fake-query filter op: ${f.op}`);
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeSupabaseAdmin(rows: Row[], callLog: CallLog[]) {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      const entry: CallLog = { table, filters, selectCols: null };
      callLog.push(entry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select(cols: string) {
          entry.selectCols = cols;
          return builder;
        },
        in(...args: unknown[]) { filters.push({ op: "in", args }); return builder; },
        is(...args: unknown[]) { filters.push({ op: "is", args }); return builder; },
        gt(...args: unknown[]) { filters.push({ op: "gt", args }); return builder; },
        gte(...args: unknown[]) { filters.push({ op: "gte", args }); return builder; },
        lte(...args: unknown[]) { filters.push({ op: "lte", args }); return builder; },
        not(...args: unknown[]) { filters.push({ op: "not", args }); return builder; },
        eq(...args: unknown[]) { filters.push({ op: "eq", args }); return builder; },
        order() { return builder; },
        limit(n: number) {
          const result = applyFilters(rows, filters);
          const response = { data: result.slice(0, n), error: null };
          return { ...response, abortSignal: (_signal: unknown) => Promise.resolve(response) };
        },
      };
      return builder;
    },
  };
}

const REAL_NOW_MS = Date.now();
const NOW_ISO = new Date(REAL_NOW_MS).toISOString();
const FUTURE_EXPIRES_ISO = new Date(REAL_NOW_MS + 6 * 3600_000).toISOString();

// 71 hours ago: inside the 72h lookback window -> must be admitted.
const RECENT_ROW_CREATED_ISO = new Date(REAL_NOW_MS - 71 * 3600_000).toISOString();
// 96 hours ago: outside the 72h lookback window -> must be excluded.
const STALE_ROW_CREATED_ISO = new Date(REAL_NOW_MS - 96 * 3600_000).toISOString();

function servingRow(suffix: string, sourceCreatedAtIso: string): Row {
  return {
    source_generated_signal_pair_id: `gsp-${suffix}`,
    condition_id: `condition-${suffix}`,
    selected_outcome: "A",
    selected_token_id: `token-${suffix}`,
    entry_price_num: 0.4,
    signal_confidence_num: 80,
    metric_formula_version: "v2-lite-growth-safe",
    market_slug: "Spain vs. Argentina - Moneyline",
    event_slug: "spain-vs-argentina-2026",
    source_created_at: sourceCreatedAtIso,
    expires_at: FUTURE_EXPIRES_ISO,
    signal_result: null,
    projection_status: "ACTIVE",
    // loadContractAPlanningSourceRows additionally requires
    // hasStructuredScoredSportAuthority(diagnostics) -- unrelated to the
    // lookback bound under test, so every fixture row satisfies it identically.
    diagnostics: {
      providerSportCode: "soccer",
      providerSportFamily: "soccer",
      providerEventId: `provider-event-${suffix}`,
      providerMarketId: `provider-market-${suffix}`,
      providerEventContext: {
        eventId: `provider-event-${suffix}`,
        eventStartIso: FUTURE_EXPIRES_ISO,
        providerMarketId: `provider-market-${suffix}`,
        sportFamily: "soccer",
        league: "soccer",
      },
    },
  };
}

test("scored serving query carries a 72h source_created_at lower bound", async (t) => {
  const recentRow = servingRow("recent", RECENT_ROW_CREATED_ISO);
  const staleRow = servingRow("stale", STALE_ROW_CREATED_ISO);
  const servingRows = [recentRow, staleRow];

  const callLog: CallLog[] = [];
  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: makeFakeSupabaseAdmin(servingRows, callLog) },
  });

  const { loadContractAPlanningSourceRows } = await import("../../lib/executor/buildFireModelCandidates");
  const result = await loadContractAPlanningSourceRows(REAL_NOW_MS);

  const scoredCall = callLog.find((c) => c.table === "current_signal_pair_serving");
  assert.ok(scoredCall, "the scored serving query must have been issued");

  // Invariant 1: the query itself carries the lower bound.
  const lookbackFilter = scoredCall!.filters.find(
    (f) => f.op === "gte" && f.args[0] === "source_created_at",
  );
  assert.ok(lookbackFilter, "scored serving query must filter on source_created_at >= <lookback>");
  const lookbackIso = lookbackFilter!.args[1] as string;
  const lookbackHours = (REAL_NOW_MS - Date.parse(lookbackIso)) / 3_600_000;
  assert.ok(
    Math.abs(lookbackHours - 72) < 0.01,
    `expected ~72h lookback, got ${lookbackHours}h (bound=${lookbackIso})`,
  );

  // Invariant 2: a row 96h old (outside the window) is excluded.
  assert.ok(
    !result.some((r) => r.condition_id === "condition-stale"),
    "a serving row older than 72h must be excluded from the planning read",
  );

  // Invariant 3: a row 71h old (inside the window) is admitted.
  assert.ok(
    result.some((r) => r.condition_id === "condition-recent"),
    "a serving row inside the 72h lookback must still be admitted",
  );

  // Invariant 4: every other proven scored predicate is unchanged.
  const filterOps = new Set(scoredCall!.filters.map((f) => `${f.op}:${f.args[0]}`));
  for (const expected of [
    "eq:projection_status",
    "in:metric_formula_version",
    "is:signal_result",
    "gt:expires_at",
    "not:selected_token_id",
    "not:condition_id",
    "not:entry_price_num",
    "gte:signal_confidence_num",
  ]) {
    assert.ok(filterOps.has(expected), `expected unchanged predicate ${expected} to still be present`);
  }
  const versionFilter = scoredCall!.filters.find((f) => f.op === "in" && f.args[0] === "metric_formula_version");
  assert.deepEqual(new Set(versionFilter!.args[1] as string[]), new Set(["v2-lite-growth-safe"]));
  const confidenceFilter = scoredCall!.filters.find((f) => f.op === "gte" && f.args[0] === "signal_confidence_num");
  assert.equal(confidenceFilter!.args[1], 50);

  // Invariant 5: no generated_signal_pairs table was ever queried by this path.
  assert.ok(
    !callLog.some((c) => c.table === "generated_signal_pairs"),
    "the money-authoritative serving read must never fall back to generated_signal_pairs",
  );
});
