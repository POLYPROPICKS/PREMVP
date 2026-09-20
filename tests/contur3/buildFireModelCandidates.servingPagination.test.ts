// CONTRACT_A_SERVING_COMPLETE_PAGINATION_V1: the Contract A Planning serving
// read must consume the whole bounded snapshot across keyset pages even when
// the transport caps every response (production: 1000 rows) below the page
// size the client asked for, and must fail closed rather than truncate.
//
// Run: node --experimental-test-module-mocks --import tsx --test tests/contur3/buildFireModelCandidates.servingPagination.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;
type Filter = { op: string; args: unknown[] };

const NOW_MS = Date.now();
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  let out = rows.slice();
  for (const f of filters) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [col, val] = f.args as [string, any];
    switch (f.op) {
      case "in": out = out.filter((r) => (val as unknown[]).includes(r[col])); break;
      case "is": out = out.filter((r) => (r[col] ?? null) === val); break;
      case "gt": out = out.filter((r) => typeof r[col] === "string" && (r[col] as string) > val); break;
      case "gte": out = out.filter((r) => r[col] != null && (r[col] as string | number) >= val); break;
      case "lte": out = out.filter((r) => r[col] != null && (r[col] as string | number) <= val); break;
      case "eq": out = out.filter((r) => r[col] === val); break;
      case "not": out = out.filter((r) => r[col] != null); break;
      case "cursor": {
        const c = f.args[0] as { createdAt: string; id: string };
        out = out.filter((r) => {
          const t = r.source_created_at as string;
          const id = r.observation_id as string;
          return t < c.createdAt || (t === c.createdAt && id < c.id);
        });
        break;
      }
      default: throw new Error(`unhandled op ${f.op}`);
    }
  }
  return out;
}

function fakeAdmin(rows: Row[], transportCap: number, stats: { requests: number; limits: number[] }) {
  return {
    from() {
      const filters: Filter[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select() { return b; },
        in(...a: unknown[]) { filters.push({ op: "in", args: a }); return b; },
        is(...a: unknown[]) { filters.push({ op: "is", args: a }); return b; },
        gt(...a: unknown[]) { filters.push({ op: "gt", args: a }); return b; },
        gte(...a: unknown[]) { filters.push({ op: "gte", args: a }); return b; },
        lte(...a: unknown[]) { filters.push({ op: "lte", args: a }); return b; },
        not(...a: unknown[]) { filters.push({ op: "not", args: a }); return b; },
        eq(...a: unknown[]) { filters.push({ op: "eq", args: a }); return b; },
        or(expr: string) {
          const m = /source_created_at\.lt\.([^,]+),and\(source_created_at\.eq\.([^,]+),observation_id\.lt\.([^)]+)\)/.exec(expr);
          if (!m) throw new Error(`unhandled or(): ${expr}`);
          filters.push({ op: "cursor", args: [{ createdAt: m[1], id: m[3] }] });
          return b;
        },
        order() { return b; },
        limit(n: number) {
          stats.requests += 1;
          stats.limits.push(n);
          const sorted = applyFilters(rows, filters).sort((x, y) =>
            x.source_created_at === y.source_created_at
              ? String(y.observation_id).localeCompare(String(x.observation_id))
              : String(y.source_created_at).localeCompare(String(x.source_created_at)));
          const response = { data: sorted.slice(0, Math.min(n, transportCap)), error: null };
          return { ...response, abortSignal: () => Promise.resolve(response) };
        },
      };
      return b;
    },
  };
}

function row(id: string, createdIso: string, over: Row = {}): Row {
  return {
    observation_id: id,
    source_generated_signal_pair_id: `gsp-${id}`,
    condition_id: `cond-${id}`,
    selected_outcome: "A",
    selected_token_id: `tok-${id}`,
    entry_price_num: 0.6,
    signal_confidence_num: 80,
    metric_formula_version: "v2-lite-growth-safe",
    market_slug: "m",
    event_slug: "e",
    source_created_at: createdIso,
    expires_at: iso(-6 * H),
    signal_result: null,
    projection_status: "ACTIVE",
    diagnostics: {
      providerSportCode: "soccer",
      providerSportFamily: "soccer",
      providerEventId: `pe-${id}`,
      providerMarketId: `pm-${id}`,
      providerEventContext: {
        eventId: `pe-${id}`, eventStartIso: iso(-6 * H), providerMarketId: `pm-${id}`,
        sportFamily: "soccer", league: "soccer",
      },
    },
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(t: any, rows: Row[], transportCap = 1000) {
  const stats = { requests: 0, limits: [] as number[] };
  t.mock.module("../../lib/supabase/server", { namedExports: { supabaseAdmin: fakeAdmin(rows, transportCap, stats) } });
  const { loadContractAPlanningSourceRows } = await import("../../lib/executor/buildFireModelCandidates");
  return { stats, result: await loadContractAPlanningSourceRows(NOW_MS) };
}

// 1 + 2: >1000 qualifying rows, transport returns max 1000; the only identity of
// one physical event is beyond page 1 and must still be present.
test("complete read across pages when transport caps at 1000; deep-page event survives", async (t) => {
  const rows: Row[] = [];
  for (let i = 0; i < 2500; i++) rows.push(row(`r${String(i).padStart(5, "0")}`, iso(60_000 + i * 1000)));
  const deep = rows[2499]; // oldest -> last page
  const { result, stats } = await load(t, rows);
  assert.equal(result.length, 2500);
  assert.equal(new Set(result.map((r) => r.observation_id)).size, 2500, "no duplicates");
  assert.ok(result.some((r) => r.condition_id === deep.condition_id), "event only present beyond page 1 is kept");
  assert.ok(stats.requests >= 3, "multiple pages were requested");
  assert.ok(stats.limits.every((n) => n <= 1000), "no request asks for more than the transport cap");
});

// The transport may cap BELOW the requested page size; completion must not
// be inferred from a short page.
test("completion is cursor exhaustion, not a short page (transport cap 300 < page size)", async (t) => {
  const rows: Row[] = [];
  for (let i = 0; i < 1000; i++) rows.push(row(`s${String(i).padStart(5, "0")}`, iso(60_000 + i * 1000)));
  const { result } = await load(t, rows, 300);
  assert.equal(result.length, 1000);
});

// 3: identical source_created_at across page boundaries: no loss, no dupes.
test("same source_created_at across a page boundary loses and duplicates nothing", async (t) => {
  const sameTs = iso(2 * H);
  const rows: Row[] = [];
  for (let i = 0; i < 2100; i++) rows.push(row(`t${String(i).padStart(5, "0")}`, sameTs));
  const { result } = await load(t, rows, 1000);
  assert.equal(result.length, 2100);
  assert.equal(new Set(result.map((r) => r.observation_id)).size, 2100);
});

// 4 + 5 + 6: snapshot upper bound, 72h lower bound, expires_at not a gate.
test("rows after the frozen snapshot and older than 72h are excluded; expired in-window rows admitted", async (t) => {
  const rows = [
    row("in-window", iso(2 * H)),
    row("expired-in-window", iso(3 * H), { expires_at: iso(H) }),
    row("after-snapshot", new Date(NOW_MS + 5 * 60_000).toISOString()),
    row("too-old", iso(73 * H)),
  ];
  const { result } = await load(t, rows);
  assert.deepEqual(new Set(result.map((r) => r.observation_id)), new Set(["in-window", "expired-in-window"]));
});

// 8: structured sport authority still applied after pagination (unchanged).
test("structured event/sport authority filter is unchanged after pagination", async (t) => {
  const rows = [row("ok", iso(2 * H)), row("no-authority", iso(3 * H), { diagnostics: {} })];
  const { result } = await load(t, rows);
  assert.deepEqual(result.map((r) => r.observation_id), ["ok"]);
});

// 9: the safety ceiling (200_000 rows) fails closed. The fake never exhausts:
// it always returns a full, strictly descending page.
test("safety ceiling fails closed instead of returning partial data", async (t) => {
  let n = 0;
  const infinite = {
    from() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {};
      for (const k of ["select", "in", "is", "gt", "gte", "lte", "not", "eq", "or", "order"]) b[k] = () => b;
      b.limit = (size: number) => {
        const data = Array.from({ length: size }, () => {
          n += 1;
          return row(`z${String(9_999_999 - n).padStart(8, "0")}`, new Date(NOW_MS - 60_000 - n).toISOString());
        });
        const response = { data, error: null };
        return { ...response, abortSignal: () => Promise.resolve(response) };
      };
      return b;
    },
  };
  t.mock.module("../../lib/supabase/server", { namedExports: { supabaseAdmin: infinite } });
  const { loadContractAPlanningSourceRows } = await import("../../lib/executor/buildFireModelCandidates");
  await assert.rejects(() => loadContractAPlanningSourceRows(NOW_MS), /exceeded planning fetch ceiling/);
});
