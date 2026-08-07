// REAL LOADER-TO-MODEL BOUNDARY (2026-08 correction):
//   node --experimental-test-module-mocks --import tsx --test tests/contur3/*.test.ts
//
// The proven blocker: every prior structured-sport test (see
// buildFireModelCandidates.expandedSportsScope.test.ts) injects rows via the
// `injectedRows` seam, which sits AFTER the real generated_signal_pairs
// Supabase query. No test proved that a production-shaped row read through
// the actual query in lib/executor/buildFireModelCandidates.ts carries
// diagnostics.providerSportCode through to the model.
//
// This suite calls the real, public buildFireModelCandidates() with
// injectedRows OMITTED -- the exact call shape the night-plan route uses --
// and replaces only the external boundary (@/lib/supabase/server's
// supabaseAdmin) with an in-memory fake query engine that applies the SAME
// filter predicates the production query chain builds (.in/.is/.gt/.not/
// .gte/.eq/.order/.range), so the fake is a faithful stand-in for Postgres,
// not a bypass of the query. Everything from query construction through
// diagnostics parsing, sport normalization, and the existing model gates
// runs as real, unmocked production code.

import { test } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;
type Filter = { op: string; args: unknown[] };

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
        if (op2 === "is" && val === null) {
          out = out.filter((r) => r[col] != null);
        }
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
function makeFakeSupabaseAdmin(rows: Row[], selectCalls: string[]) {
  return {
    from(table: string) {
      assert.equal(table, "generated_signal_pairs", "the loader must query generated_signal_pairs");
      const filters: Filter[] = [];
      let orderCol: string | null = null;
      let orderAscending = true;
      let rangeFrom = 0;
      let rangeTo = Number.MAX_SAFE_INTEGER;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select(cols: string) {
          selectCalls.push(cols);
          return builder;
        },
        in(...args: unknown[]) {
          filters.push({ op: "in", args });
          return builder;
        },
        is(...args: unknown[]) {
          filters.push({ op: "is", args });
          return builder;
        },
        gt(...args: unknown[]) {
          filters.push({ op: "gt", args });
          return builder;
        },
        gte(...args: unknown[]) {
          filters.push({ op: "gte", args });
          return builder;
        },
        lte(...args: unknown[]) {
          filters.push({ op: "lte", args });
          return builder;
        },
        not(...args: unknown[]) {
          filters.push({ op: "not", args });
          return builder;
        },
        eq(...args: unknown[]) {
          filters.push({ op: "eq", args });
          return builder;
        },
        order(col: string, opts: { ascending: boolean }) {
          orderCol = col;
          orderAscending = opts.ascending;
          return builder;
        },
        limit(n: number) {
          let result = applyFilters(rows, filters);
          if (orderCol) result = sortByCol(result, orderCol, orderAscending);
          return { abortSignal: (_signal: unknown) => Promise.resolve({ data: result.slice(0, n), error: null }) };
        },
        range(from: number, to: number) {
          rangeFrom = from;
          rangeTo = to;
          return builder;
        },
        abortSignal(_signal: unknown) {
          let result = applyFilters(rows, filters);
          if (orderCol) result = sortByCol(result, orderCol, orderAscending);
          return Promise.resolve({ data: result.slice(rangeFrom, rangeTo + 1), error: null });
        },
      };
      return builder;
    },
  };
}

function sortByCol(rows: Row[], col: string, ascending: boolean): Row[] {
  return rows.slice().sort((a, b) => {
    const av = String(a[col] ?? "");
    const bv = String(b[col] ?? "");
    return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
  });
}

const NOW_ISO = "2026-08-01T17:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const FUTURE_START_ISO = "2026-08-02T21:00:00.000Z";
const CREATED_AT_ISO = "2026-08-01T16:00:00.000Z";

async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class SnapshotDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(value?: any) {
      super(value ?? ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = SnapshotDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// A production-shaped generated_signal_pairs row: a real scored row
// (signal_confidence_num present, metric_formula_version in the allowed set),
// structured provider-sport metadata, and misleading MLB team-name text in
// both the market question and event title -- so a naive text classifier
// would call this MLB, while diagnostics.providerSportCode says nba.
function productionShapedRow(): Row {
  return {
    id: "gsp-row-uuid-0001",
    condition_id: "cond-nba-yankees-redsox",
    selected_outcome: "Team Alpha",
    selected_token_id: "tok-nba-yankees-redsox-alpha",
    entry_price_num: 0.3,
    signal_confidence_num: 80,
    smart_money_score_num: null,
    market_slug: "New York Yankees vs. Boston Red Sox - Moneyline",
    event_slug: "nba-yankees-redsox-2026-08-02",
    metric_formula_version: "v2-lite-growth-safe",
    created_at: CREATED_AT_ISO,
    expires_at: FUTURE_START_ISO,
    signal_result: null,
    diagnostics: {
      providerSportCode: "nba",
      providerSportSource: "sports-tag",
      providerEventId: "provider-event-0001",
      providerMarketId: "provider-market-0001",
      gameId: "provider-game-0001",
      gameStartIso: FUTURE_START_ISO,
      dataCoverage: 60,
      eventTitle: "New York Yankees vs. Boston Red Sox",
      marketTitle: "New York Yankees vs. Boston Red Sox - Moneyline",
    },
  };
}

test("REAL LOADER BOUNDARY: a production-shaped generated_signal_pairs row read through the actual Supabase query carries diagnostics.providerSportCode to the model and wins over misleading MLB market text", async (t) => {
  const row = productionShapedRow();
  const selectCalls: string[] = [];
  const fakeSupabaseAdmin = makeFakeSupabaseAdmin([row], selectCalls);

  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: fakeSupabaseAdmin },
  });

  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");

  const { candidates, rawDiagnostics } = await at(NOW_MS, () =>
    // injectedRows (4th arg) deliberately OMITTED: this is the real
    // generated_signal_pairs query path, not the injected-row seam.
    buildFireModelCandidates(1000, "all", true)
  );

  // 1. the actual query includes diagnostics.
  assert.ok(selectCalls.length > 0, "the loader must have issued at least one select()");
  for (const cols of selectCalls) {
    assert.match(cols, /\bdiagnostics\b/, "every generated_signal_pairs select must include diagnostics");
  }

  // 2 + 3 + 4. the returned diagnostics reaches sport resolution and
  // providerSportCode="nba" wins over misleading MLB market text -> BASKETBALL.
  assert.equal(candidates.length, 1, "the production-shaped row must reach the model and become a candidate");
  const candidate = candidates[0];
  assert.equal(candidate.strategic_scope, "BASKETBALL", "providerSportCode=nba must win over MLB-shaped team-name text");
  assert.equal(candidate.diagnostics.provider_sport_code, "nba");
  assert.equal(candidate.diagnostics.provider_sport_source, "sports-tag");

  // 5. legacy text fallback is not used.
  assert.equal(candidate.diagnostics.legacy_text_fallback_used, false);
  assert.equal(rawDiagnostics?.rows_using_legacy_text_fallback, 0);

  // 6. source row ID, event ID, market ID, exact start, condition, token,
  // outcome and price survive -- read directly from the candidate/model
  // output, not reconstructed by the test.
  assert.equal(candidate.generated_signal_pair_id, "gsp-row-uuid-0001", "source generated_signal_pairs row id must survive");
  assert.equal(candidate.signal_id, "gsp-row-uuid-0001");
  assert.equal(candidate.diagnostics.provider_event_id, "provider-event-0001");
  assert.equal(candidate.diagnostics.provider_market_id, "provider-market-0001");
  assert.equal(candidate.diagnostics.game_start_iso, FUTURE_START_ISO, "exact event start must survive verbatim");
  assert.equal(candidate.condition_id, "cond-nba-yankees-redsox");
  assert.equal(candidate.token_id, "tok-nba-yankees-redsox-alpha");
  assert.equal(candidate.selected_outcome, "Team Alpha");
  assert.equal(candidate.diagnostics.entry_price, 0.3, "observed entry price must survive verbatim");

  // 7. candidate/rejection is produced by the existing downstream model gates
  // (identity, market policy, tier/score/coverage), not by a helper-only call:
  // the candidate carries the real upstream market-policy verdict and a real
  // computed tier, both derived fields the model gates alone can produce.
  assert.equal(candidate.strategy, "TIER1_CORE_STRICT_72_COV50");
  assert.ok(candidate.diagnostics.market_policy, "candidate must carry the real upstream market-policy verdict");
  assert.equal(candidate.diagnostics.market_policy?.allowed, true);
});

test("REAL LOADER BOUNDARY: a row with no structured provider sport and no shadowScope still reaches the model and rejects UNKNOWN_SCOPE via the real query path", async (t) => {
  const row: Row = {
    id: "gsp-row-uuid-0002",
    condition_id: "cond-no-sport-meta",
    selected_outcome: "Team A",
    selected_token_id: "tok-no-sport-meta",
    entry_price_num: 0.4,
    signal_confidence_num: 75,
    smart_money_score_num: null,
    market_slug: "Team Alpha vs. Team Beta - Moneyline",
    event_slug: "unlabeled-alpha-vs-beta-2026-08-02",
    metric_formula_version: "v2-lite-growth-safe",
    created_at: CREATED_AT_ISO,
    expires_at: FUTURE_START_ISO,
    signal_result: null,
    diagnostics: {
      gameStartIso: FUTURE_START_ISO,
      dataCoverage: 60,
    },
  };
  const selectCalls: string[] = [];
  t.mock.module("../../lib/supabase/server", {
    namedExports: { supabaseAdmin: makeFakeSupabaseAdmin([row], selectCalls) },
  });
  const { buildFireModelCandidates } = await import("../../lib/executor/buildFireModelCandidates");

  const { candidates, rawDiagnostics } = await at(NOW_MS, () => buildFireModelCandidates(1000, "all", true));

  assert.equal(candidates.length, 0, "unrecognizable sport metadata must stay fail-closed even through the real query path");
  assert.ok((rawDiagnostics?.rejected_before_planning_by_reason ?? {}).UNKNOWN_SCOPE >= 1);
});
