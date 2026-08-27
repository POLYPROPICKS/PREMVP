// MISSION regression: restore the single production-selector boundary at the
// PREMVP Contract A Planning money boundary.
//
// Before: buildFireModelCandidates / loadContractAPlanningSourceRows admitted
// BOTH "v2-lite-growth-safe" and the research population
// "shadow-firemodel1_1_research_v0" into scored money Planning — a v2 candidate
// and a byte-identical research candidate were both visible to scored Planning
// (2026-08-26 Reservations: 2 v2 + 13 shadow-firemodel1_1_research_v0).
//
// After: scored Contract A Planning / Reservation consume exactly ONE explicitly
// selected production population (PRODUCTION_SIGNAL_POPULATION_VERSION =
// "v2-lite-growth-safe"). Research / challenger populations remain persisted and
// analysable but are not money-authoritative. shadow-strategic-sports-v1 (the
// score-null planning-shadow population) still cannot become scored money
// Planning. current_signal_pair_serving may still carry multiple populations —
// this changes the production READ authority, not the schema.
//
// Run: node --experimental-test-module-mocks --import tsx --test tests/contur3/buildFireModelCandidates.productionPopulationSelector.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRODUCTION_SIGNAL_POPULATION_VERSION,
  PRODUCTION_SCORED_PLANNING_VERSIONS,
} from "../../lib/executor/productionSignalPopulation";

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
const CREATED_AT_ISO = new Date(REAL_NOW_MS - 3_600_000).toISOString();
const FUTURE_START_ISO = new Date(REAL_NOW_MS + 6 * 3600_000).toISOString();

// A structured full-match soccer row that is otherwise identical regardless of
// metric_formula_version — so the ONLY thing separating "scored money Planning
// candidate" from "not money-authoritative" is the selected production
// population boundary under test.
function structuredRow(version: string, suffix: string, signalConfidenceNum: number | null): Row {
  return {
    id: `gsp-${suffix}`,
    source_generated_signal_pair_id: `gsp-${suffix}`,
    condition_id: `condition-${suffix}`,
    selected_outcome: "A",
    selected_token_id: `token-${suffix}`,
    entry_price_num: 0.4,
    signal_confidence_num: signalConfidenceNum,
    metric_formula_version: version,
    market_slug: "Spain vs. Argentina - Moneyline",
    event_slug: "spain-vs-argentina-2026",
    created_at: CREATED_AT_ISO,
    source_created_at: CREATED_AT_ISO,
    expires_at: FUTURE_START_ISO,
    signal_result: null,
    projection_status: "ACTIVE",
    diagnostics: {
      gameStartIso: FUTURE_START_ISO,
      dataCoverage: 60,
      providerSportCode: "soccer",
      providerSportFamily: "soccer",
      providerSportSource: "structured_sports_tag",
      providerEventId: `provider-event-${suffix}`,
      providerMarketId: `provider-market-${suffix}`,
      eventTitle: "Spain vs. Argentina",
      marketTitle: "Spain vs. Argentina - Moneyline",
      providerEventContext: {
        v: "v1",
        provider: "polymarket",
        eventId: `provider-event-${suffix}`,
        eventStartIso: FUTURE_START_ISO,
        providerMarketId: `provider-market-${suffix}`,
        marketType: "moneyline",
        sportFamily: "soccer",
        league: "soccer",
      },
    },
  };
}

test("the canonical production population authority is v2-lite-growth-safe only", () => {
  assert.equal(PRODUCTION_SIGNAL_POPULATION_VERSION, "v2-lite-growth-safe");
  assert.deepEqual([...PRODUCTION_SCORED_PLANNING_VERSIONS], ["v2-lite-growth-safe"]);
});

test("loadContractAPlanningSourceRows money read admits ONLY the selected production population", async (t) => {
  const v2Row = structuredRow("v2-lite-growth-safe", "v2", 80);
  const researchRow = structuredRow("shadow-firemodel1_1_research_v0", "research", 80);
  const shadowStrategicRow = structuredRow("shadow-strategic-sports-v1", "strategic", null);
  const servingRows = [v2Row, researchRow, shadowStrategicRow];

  const callLog: CallLog[] = [];
  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: makeFakeSupabaseAdmin(servingRows, callLog) },
  });

  const { loadContractAPlanningSourceRows } = await import("../../lib/executor/buildFireModelCandidates");
  const result = await loadContractAPlanningSourceRows(REAL_NOW_MS);

  // The scored money read filters metric_formula_version to exactly the one
  // selected production population.
  const scoredCall = callLog.find((c) => c.filters.some((f) => f.op === "gte" && f.args[0] === "signal_confidence_num"));
  assert.ok(scoredCall, "a scored money read must have been issued");
  assert.equal(scoredCall!.table, "current_signal_pair_serving");
  const scoredVersions = scoredCall!.filters.find((f) => f.op === "in" && f.args[0] === "metric_formula_version")!.args[1] as string[];
  assert.deepEqual(new Set(scoredVersions), new Set(["v2-lite-growth-safe"]));

  // Only the v2 row reaches Contract A Planning. The research row is byte
  // identical except for its version — it is not money-authoritative.
  assert.equal(result.length, 1);
  assert.equal(result[0].metric_formula_version, "v2-lite-growth-safe");
  assert.equal(result[0].condition_id, "condition-v2");
  assert.ok(!result.some((r) => r.metric_formula_version === "shadow-firemodel1_1_research_v0"));
  assert.ok(!result.some((r) => r.metric_formula_version === "shadow-strategic-sports-v1"));

  // Persistence / analysis is untouched: the research row is still present in
  // current_signal_pair_serving — it is excluded from the money read purely by
  // the production-population predicate, nothing deletes or rewrites it.
  assert.ok(servingRows.some((r) => r.metric_formula_version === "shadow-firemodel1_1_research_v0"));
  const withoutVersionPredicate = applyFilters(
    servingRows,
    scoredCall!.filters.filter((f) => !(f.op === "in" && f.args[0] === "metric_formula_version")),
  );
  assert.ok(
    withoutVersionPredicate.some((r) => r.metric_formula_version === "shadow-firemodel1_1_research_v0"),
    "the research row satisfies every money-read predicate EXCEPT the production-population selector",
  );
});

test("DIRECT REGRESSION: a v2 candidate and a byte-identical research candidate — only v2 is scored money Planning", async (t) => {
  const v2Row = structuredRow("v2-lite-growth-safe", "v2", 80);
  const researchRow = structuredRow("shadow-firemodel1_1_research_v0", "research", 80);
  const mislabeledStrategicRow = structuredRow("shadow-strategic-sports-v1", "strategic", 80);

  const callLog: CallLog[] = [];
  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: makeFakeSupabaseAdmin([], callLog) },
  });

  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");
  const { candidates, rawDiagnostics } = await buildFireModelCandidates(
    1000,
    "all",
    true,
    [v2Row, researchRow, mislabeledStrategicRow],
    "CONTRACT_A_PLANNING_V1",
    REAL_NOW_MS,
  );

  // v2 candidate -> production Planning.
  assert.equal(candidates.length, 1, "exactly one scored money Planning candidate");
  assert.equal(candidates[0].condition_id, "condition-v2");
  assert.equal(candidates[0].strategic_scope, "SOCCER");

  // research candidate -> not production Planning.
  assert.ok(
    !candidates.some((c) => c.condition_id === "condition-research"),
    "shadow-firemodel1_1_research_v0 must not enter scored money Planning",
  );
  // shadow-strategic can never acquire scored money eligibility, even mislabeled
  // with signal_confidence_num >= 50.
  assert.ok(
    !candidates.some((c) => c.condition_id === "condition-strategic"),
    "shadow-strategic-sports-v1 must not become scored money Planning",
  );

  assert.deepEqual(rawDiagnostics?.versions_queried, ["v2-lite-growth-safe"]);
  assert.equal(
    rawDiagnostics?.source_counts_by_formula_version["shadow-firemodel1_1_research_v0"],
    undefined,
    "the research population is never merged into the scored planning universe",
  );
});
