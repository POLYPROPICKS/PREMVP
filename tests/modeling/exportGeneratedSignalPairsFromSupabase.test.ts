import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  normalizeGeneratedSignalPairRow,
  exportGeneratedSignalPairsFromSupabase,
  resolveSupabaseReadConfig,
} from "../../scripts/modeling/strategies/export-generated-signal-pairs-from-supabase";

const SOURCE_PATH = path.join(
  __dirname,
  "../../scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts",
);

function readSource(): string {
  return readFileSync(SOURCE_PATH, "utf8");
}

function makeRow(id: string): Record<string, unknown> {
  return { id, condition_id: `c-${id}`, token_id: `t-${id}`, resolved_at: "2026-01-01T00:00:00Z" };
}

const FAKE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
} as unknown as NodeJS.ProcessEnv;

interface FakeHeadersInit {
  [key: string]: string | undefined;
}

function makeFakeResponse(opts: {
  ok: boolean;
  status?: number;
  headers?: FakeHeadersInit;
  json?: () => Promise<unknown>;
}) {
  const headers = opts.headers ?? {};
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    headers: {
      get(name: string) {
        const lower = name.toLowerCase();
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === lower) return headers[key] ?? null;
        }
        return null;
      },
    },
    json: opts.json ?? (async () => []),
  };
}

interface FakeFetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string> };
}

interface FakeFetchOptions {
  totalRows: number;
  pageOverride?: (from: number, to: number) => ReturnType<typeof makeFakeResponse> | null;
}

// Simulates a PostgREST-style paginated endpoint with `totalRows` rows
// total and no count/head support -- every request is a plain page fetch
// keyed off the Range header.
function makeFakeFetch(options: FakeFetchOptions) {
  const calls: FakeFetchCall[] = [];

  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, init: init ?? {} });
    const headers = init?.headers ?? {};
    const range = headers["Range"];

    const [fromStr, toStr] = String(range).split("-");
    const from = Number(fromStr);
    const to = Number(toStr);

    if (options.pageOverride) {
      const overridden = options.pageOverride(from, to);
      if (overridden) return overridden;
    }

    const remaining = Math.max(0, options.totalRows - from);
    const n = Math.min(to - from + 1, remaining);
    const data = Array.from({ length: n }, (_, i) => makeRow(String(from + i)));
    return makeFakeResponse({ ok: true, status: 200, json: async () => data });
  };

  return { fetchImpl, calls };
}

// ---- Normalization (transport-independent) ----

test("1. normalizes selected_token_id into token_id", () => {
  const row = { id: "a", condition_id: "c1", selected_token_id: "t1" };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.token_id, "t1");
});

test("2. falls back to diagnostics.selectedTokenId when token_id and selected_token_id are absent", () => {
  const row = { id: "a", condition_id: "c1", diagnostics: { selectedTokenId: "t2" } };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.token_id, "t2");
});

test("3. normalizes entry_price from diagnostics.entryPrice when entry_price_num is absent", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1", diagnostics: { entryPrice: 0.42 } };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.entry_price_num, 0.42);
});

test("4. normalizes score from pre_event_score_num", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1", pre_event_score_num: 7.5 };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.score, 7.5);
});

test("5. preserves diagnostics object", () => {
  const diagnostics = { selectedTokenId: "t9", entryPrice: 0.1, extra: "keep" };
  const row = { id: "a", condition_id: "c1", token_id: "t1", diagnostics };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.deepEqual(normalized.diagnostics, diagnostics);
});

test("6. excludes undefined fields from output rows where practical", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1" };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal("resolved_at" in normalized, false);
  assert.equal("real_pnl_usd" in normalized, false);
});

test("7. default export mode has no hidden cap and fetches until exhaustion", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 1200 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    assert.equal(result.fetchedRows, 1200);
    assert.equal(result.exportCompleteness, "COMPLETE_BY_EXHAUSTION");
    assert.equal(result.exportMode, "FULL_RESOLVED_BY_EXHAUSTION");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("16. does not include insert/update/delete/upsert/rpc/write calls", () => {
  const source = readSource();
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /\.update\(/);
  assert.doesNotMatch(source, /\.delete\(/);
  assert.doesNotMatch(source, /\.upsert\(/);
  assert.doesNotMatch(source, /\.rpc\(/);
});

test("17. writes export file to modeling/local_exports/generated_signal_pairs_export.json (relative default)", () => {
  const source = readSource();
  assert.match(source, /generated_signal_pairs_export\.json/);
});

test("18. generated output is a JSON array", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    assert.equal(result.fetchedRows, 1);
    const written = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.ok(Array.isArray(written));
    assert.equal(written.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("19. no ROI/PnL/profit keys are added by exporter (normalization)", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1", real_pnl_usd: 5, realized_return_pct: 10 };
  const normalized = normalizeGeneratedSignalPairRow(row);
  const keys = Object.keys(normalized);
  assert.ok(!keys.some((k) => /roi/i.test(k)));
  assert.equal(normalized.real_pnl_usd, 5);
  assert.equal(normalized.realized_return_pct, 10);
});

test("20. no ROI/PnL/profit keys are added by exporter (summary output)", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    const keys = Object.keys(result);
    assert.ok(!keys.some((k) => /roi|pnl|profit/i.test(k)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("21. safe error when env/config missing: message names missing variables but does not print values", () => {
  const env = { SOME_UNRELATED_VAR: "secret-value-should-not-leak" };
  assert.throws(
    () => resolveSupabaseReadConfig(env as unknown as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /SUPABASE_URL/);
      assert.match(error.message, /SUPABASE_SERVICE_ROLE_KEY/);
      assert.doesNotMatch(error.message, /secret-value-should-not-leak/);
      return true;
    },
  );
});

test("22. no mutation of source rows", () => {
  const row = { id: "a", condition_id: "c1", selected_token_id: "t1" };
  const snapshot = JSON.stringify(row);
  normalizeGeneratedSignalPairRow(row);
  assert.equal(JSON.stringify(row), snapshot);
});

test("resolveSupabaseReadConfig succeeds with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "key",
  } as unknown as NodeJS.ProcessEnv;
  const config = resolveSupabaseReadConfig(env);
  assert.equal(config.url, "https://example.supabase.co");
  assert.equal(config.key, "key");
});

// ---- Phase 3E.2: export summary sidecar ----

test("S1. exporter supports summaryOutputPath and writes a sidecar summary file", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 3 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      summaryOutputPath: summaryPath,
      pageSize: 1000,
    });
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(summary.fetchedRows, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2. summary file contains the full compact summary shape (exhaustion contract)", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      summaryOutputPath: summaryPath,
      pageSize: 1000,
    });
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    for (const key of [
      "outputPath",
      "fetchedRows",
      "pageSize",
      "pagesFetched",
      "exportMode",
      "exportCompleteness",
      "completionProof",
      "exportCutoffResolvedAt",
      "missingRows",
    ]) {
      assert.ok(key in summary, `expected summary key ${key}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3. summary file contains no raw rows", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 3 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      summaryOutputPath: summaryPath,
      pageSize: 1000,
    });
    const raw = readFileSync(summaryPath, "utf8");
    assert.doesNotMatch(raw, /condition_id/);
    assert.doesNotMatch(raw, /token_id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S4. summary output directory is created if missing", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "nested", "deep", "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      summaryOutputPath: summaryPath,
      pageSize: 1000,
    });
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(summary.fetchedRows, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S5. without summaryOutputPath, no sidecar behavior changes the returned summary", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 2 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.fetchedRows, 2);
    assert.equal(result.exportCompleteness, "COMPLETE_BY_EXHAUSTION");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Phase 3E.2b: exhaustion pagination, no count endpoint ----

test("E1. default export does not call the count endpoint (no Prefer: count=exact header ever sent)", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ totalRows: 1200 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    assert.ok(calls.every((c) => c.init.headers?.Prefer !== "count=exact"));
    assert.ok(calls.every((c) => c.init.headers?.Range !== "0-0" || calls.length === 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E2. source contains no reference to count=exact anywhere", () => {
  const source = readSource();
  assert.doesNotMatch(source, /count=exact/);
  assert.doesNotMatch(source, /Content-Range/);
});

test("E3. pages are fetched with Range 0-999, 1000-1999, ... until a short/empty final page", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ totalRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    const ranges = calls.map((c) => c.init.headers?.Range);
    assert.deepEqual(ranges, ["0-999", "1000-1999", "2000-2999"]);
    assert.equal(result.fetchedRows, 2500);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.completionProof, "LAST_PAGE_SHORT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E4. stops on an exactly-empty final page and reports completionProof EMPTY_PAGE", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 2000 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    // totalRows is an exact multiple of pageSize -- the exporter must issue
    // one more page request and see it come back empty to know it is done.
    assert.equal(result.fetchedRows, 2000);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.completionProof, "EMPTY_PAGE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E5. every page request includes the resolved_at not-null and cutoff filters, ordered desc", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ totalRows: 5 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.match(call.url, /resolved_at=not\.is\.null/);
      assert.match(call.url, /resolved_at=lte\./);
      assert.match(call.url, /order=resolved_at\.desc/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E6. summary reports exportMode FULL_RESOLVED_BY_EXHAUSTION and exportCompleteness COMPLETE_BY_EXHAUSTION by default", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 10 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.exportMode, "FULL_RESOLVED_BY_EXHAUSTION");
    assert.equal(result.exportCompleteness, "COMPLETE_BY_EXHAUSTION");
    assert.equal(result.missingRows, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E7. summary includes a valid ISO exportCutoffResolvedAt captured at export start", async () => {
  const before = new Date();
  const { fetchImpl } = makeFakeFetch({ totalRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    const after = new Date();
    const cutoff = new Date(result.exportCutoffResolvedAt);
    assert.ok(!Number.isNaN(cutoff.getTime()), "exportCutoffResolvedAt must be a valid ISO timestamp");
    assert.ok(cutoff.getTime() >= before.getTime() - 1000);
    assert.ok(cutoff.getTime() <= after.getTime() + 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E8. debug --max-rows caps the export and reports DEBUG_CAPPED / INTENTIONALLY_CAPPED", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
      maxRows: 500,
    });
    assert.equal(result.exportMode, "DEBUG_CAPPED");
    assert.equal(result.exportCompleteness, "INTENTIONALLY_CAPPED");
    assert.equal(result.requestedMaxRows, 500);
    assert.equal(result.fetchedRows, 500);
    assert.equal(result.missingRows, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E9. debug --max-rows fetch still respects the cutoff/order filters and stops at the cap, not by exhaustion", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ totalRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
      maxRows: 500,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers?.Range, "0-499");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E10. non-ok page response rejects with a safe message, no raw response body", async () => {
  const { fetchImpl } = makeFakeFetch({
    totalRows: 10,
    pageOverride: () => makeFakeResponse({ ok: false, status: 503 }),
  });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /page/);
        assert.match(error.message, /503/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E11. does not print/log env values or raw rows in source", () => {
  const source = readSource();
  assert.doesNotMatch(source, /console\./);
});

test("E12. does not include insert/update/delete/upsert/rpc/write calls (exhaustion transport)", () => {
  const source = readSource();
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /\.update\(/);
  assert.doesNotMatch(source, /\.delete\(/);
  assert.doesNotMatch(source, /\.upsert\(/);
  assert.doesNotMatch(source, /\.rpc\(/);
});

test("E13. no ROI/PnL/profit keys are added by exporter (exhaustion summary)", async () => {
  const { fetchImpl } = makeFakeFetch({ totalRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    const keys = Object.keys(result);
    assert.ok(!keys.some((k) => /roi|pnl|profit/i.test(k)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
