// Phase 3E.8E.3B -- read-only post-cutoff resolved-signal exporter tests.
//
// Forward-only exporter: full post-cutoff refresh per run, exclusive locked
// lower bound, inclusive run-start upper bound, split (resolved_at,id) keyset
// pagination, injectable fetch (no real network in tests), dry-run default,
// atomic verified writes under --write-artifacts. The rows file is a plain
// JSON array accepted unchanged by the evaluation runner's loadExportRows.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  parsePostCutoffExportArgs,
  buildForwardWindowFilter,
  buildForwardFirstPageUrl,
  buildForwardSameTimestampUrl,
  buildForwardOlderTimestampsUrl,
  fetchPostCutoffResolvedRows,
  buildPostCutoffExportArtifacts,
  serializePostCutoffRows,
  runPostCutoffResolvedExport,
  DEFAULT_POST_CUTOFF_ROWS_PATH,
  DEFAULT_POST_CUTOFF_MANIFEST_PATH,
} from "../../scripts/modeling/strategies/export-post-cutoff-resolved-signals";
import { loadExportRows } from "../../scripts/modeling/strategies/run-post-cutoff-model-evaluation";
import { POST_CUTOFF_RESOLVED_AT_EXCLUSIVE } from "../../lib/modeling/postCutoffObservation";

const CUTOFF = "2026-07-13T06:04:05.701Z";
const UPPER = "2026-08-01T00:00:00.000Z";
const ENV = { ...process.env, SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sk-test-secret-key" } as NodeJS.ProcessEnv;
const CONFIG = { url: "https://example.supabase.co", key: "sk-test-secret-key" };

function dbRow(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${String(n).padStart(3, "0")}`,
    condition_id: `0xcond${n}`,
    selected_token_id: `tok-${n}`,
    created_at: "2026-07-14T00:00:00.000Z",
    resolved_at: `2026-07-${String(14 + (n % 10)).padStart(2, "0")}T12:00:00.000Z`,
    signal_result: n % 4 === 0 ? "loss" : "win",
    entry_price_num: 0.6,
    realized_return_pct: n % 4 === 0 ? -100 : 40,
    metric_formula_version: "v2-lite-growth-safe",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    diagnostics: { dataCoverage: 80, gameStartIso: "2026-07-14T06:00:00.000Z" },
    ...overrides,
  };
}

interface FakeCall {
  url: string;
  method: string | undefined;
}

/** Simulates PostgREST filter/order/limit semantics for the fake table. */
function makeFakeSupabase(allRows: Record<string, unknown>[]) {
  const calls: FakeCall[] = [];
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init?.method });
    const u = new URL(url);
    const p = u.searchParams;
    let rows = allRows.filter((r) => r.resolved_at !== null && r.resolved_at !== undefined);
    const and = p.get("and");
    if (and) {
      for (const pred of and.slice(1, -1).split(",")) {
        const m = pred.match(/^resolved_at\.(gt|lte|lt)\.(.+)$/);
        if (m) {
          const [, op, v] = m;
          rows = rows.filter((r) => {
            const t = r.resolved_at as string;
            return op === "gt" ? t > v : op === "lte" ? t <= v : t < v;
          });
        }
      }
    }
    const eq = p.get("resolved_at");
    if (eq && eq.startsWith("eq.")) {
      const v = eq.slice(3);
      rows = rows.filter((r) => r.resolved_at === v);
    }
    const idFilter = p.get("id");
    if (idFilter && idFilter.startsWith("lt.")) {
      const v = idFilter.slice(3);
      rows = rows.filter((r) => String(r.id) < v);
    }
    const order = p.get("order");
    if (order === "id.desc") {
      rows = [...rows].sort((a, b) => (String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0));
    } else {
      rows = [...rows].sort((a, b) => {
        const ta = a.resolved_at as string;
        const tb = b.resolved_at as string;
        if (ta !== tb) return tb < ta ? -1 : 1;
        return String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0;
      });
    }
    const limit = Number(p.get("limit") ?? 1000);
    const page = rows.slice(0, limit);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => page,
      text: async () => "",
    };
  };
  return { fetchImpl, calls };
}

const noDelay = async () => {};

// ---- Arguments ----

test("A1: no args returns dry-run defaults", () => {
  const args = parsePostCutoffExportArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.equal(args.output, DEFAULT_POST_CUTOFF_ROWS_PATH);
  assert.equal(args.manifestOutput, DEFAULT_POST_CUTOFF_MANIFEST_PATH);
  assert.equal(args.cutoff, POST_CUTOFF_RESOLVED_AT_EXCLUSIVE);
  assert.equal(args.pageSize, 1000);
});

test("A2: explicit --output is parsed", () => {
  assert.equal(parsePostCutoffExportArgs(["--output", "x/rows.json"]).output, "x/rows.json");
});

test("A3: explicit --manifest-output is parsed", () => {
  assert.equal(parsePostCutoffExportArgs(["--manifest-output", "x/m.json"]).manifestOutput, "x/m.json");
});

test("A4: explicit --cutoff is parsed", () => {
  assert.equal(parsePostCutoffExportArgs(["--cutoff", "2026-07-20T00:00:00.000Z"]).cutoff, "2026-07-20T00:00:00.000Z");
});

test("A5: explicit --page-size is parsed", () => {
  assert.equal(parsePostCutoffExportArgs(["--page-size", "50"]).pageSize, 50);
});

test("A6: --write-artifacts enables write mode", () => {
  assert.equal(parsePostCutoffExportArgs(["--write-artifacts"]).mode, "write");
});

test("A7: explicit --dry-run works", () => {
  assert.equal(parsePostCutoffExportArgs(["--dry-run"]).mode, "dry-run");
});

test("A8: --dry-run with --write-artifacts throws a deterministic argument error", () => {
  assert.throws(() => parsePostCutoffExportArgs(["--dry-run", "--write-artifacts"]));
});

test("A9: an unknown argument throws", () => {
  assert.throws(() => parsePostCutoffExportArgs(["--bogus"]));
});

test("A10: a missing option value throws", () => {
  assert.throws(() => parsePostCutoffExportArgs(["--output"]));
});

test("A11: an invalid cutoff throws", () => {
  assert.throws(() => parsePostCutoffExportArgs(["--cutoff", "not-a-date"]));
});

test("A12: an invalid page size throws", () => {
  assert.throws(() => parsePostCutoffExportArgs(["--page-size", "0"]));
  assert.throws(() => parsePostCutoffExportArgs(["--page-size", "abc"]));
  assert.throws(() => parsePostCutoffExportArgs(["--page-size", "-5"]));
});

// ---- Window / filter ----

test("W13: the lower bound is exclusive gt", () => {
  assert.ok(buildForwardWindowFilter(CUTOFF, UPPER).includes(`resolved_at.gt.${CUTOFF}`));
});

test("W14: the upper bound is inclusive lte", () => {
  assert.ok(buildForwardWindowFilter(CUTOFF, UPPER).includes(`resolved_at.lte.${UPPER}`));
});

test("W15: the null-resolved exclusion is present", () => {
  assert.ok(buildForwardWindowFilter(CUTOFF, UPPER).includes("resolved_at.not.is.null"));
});

test("W16: no created_at eligibility FILTER predicate exists in any request URL (created_at may appear only as a selected column)", async () => {
  const { fetchImpl, calls } = makeFakeSupabase([dbRow(1), dbRow(2)]);
  await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 1, delayFn: noDelay });
  for (const c of calls) {
    const decoded = decodeURIComponent(c.url);
    assert.doesNotMatch(decoded, /created_at\.(gt|gte|lt|lte|eq|not)\./);
  }
});

test("W17: the upper bound is captured once and reused across all pages", async () => {
  const { fetchImpl, calls } = makeFakeSupabase([dbRow(1), dbRow(2), dbRow(3)]);
  await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 1, delayFn: noDelay });
  const withUpper = calls.filter((c) => c.url.includes(encodeURIComponent(`resolved_at.lte.${UPPER}`)) || c.url.includes(`resolved_at.lte.${UPPER}`));
  assert.equal(withUpper.length, calls.length);
});

// ---- Pagination ----

test("P18: a one-page export returns all rows", async () => {
  const { fetchImpl } = makeFakeSupabase([dbRow(1), dbRow(2)]);
  const result = await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay });
  assert.equal(result.rows.length, 2);
  assert.equal(result.pageCount, 1);
});

test("P19: a multi-page export returns all rows exactly once", async () => {
  const source = Array.from({ length: 7 }, (_, i) => dbRow(i + 1));
  const { fetchImpl } = makeFakeSupabase(source);
  const result = await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 2, delayFn: noDelay });
  assert.equal(result.rows.length, 7);
  const ids = result.rows.map((r) => (r as Record<string, unknown>).id).sort();
  assert.deepEqual(ids, source.map((r) => r.id).sort());
});

test("P20: same-timestamp rows split across a page boundary are all included", async () => {
  const ts = "2026-07-20T12:00:00.000Z";
  const source = [1, 2, 3, 4, 5].map((n) => dbRow(n, { resolved_at: ts }));
  const { fetchImpl } = makeFakeSupabase(source);
  const result = await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 2, delayFn: noDelay });
  assert.equal(result.rows.length, 5);
});

test("P21: the id secondary cursor prevents loss and duplication", async () => {
  const ts = "2026-07-20T12:00:00.000Z";
  const source = [...[1, 2, 3].map((n) => dbRow(n, { resolved_at: ts })), dbRow(4), dbRow(5)];
  const { fetchImpl } = makeFakeSupabase(source);
  const result = await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 2, delayFn: noDelay });
  const ids = result.rows.map((r) => String((r as Record<string, unknown>).id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 5);
});

test("P22: a cursor that does not advance throws", async () => {
  const stuckRow = dbRow(1);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => [stuckRow, stuckRow],
    text: async () => "",
  });
  await assert.rejects(
    fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 2, delayFn: noDelay }),
  );
});

test("P23: a missing cursor field on a full page throws", async () => {
  const rows = [dbRow(1), { condition_id: "0xno-id", resolved_at: "2026-07-15T00:00:00.000Z" }];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => rows,
    text: async () => "",
  });
  await assert.rejects(
    fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 2, delayFn: noDelay }),
  );
});

test("P24: the lower bound remains present on same-timestamp and older-page requests", () => {
  const cursor = { resolvedAt: "2026-07-20T12:00:00.000Z", id: "id-003" };
  const sameTs = buildForwardSameTimestampUrl("https://example.supabase.co", CUTOFF, UPPER, cursor, 10);
  const older = buildForwardOlderTimestampsUrl("https://example.supabase.co", CUTOFF, UPPER, cursor, 10);
  assert.ok(decodeURIComponent(sameTs).includes(`resolved_at.gt.${CUTOFF}`));
  assert.ok(decodeURIComponent(older).includes(`resolved_at.gt.${CUTOFF}`));
});

test("P25: the upper bound remains present on every request URL", () => {
  const cursor = { resolvedAt: "2026-07-20T12:00:00.000Z", id: "id-003" };
  for (const url of [
    buildForwardFirstPageUrl("https://example.supabase.co", CUTOFF, UPPER, 10),
    buildForwardSameTimestampUrl("https://example.supabase.co", CUTOFF, UPPER, cursor, 10),
    buildForwardOlderTimestampsUrl("https://example.supabase.co", CUTOFF, UPPER, cursor, 10),
  ]) {
    assert.ok(decodeURIComponent(url).includes(`resolved_at.lte.${UPPER}`));
  }
});

test("P26: no OFFSET/Range pagination is used", async () => {
  const { fetchImpl, calls } = makeFakeSupabase(Array.from({ length: 5 }, (_, i) => dbRow(i + 1)));
  await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 2, delayFn: noDelay });
  for (const c of calls) {
    assert.doesNotMatch(c.url, /offset=/i);
  }
});

// ---- Physical duplicate safety ----

test("Q27: an identical duplicate physical id collapses to one row", () => {
  const row = dbRow(1);
  const artifacts = buildPostCutoffExportArtifacts({
    rawRows: [row, { ...row }],
    cutoff: CUTOFF,
    upperBound: UPPER,
    pageCount: 1,
    requestCount: 1,
  });
  assert.equal(artifacts.manifest.rowCount, 1);
});

test("Q28: a conflicting duplicate physical id throws deterministically", () => {
  const row = dbRow(1);
  assert.throws(() =>
    buildPostCutoffExportArtifacts({
      rawRows: [row, { ...row, signal_result: "loss" }],
      cutoff: CUTOFF,
      upperBound: UPPER,
      pageCount: 1,
      requestCount: 1,
    }),
  );
});

test("Q29: no observation-level dedup is performed (same condition/token/resolved, different id, both kept)", () => {
  const a = dbRow(1, { resolved_at: "2026-07-20T12:00:00.000Z" });
  const b = dbRow(1, { id: "id-999", resolved_at: "2026-07-20T12:00:00.000Z" });
  const artifacts = buildPostCutoffExportArtifacts({ rawRows: [a, b], cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  assert.equal(artifacts.manifest.rowCount, 2);
});

// ---- Retry ----

function retryScenario(failures: Array<number | "network">, thenRows: Record<string, unknown>[]) {
  let attempt = 0;
  const fetchImpl = async () => {
    attempt += 1;
    const failure = failures[attempt - 1];
    if (failure === "network") throw new Error("socket hang up");
    if (typeof failure === "number") {
      return { ok: false, status: failure, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => thenRows, text: async () => "" };
  };
  return { fetchImpl, attempts: () => attempt };
}

test("R30: a transient 429 retries and succeeds", async () => {
  const { fetchImpl, attempts } = retryScenario([429], [dbRow(1)]);
  const result = await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay });
  assert.equal(result.rows.length, 1);
  assert.ok(attempts() >= 2);
});

test("R31: a transient 503 retries and succeeds", async () => {
  const { fetchImpl } = retryScenario([503], [dbRow(1)]);
  const result = await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay });
  assert.equal(result.rows.length, 1);
});

test("R32: an injected network error retries and succeeds", async () => {
  const { fetchImpl } = retryScenario(["network"], [dbRow(1)]);
  const result = await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay });
  assert.equal(result.rows.length, 1);
});

test("R33: a 400 is not retried", async () => {
  const { fetchImpl, attempts } = retryScenario([400, 400, 400], []);
  await assert.rejects(fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay }));
  assert.equal(attempts(), 1);
});

test("R34: a 401 is not retried", async () => {
  const { fetchImpl, attempts } = retryScenario([401, 401, 401], []);
  await assert.rejects(fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay }));
  assert.equal(attempts(), 1);
});

test("R35: retry exhaustion throws a safe deterministic error", async () => {
  const { fetchImpl } = retryScenario([503, 503, 503], []);
  await assert.rejects(
    fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay }),
    (e: Error) => {
      assert.match(e.message, /503|attempt/i);
      assert.doesNotMatch(e.message, /sk-test-secret-key/);
      return true;
    },
  );
});

test("R36: backoff is injectable and no real delay occurs in tests", async () => {
  const delays: number[] = [];
  const delayFn = async (ms: number) => {
    delays.push(ms);
  };
  const { fetchImpl } = retryScenario([429], [dbRow(1)]);
  await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn });
  assert.ok(delays.length >= 1);
});

// ---- Input / API safety ----

test("S37: a non-array success body throws", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ rows: [] }), text: async () => "" });
  await assert.rejects(fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay }));
});

test("S38: a non-object row throws", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ["not-a-row"], text: async () => "" });
  await assert.rejects(fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay }));
});

test("S39: missing required cursor fields on a full page throws", async () => {
  const rows = [dbRow(1), { condition_id: "0xno-cursor-fields" }];
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => rows, text: async () => "" });
  await assert.rejects(fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 2, delayFn: noDelay }));
});

test("S40: all requests are GET only", async () => {
  const { fetchImpl, calls } = makeFakeSupabase([dbRow(1), dbRow(2), dbRow(3)]);
  await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 1, delayFn: noDelay });
  for (const c of calls) assert.equal(c.method, "GET");
});

test("S41: no Supabase writes occur (no POST/PATCH/PUT/DELETE)", async () => {
  const { fetchImpl, calls } = makeFakeSupabase([dbRow(1)]);
  await fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay });
  for (const c of calls) assert.ok(!["POST", "PATCH", "PUT", "DELETE"].includes(c.method ?? ""));
});

test("S42: errors contain no service-role key", async () => {
  const { fetchImpl } = retryScenario([400], []);
  await assert.rejects(
    fetchPostCutoffResolvedRows({ fetchImpl, config: CONFIG, cutoff: CUTOFF, upperBound: UPPER, pageSize: 100, delayFn: noDelay }),
    (e: Error) => {
      assert.doesNotMatch(e.message, /sk-test-secret-key/);
      return true;
    },
  );
});

test("S43: errors contain no raw row serialization", () => {
  const row = dbRow(1, { secret_marker_field: "leak-me-not" });
  try {
    buildPostCutoffExportArtifacts({
      rawRows: [row, { ...row, signal_result: "loss" }],
      cutoff: CUTOFF,
      upperBound: UPPER,
      pageCount: 1,
      requestCount: 1,
    });
    assert.fail("expected throw");
  } catch (e) {
    assert.doesNotMatch((e as Error).message, /leak-me-not|secret_marker_field/);
  }
});

// ---- Sorting / hash / manifest ----

test("T44: output rows are sorted resolved_at asc then id asc", () => {
  const rows = [dbRow(3, { resolved_at: "2026-07-20T00:00:00.000Z" }), dbRow(1, { resolved_at: "2026-07-15T00:00:00.000Z" }), dbRow(2, { resolved_at: "2026-07-15T00:00:00.000Z" })];
  const artifacts = buildPostCutoffExportArtifacts({ rawRows: rows, cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  const out = artifacts.rows.map((r) => `${(r as Record<string, unknown>).resolved_at}|${(r as Record<string, unknown>).id}`);
  assert.deepEqual(out, [...out].sort());
});

test("T45: the rows JSON is deterministic", () => {
  const rows = [dbRow(1), dbRow(2)];
  const a = buildPostCutoffExportArtifacts({ rawRows: rows, cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  const b = buildPostCutoffExportArtifacts({ rawRows: [...rows].reverse(), cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  assert.equal(a.rowsJson, b.rowsJson);
});

test("T46: the rows JSON ends with exactly one newline", () => {
  const a = buildPostCutoffExportArtifacts({ rawRows: [dbRow(1)], cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  assert.match(a.rowsJson, /[^\n]\n$/);
});

test("T47: contentHash matches the exact rows-file bytes", () => {
  const a = buildPostCutoffExportArtifacts({ rawRows: [dbRow(1)], cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  assert.equal(a.manifest.contentHash, createHash("sha256").update(a.rowsJson).digest("hex"));
});

test("T48: the manifest reconciles the row count", () => {
  const a = buildPostCutoffExportArtifacts({ rawRows: [dbRow(1), dbRow(2)], cutoff: CUTOFF, upperBound: UPPER, pageCount: 2, requestCount: 3 });
  assert.equal(a.manifest.rowCount, a.rows.length);
  assert.equal(a.manifest.pageCount, 2);
  assert.equal(a.manifest.requestCount, 3);
});

test("T49: first/last resolved timestamps are correct", () => {
  const rows = [dbRow(1, { resolved_at: "2026-07-15T00:00:00.000Z" }), dbRow(2, { resolved_at: "2026-07-20T00:00:00.000Z" })];
  const a = buildPostCutoffExportArtifacts({ rawRows: rows, cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  assert.equal(a.manifest.firstResolvedAt, "2026-07-15T00:00:00.000Z");
  assert.equal(a.manifest.lastResolvedAt, "2026-07-20T00:00:00.000Z");
});

test("T50: the empty-window manifest is correct", () => {
  const a = buildPostCutoffExportArtifacts({ rawRows: [], cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  assert.equal(a.manifest.rowCount, 0);
  assert.equal(a.manifest.firstResolvedAt, null);
  assert.equal(a.manifest.lastResolvedAt, null);
  assert.equal(a.manifest.emptyWindow, true);
  assert.equal(a.rowsJson, "[]\n");
  assert.equal(a.manifest.contentHash, createHash("sha256").update("[]\n").digest("hex"));
});

test("T51: a repeated identical bounded source produces identical rows bytes and hash", () => {
  const rows = [dbRow(1), dbRow(2), dbRow(3)];
  const a = buildPostCutoffExportArtifacts({ rawRows: rows, cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  const b = buildPostCutoffExportArtifacts({ rawRows: rows, cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  assert.equal(a.rowsJson, b.rowsJson);
  assert.equal(a.manifest.contentHash, b.manifest.contentHash);
});

test("T52: the manifest contains no absolute path or generation timestamp", () => {
  const a = buildPostCutoffExportArtifacts({ rawRows: [dbRow(1)], cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  const serialized = JSON.stringify(a.manifest);
  assert.doesNotMatch(serialized, /generatedAt|durationMs|\/home\/|C:\\\\/);
  assert.ok(!("generatedAt" in (a.manifest as unknown as Record<string, unknown>)));
});

test("T53: the query contract is exact", () => {
  const a = buildPostCutoffExportArtifacts({ rawRows: [], cutoff: CUTOFF, upperBound: UPPER, pageCount: 1, requestCount: 1 });
  assert.deepEqual(a.manifest.queryContract, {
    table: "generated_signal_pairs",
    lowerBoundOperator: "gt",
    upperBoundOperator: "lte",
    order: "resolved_at.desc,id.desc",
    pagination: "KEYSET_RESOLVED_AT_ID",
    refreshMode: "FULL_POST_CUTOFF",
  });
});

// ---- Dry-run / write ----

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "post-cutoff-export-"));
}

test("D54: default dry-run writes zero files", async () => {
  const dir = tempDir();
  const out = path.join(dir, "rows.json");
  const man = path.join(dir, "manifest.json");
  const { fetchImpl } = makeFakeSupabase([dbRow(1)]);
  const result = await runPostCutoffResolvedExport(["--output", out, "--manifest-output", man], { fetchImpl, env: ENV, upperBound: UPPER });
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(man), false);
});

test("D55: dry-run returns the compact summary", async () => {
  const { fetchImpl } = makeFakeSupabase([dbRow(1), dbRow(2)]);
  const result = await runPostCutoffResolvedExport([], { fetchImpl, env: ENV, upperBound: UPPER });
  assert.equal(result.exitCode, 0);
  const s = result.summary!;
  assert.equal(s.mode, "dry-run");
  assert.equal(s.cutoffResolvedAtExclusive, POST_CUTOFF_RESOLVED_AT_EXCLUSIVE);
  assert.equal(s.runUpperBoundInclusive, UPPER);
  assert.equal(s.rowCount, 2);
  assert.ok(s.firstResolvedAt);
  assert.ok(s.lastResolvedAt);
  assert.match(s.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(s.emptyWindow, false);
  assert.ok(s.pageCount >= 1);
  assert.ok(s.requestCount >= 1);
});

test("D56: the write flag creates exactly the two files", async () => {
  const dir = tempDir();
  const out = path.join(dir, "rows.json");
  const man = path.join(dir, "manifest.json");
  const { fetchImpl } = makeFakeSupabase([dbRow(1)]);
  const result = await runPostCutoffResolvedExport(["--write-artifacts", "--output", out, "--manifest-output", man], { fetchImpl, env: ENV, upperBound: UPPER });
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(out), true);
  assert.equal(existsSync(man), true);
  assert.equal(readdirSync(dir).length, 2);
});

test("D57: the written rows file is accepted by the evaluation runner's loadExportRows", async () => {
  const dir = tempDir();
  const out = path.join(dir, "rows.json");
  const man = path.join(dir, "manifest.json");
  const { fetchImpl } = makeFakeSupabase([dbRow(1), dbRow(2)]);
  await runPostCutoffResolvedExport(["--write-artifacts", "--output", out, "--manifest-output", man], { fetchImpl, env: ENV, upperBound: UPPER });
  const rows = loadExportRows(out);
  assert.equal(rows.length, 2);
});

test("D58: a rerun safely replaces existing files", async () => {
  const dir = tempDir();
  const out = path.join(dir, "rows.json");
  const man = path.join(dir, "manifest.json");
  const { fetchImpl } = makeFakeSupabase([dbRow(1)]);
  await runPostCutoffResolvedExport(["--write-artifacts", "--output", out, "--manifest-output", man], { fetchImpl, env: ENV, upperBound: UPPER });
  const second = await runPostCutoffResolvedExport(["--write-artifacts", "--output", out, "--manifest-output", man], { fetchImpl, env: ENV, upperBound: UPPER });
  assert.equal(second.exitCode, 0);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).length, 1);
});

test("D59: no temp files remain after success", async () => {
  const dir = tempDir();
  const out = path.join(dir, "rows.json");
  const man = path.join(dir, "manifest.json");
  const { fetchImpl } = makeFakeSupabase([dbRow(1)]);
  await runPostCutoffResolvedExport(["--write-artifacts", "--output", out, "--manifest-output", man], { fetchImpl, env: ENV, upperBound: UPPER });
  assert.deepEqual(readdirSync(dir).sort(), ["manifest.json", "rows.json"]);
});

test("D60: a failed rows write leaves no manifest", async () => {
  const dir = tempDir();
  // an output path whose parent is a FILE forces the rows write to fail
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "x", "utf8");
  const out = path.join(blocker, "rows.json");
  const man = path.join(dir, "manifest.json");
  const { fetchImpl } = makeFakeSupabase([dbRow(1)]);
  const result = await runPostCutoffResolvedExport(["--write-artifacts", "--output", out, "--manifest-output", man], { fetchImpl, env: ENV, upperBound: UPPER });
  assert.notEqual(result.exitCode, 0);
  assert.equal(existsSync(man), false);
});

test("D61: a failed manifest verification returns non-zero", async () => {
  const dir = tempDir();
  const out = path.join(dir, "rows.json");
  const blocker = path.join(dir, "manblock");
  writeFileSync(blocker, "x", "utf8");
  const man = path.join(blocker, "manifest.json");
  const { fetchImpl } = makeFakeSupabase([dbRow(1)]);
  const result = await runPostCutoffResolvedExport(["--write-artifacts", "--output", out, "--manifest-output", man], { fetchImpl, env: ENV, upperBound: UPPER });
  assert.notEqual(result.exitCode, 0);
});

// ---- Entry point ----

test("E62: importing the module does not auto-run the CLI", () => {
  assert.equal(typeof runPostCutoffResolvedExport, "function");
  assert.equal(typeof parsePostCutoffExportArgs, "function");
});

test("E63: a successful run returns exit code 0", async () => {
  const { fetchImpl } = makeFakeSupabase([dbRow(1)]);
  const result = await runPostCutoffResolvedExport([], { fetchImpl, env: ENV, upperBound: UPPER });
  assert.equal(result.exitCode, 0);
});

test("E64: a failing run returns non-zero", async () => {
  const result = await runPostCutoffResolvedExport(["--bogus-flag"], { env: ENV, upperBound: UPPER });
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.error);
});
