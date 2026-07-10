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
  availableResolvedRows: number;
  countOverride?: () => ReturnType<typeof makeFakeResponse>;
  pageOverride?: (from: number, to: number) => ReturnType<typeof makeFakeResponse> | null;
}

function makeFakeFetch(options: FakeFetchOptions) {
  const calls: FakeFetchCall[] = [];

  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, init: init ?? {} });
    const headers = init?.headers ?? {};
    const range = headers["Range"];
    const isCountRequest = headers["Prefer"] === "count=exact";

    if (isCountRequest) {
      if (options.countOverride) return options.countOverride();
      return makeFakeResponse({
        ok: true,
        status: 200,
        headers: { "Content-Range": `0-0/${options.availableResolvedRows}` },
        json: async () => [],
      });
    }

    const [fromStr, toStr] = String(range).split("-");
    const from = Number(fromStr);
    const to = Number(toStr);

    if (options.pageOverride) {
      const overridden = options.pageOverride(from, to);
      if (overridden) return overridden;
    }

    const remaining = Math.max(0, options.availableResolvedRows - from);
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

test("7. default export mode has no limit=5000 hidden cap", async () => {
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 1200 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    assert.equal(result.fetchedRows, 1200);
    assert.equal(result.exportCompleteness, "COMPLETE");
    assert.equal(result.exportMode, "FULL_RESOLVED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("8. exporter asks for exact count of resolved rows before fetching data", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ availableResolvedRows: 50 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const countCalls = calls.filter((c) => c.init.headers?.Prefer === "count=exact");
    assert.equal(countCalls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9. exporter fetches pages via Range header until fetched rows equal available resolved count", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ availableResolvedRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.fetchedRows, 2500);
    const pageCalls = calls.filter((c) => c.init.headers?.Prefer !== "count=exact");
    assert.equal(pageCalls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("10. with availableResolvedRows=2500 and pageSize=1000, page Range headers are 0-999, 1000-1999, 2000-2499", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ availableResolvedRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    const pageRanges = calls
      .filter((c) => c.init.headers?.Prefer !== "count=exact")
      .map((c) => c.init.headers?.Range);
    assert.deepEqual(pageRanges, ["0-999", "1000-1999", "2000-2499"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("11. availableResolvedRows=2500 summary reports full completeness fields", async () => {
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.availableResolvedRows, 2500);
    assert.equal(result.fetchedRows, 2500);
    assert.equal(result.pageSize, 1000);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.exportCompleteness, "COMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("12. explicit debug cap reports DEBUG_CAPPED / INTENTIONALLY_CAPPED", async () => {
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 2500 });
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
    assert.equal(result.requestedMaxRows, 500);
    assert.equal(result.availableResolvedRows, 2500);
    assert.equal(result.fetchedRows, 500);
    assert.equal(result.exportCompleteness, "INTENTIONALLY_CAPPED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("13. fetchedRows < availableResolvedRows without explicit cap reports INCOMPLETE with missingRows > 0", async () => {
  // Simulate a short page (server returned fewer rows than requested for a
  // page that is not the last one) to trigger an incomplete fetch without
  // an explicit cap.
  const { fetchImpl } = makeFakeFetch({
    availableResolvedRows: 2500,
    pageOverride: (from) => {
      if (from === 0) {
        const data = Array.from({ length: 1000 }, (_, i) => makeRow(String(i)));
        return makeFakeResponse({ ok: true, json: async () => data });
      }
      // Every subsequent page is stalled/broken -- empty, without lying
      // about the count.
      return makeFakeResponse({ ok: true, json: async () => [] });
    },
  });

  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.fetchedRows, 1000);
    assert.equal(result.availableResolvedRows, 2500);
    assert.equal(result.exportCompleteness, "INCOMPLETE");
    assert.equal(result.missingRows, 1500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("14. default Windows/operator runner does NOT pass debug max rows", () => {
  const cmdSource = readFileSync(
    path.join(__dirname, "../../scripts/modeling/strategies/run-3d2o-from-supabase.cmd"),
    "utf8",
  );
  assert.doesNotMatch(cmdSource, /--max-rows/);
  assert.doesNotMatch(cmdSource, /--limit/);
});

test("15. count request uses Prefer: count=exact, Range-Unit: items, Range: 0-0 and parses Content-Range", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ availableResolvedRows: 42088 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      maxRows: 1,
    });
    const countCall = calls.find((c) => c.init.headers?.Prefer === "count=exact");
    assert.ok(countCall);
    assert.equal(countCall?.init.headers?.["Range-Unit"], "items");
    assert.equal(countCall?.init.headers?.Range, "0-0");
    assert.equal(result.availableResolvedRows, 42088);
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
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 1 });
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
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 1 });
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
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 3 });
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
    assert.equal(summary.availableResolvedRows, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2. summary file contains the full compact summary shape", async () => {
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 2500 });
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
      "availableResolvedRows",
      "fetchedRows",
      "targetRows",
      "pageSize",
      "pagesFetched",
      "exportMode",
      "exportCompleteness",
      "missingRows",
    ]) {
      assert.ok(key in summary, `expected summary key ${key}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3. summary file contains no raw rows", async () => {
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 3 });
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
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 1 });
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
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 2 });
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
    assert.equal(result.exportCompleteness, "COMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Phase 3E.2a: Windows-safe REST transport ----

test("T1. default export count path does not depend on a Supabase client head/count select", () => {
  const source = readSource();
  assert.doesNotMatch(source, /import .*@supabase\/supabase-js/);
  assert.doesNotMatch(source, /createClient\(/);
  assert.doesNotMatch(source, /head:\s*true/);
});

test("T2. page fetch uses Range header and resolved_at=not.is.null / order=resolved_at.desc query params", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ availableResolvedRows: 5 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    const pageCall = calls.find((c) => c.init.headers?.Prefer !== "count=exact");
    assert.ok(pageCall);
    assert.match(pageCall!.url, /resolved_at=not\.is\.null/);
    assert.match(pageCall!.url, /order=resolved_at\.desc/);
    assert.equal(pageCall!.init.headers?.["Range-Unit"], "items");
    assert.equal(pageCall!.init.headers?.Range, "0-4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3. preserves existing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env convention", async () => {
  const { fetchImpl, calls } = makeFakeFetch({ availableResolvedRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    assert.ok(calls.every((c) => c.url.startsWith(FAKE_ENV.SUPABASE_URL as unknown as string)));
    assert.ok(calls.every((c) => c.init.headers?.apikey === FAKE_ENV.SUPABASE_SERVICE_ROLE_KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4. does not print/log env values in source", () => {
  const source = readSource();
  assert.doesNotMatch(source, /console\./);
});

test("T5. non-ok count response rejects with a safe message, no raw response body", async () => {
  const { fetchImpl } = makeFakeFetch({
    availableResolvedRows: 10,
    countOverride: () => makeFakeResponse({ ok: false, status: 500 }),
  });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /count/);
        assert.match(error.message, /500/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T6. missing/invalid Content-Range rejects with a safe message", async () => {
  const { fetchImpl } = makeFakeFetch({
    availableResolvedRows: 10,
    countOverride: () => makeFakeResponse({ ok: true, status: 200, headers: {} }),
  });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /count/);
        assert.match(error.message, /Content-Range/i);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T7. non-ok page response rejects with a safe message", async () => {
  const { fetchImpl } = makeFakeFetch({
    availableResolvedRows: 10,
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

test("T8. does not include insert/update/delete/upsert/rpc/write calls (transport hardened)", () => {
  const source = readSource();
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /\.update\(/);
  assert.doesNotMatch(source, /\.delete\(/);
  assert.doesNotMatch(source, /\.upsert\(/);
  assert.doesNotMatch(source, /\.rpc\(/);
});

test("T9. summary sidecar still works with the REST transport", async () => {
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 7 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      summaryOutputPath: summaryPath,
    });
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(summary.fetchedRows, 7);
    assert.equal(summary.exportCompleteness, "COMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T10. export completeness summary shape unchanged after transport hardening", async () => {
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 42088 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      maxRows: 1,
    });
    for (const key of [
      "availableResolvedRows",
      "fetchedRows",
      "targetRows",
      "pageSize",
      "pagesFetched",
      "exportMode",
      "exportCompleteness",
      "missingRows",
    ]) {
      assert.ok(key in result, `expected result key ${key}`);
    }
    assert.equal(result.availableResolvedRows, 42088);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T11. no ROI/PnL/profit keys are added by exporter (transport hardened)", async () => {
  const { fetchImpl } = makeFakeFetch({ availableResolvedRows: 1 });
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
