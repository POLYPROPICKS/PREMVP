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

interface FakeClientOptions {
  availableResolvedRows: number;
}

interface FakeClientResult {
  client: unknown;
  rangeCalls: Array<[number, number]>;
  countCallsRef: { count: number };
}

function makeFakeClient(options: FakeClientOptions): FakeClientResult {
  const rangeCalls: Array<[number, number]> = [];
  const countCallsRef = { count: 0 };

  const countQuery = {
    not() {
      return countQuery;
    },
    then(resolve: (value: { data: null; count: number; error: null }) => void) {
      countCallsRef.count += 1;
      resolve({ data: null, count: options.availableResolvedRows, error: null });
    },
  };

  const client = {
    from() {
      return {
        select(_columns: string, selectOptions?: { count?: string; head?: boolean }) {
          if (selectOptions?.head) {
            return countQuery;
          }
          const dataQuery = {
            not() {
              return dataQuery;
            },
            order() {
              return dataQuery;
            },
            range(from: number, to: number) {
              rangeCalls.push([from, to]);
              const pageSize = to - from + 1;
              const remaining = Math.max(0, options.availableResolvedRows - from);
              const rowsInPage = Math.min(pageSize, remaining);
              const data = Array.from({ length: rowsInPage }, (_, i) => makeRow(String(from + i)));
              return Promise.resolve({ data, error: null });
            },
          };
          return dataQuery;
        },
      };
    },
  };

  return { client, rangeCalls, countCallsRef };
}

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
  const { client } = makeFakeClient({ availableResolvedRows: 1200 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
      outputPath,
    });
    assert.equal(result.fetchedRows, 1200);
    assert.equal(result.exportCompleteness, "COMPLETE");
    assert.equal(result.exportMode, "FULL_RESOLVED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("8. exporter asks Supabase for exact count of resolved rows before fetching data", async () => {
  const { client, countCallsRef } = makeFakeClient({ availableResolvedRows: 50 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({ client: client as never, outputPath });
    assert.equal(countCallsRef.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9. exporter fetches pages with .range(from,to) until fetched rows equal available resolved count", async () => {
  const { client, rangeCalls } = makeFakeClient({ availableResolvedRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.fetchedRows, 2500);
    assert.equal(rangeCalls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("10. with availableResolvedRows=2500 and pageSize=1000, ranges are 0..999, 1000..1999, 2000..2499", async () => {
  const { client, rangeCalls } = makeFakeClient({ availableResolvedRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
      outputPath,
      pageSize: 1000,
    });
    assert.deepEqual(rangeCalls, [
      [0, 999],
      [1000, 1999],
      [2000, 2499],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("11. availableResolvedRows=2500 summary reports full completeness fields", async () => {
  const { client } = makeFakeClient({ availableResolvedRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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
  const { client } = makeFakeClient({ availableResolvedRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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
  const rangeCalls: Array<[number, number]> = [];
  const countQuery = {
    not() {
      return countQuery;
    },
    then(resolve: (value: { data: null; count: number; error: null }) => void) {
      resolve({ data: null, count: 2500, error: null });
    },
  };
  const client = {
    from() {
      return {
        select(_columns: string, selectOptions?: { count?: string; head?: boolean }) {
          if (selectOptions?.head) {
            return countQuery;
          }
          const dataQuery = {
            not() {
              return dataQuery;
            },
            order() {
              return dataQuery;
            },
            range(from: number, to: number) {
              rangeCalls.push([from, to]);
              // Always return an empty page after the first, simulating a
              // stalled/broken pagination stream without lying about count.
              if (from === 0) {
                const data = Array.from({ length: 1000 }, (_, i) => makeRow(String(i)));
                return Promise.resolve({ data, error: null });
              }
              return Promise.resolve({ data: [], error: null });
            },
          };
          return dataQuery;
        },
      };
    },
  };

  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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

test("15. uses read-only chain only (select with count, range)", () => {
  const source = readSource();
  assert.match(source, /count:\s*"exact"/);
  assert.match(source, /\.range\(/);
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
  const { client } = makeFakeClient({ availableResolvedRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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
  const { client } = makeFakeClient({ availableResolvedRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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
  const { client } = makeFakeClient({ availableResolvedRows: 3 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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
  const { client } = makeFakeClient({ availableResolvedRows: 2500 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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
  const { client } = makeFakeClient({ availableResolvedRows: 3 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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
  const { client } = makeFakeClient({ availableResolvedRows: 1 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "nested", "deep", "summary.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
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
  const { client } = makeFakeClient({ availableResolvedRows: 2 });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: client as never,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.fetchedRows, 2);
    assert.equal(result.exportCompleteness, "COMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
