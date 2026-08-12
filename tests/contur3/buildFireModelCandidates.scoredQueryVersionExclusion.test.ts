// R4 regression: fetchPlanningSourceRowSets' scored-row query must never
// include "shadow-strategic-sports-v1" in its metric_formula_version IN-list.
//
// Root cause this proves fixed: shadow-strategic-sports-v1 rows are written
// with signal_confidence_num IS NULL by construction (they are exactly the
// not-yet-scored population the separate shadow query exists to read), so
// they can never satisfy signal_confidence_num >= 50. Including that version
// in the scored query's IN-list contributed zero eligible rows in every
// environment, but forced a created_at-ordered scan through the live table's
// large shadow-strategic-sports-v1 population, reproducing as a Postgres
// 57014 statement timeout in loadContractAPlanningSourceRows /
// planning_scored_rows_fetch (npm run contur3:forward-funnel-report).
//
// Run: node --experimental-test-module-mocks --import tsx --test tests/contur3/buildFireModelCandidates.scoredQueryVersionExclusion.test.ts

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

// Relative to actual test-execution time (fetchPlanningSourceRowSets calls a
// real, unmocked `new Date()` internally for its snapshot bound), never a
// hardcoded absolute date -- so this test cannot flake against wall-clock time.
const REAL_NOW_MS = Date.now();
const LOOKBACK_ISO = new Date(REAL_NOW_MS - 72 * 3600_000).toISOString();
const ROW_CREATED_AT_ISO = new Date(REAL_NOW_MS - 3_600_000).toISOString();
const FUTURE_EXPIRES_ISO = new Date(REAL_NOW_MS + 24 * 3600_000).toISOString();

function scoredRow(): Row {
  return {
    id: "scored-row-1",
    condition_id: "cond-1",
    selected_outcome: "Team A",
    selected_token_id: "tok-1",
    entry_price_num: 0.4,
    signal_confidence_num: 80,
    metric_formula_version: "v2-lite-growth-safe",
    created_at: ROW_CREATED_AT_ISO,
    expires_at: FUTURE_EXPIRES_ISO,
    signal_result: null,
    diagnostics: {},
    projection_status: "ACTIVE",
    source_generated_signal_pair_id: "scored-row-1",
    source_created_at: ROW_CREATED_AT_ISO,
  };
}

// Structurally cannot appear in scored results: this is the exact real-world
// shape (signal_confidence_num IS NULL) that caused the production timeout
// when the scored query's IN-list still included this version.
function unscoreable_shadow_strategic_v1_row(): Row {
  return {
    id: "shadow-row-1",
    condition_id: "cond-2",
    selected_outcome: "Team B",
    selected_token_id: "tok-2",
    entry_price_num: 0.5,
    signal_confidence_num: null,
    metric_formula_version: "shadow-strategic-sports-v1",
    created_at: ROW_CREATED_AT_ISO,
    expires_at: FUTURE_EXPIRES_ISO,
    signal_result: null,
    diagnostics: {},
    projection_status: "ACTIVE",
    source_generated_signal_pair_id: "shadow-row-1",
    source_created_at: ROW_CREATED_AT_ISO,
  };
}

test("R4: the scored-rows query never includes shadow-strategic-sports-v1 in its metric_formula_version IN-list", async (t) => {
  const callLog: CallLog[] = [];
  const rows = [scoredRow(), unscoreable_shadow_strategic_v1_row()];
  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: makeFakeSupabaseAdmin(rows, callLog) },
  });

  const { fetchPlanningSourceRowSets } = await import("../../lib/executor/buildFireModelCandidates");
  const { scoredRows, planningShadowRows } = await fetchPlanningSourceRowSets(
    true,
    ["shadow-strategic-sports-v1", "v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"],
    LOOKBACK_ISO
  );

  // Old query shape is gone: find the scored-query call (the one filtering on
  // signal_confidence_num via .gte) and assert its IN-list excludes the
  // structurally-unmatchable shadow version.
  const scoredCall = callLog.find((c) => c.filters.some((f) => f.op === "gte" && f.args[0] === "signal_confidence_num"));
  assert.ok(scoredCall, "a scored-rows query (gte signal_confidence_num) must have been issued");
  const scoredInFilter = scoredCall!.filters.find((f) => f.op === "in" && f.args[0] === "metric_formula_version");
  assert.ok(scoredInFilter, "the scored query must filter by metric_formula_version");
  const scoredVersions = scoredInFilter!.args[1] as string[];
  assert.ok(
    !scoredVersions.includes("shadow-strategic-sports-v1"),
    "shadow-strategic-sports-v1 must never appear in the scored query's version IN-list (it can never satisfy signal_confidence_num >= 50)"
  );
  assert.deepEqual(
    new Set(scoredVersions),
    new Set(["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"]),
    "the scored query must still cover every other planning-recognized version unchanged"
  );

  // Corrected loader returns the same eligible source semantics: the real
  // scored row is present, the structurally-unmatchable shadow row is absent
  // from scoredRows but still reachable via the (unchanged) shadow branch.
  assert.equal(scoredRows.length, 1);
  assert.equal(scoredRows[0].id, "scored-row-1");
  assert.equal(planningShadowRows.length, 1, "the shadow branch is untouched and still returns the shadow-eligible row");
  assert.equal(planningShadowRows[0].id, "shadow-row-1");

  // The shadow query itself must still target shadow-strategic-sports-v1
  // directly (unchanged) -- proving the fix is scoped to the scored query only.
  const shadowCall = callLog.find((c) => c.filters.some((f) => f.op === "is" && f.args[0] === "signal_confidence_num" && f.args[1] === null));
  assert.ok(shadowCall, "a shadow-rows query (is signal_confidence_num null) must have been issued");
  const shadowEqFilter = shadowCall!.filters.find((f) => f.op === "eq" && f.args[0] === "metric_formula_version");
  assert.equal(shadowEqFilter!.args[1], "shadow-strategic-sports-v1");
});

test("R4: Contract A source loader reads the bounded serving projection and excludes the structurally-unmatchable shadow version", async (t) => {
  const callLog: CallLog[] = [];
  const rows = [scoredRow(), unscoreable_shadow_strategic_v1_row()];
  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: makeFakeSupabaseAdmin(rows, callLog) },
  });

  const { loadContractAPlanningSourceRows } = await import("../../lib/executor/buildFireModelCandidates");
  const result = await loadContractAPlanningSourceRows(REAL_NOW_MS);

  assert.ok(callLog.every((call) => call.table === "current_signal_pair_serving"), "Contract A must not read generated_signal_pairs");
  const scoredCall = callLog.find((c) => c.filters.some((f) => f.op === "gte" && f.args[0] === "signal_confidence_num"));
  const scoredVersions = (scoredCall!.filters.find((f) => f.op === "in" && f.args[0] === "metric_formula_version")!.args[1]) as string[];
  assert.ok(!scoredVersions.includes("shadow-strategic-sports-v1"));

  // loadContractAPlanningSourceRows additionally applies hasStructuredScoredSportAuthority,
  // which the fixture's empty diagnostics fails -- so the eligible-row count
  // here is 0, but the important, proven invariant is the query shape above:
  // no shadow-strategic-sports-v1 row is ever fetched into this path at all.
  assert.equal(result.length, 0);
});

test("R4: CONTRACT_A_PLANNING_V1 reads scored and shadow current-serving sets without keyset pagination", async (t) => {
  const callLog: CallLog[] = [];
  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: makeFakeSupabaseAdmin([scoredRow(), unscoreable_shadow_strategic_v1_row()], callLog) },
  });
  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");
  await buildFireModelCandidates(1000, "all", true, undefined, "CONTRACT_A_PLANNING_V1", REAL_NOW_MS);

  assert.equal(callLog.length, 2, "one bounded query each for scored and shadow serving sets");
  assert.ok(callLog.every((call) => call.table === "current_signal_pair_serving"));
  assert.ok(callLog.every((call) => call.selectCols?.includes("source_generated_signal_pair_id")));
});
