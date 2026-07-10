import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  normalizeGeneratedSignalPairRow,
  exportGeneratedSignalPairsFromSupabase,
  resolveSupabaseReadConfig,
} from "../../scripts/modeling/strategies/export-generated-signal-pairs-from-supabase";

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

test("7. builds read query with resolved rows, order desc, limit", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const fakeQuery = {
    select(...args: unknown[]) {
      calls.push({ method: "select", args });
      return fakeQuery;
    },
    not(...args: unknown[]) {
      calls.push({ method: "not", args });
      return fakeQuery;
    },
    order(...args: unknown[]) {
      calls.push({ method: "order", args });
      return fakeQuery;
    },
    limit(...args: unknown[]) {
      calls.push({ method: "limit", args });
      return Promise.resolve({ data: [], error: null });
    },
  };
  const fakeClient = {
    from(table: string) {
      calls.push({ method: "from", args: [table] });
      return fakeQuery;
    },
  };

  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      client: fakeClient as never,
      outputPath,
      limit: 123,
    });
    const fromCall = calls.find((c) => c.method === "from");
    assert.equal(fromCall?.args[0], "generated_signal_pairs");
    const selectCall = calls.find((c) => c.method === "select");
    assert.equal(selectCall?.args[0], "*");
    const notCall = calls.find((c) => c.method === "not");
    assert.deepEqual(notCall?.args, ["resolved_at", "is", null]);
    const orderCall = calls.find((c) => c.method === "order");
    assert.equal(orderCall?.args[0], "resolved_at");
    assert.deepEqual(orderCall?.args[1], { ascending: false });
    const limitCall = calls.find((c) => c.method === "limit");
    assert.equal(limitCall?.args[0], 123);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("8. does not include insert/update/delete/upsert/rpc/write calls", () => {
  const source = readFileSync(
    path.join(__dirname, "../../scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /\.update\(/);
  assert.doesNotMatch(source, /\.delete\(/);
  assert.doesNotMatch(source, /\.upsert\(/);
  assert.doesNotMatch(source, /\.rpc\(/);
});

test("9. writes export file to modeling/local_exports/generated_signal_pairs_export.json (relative default)", () => {
  const source = readFileSync(
    path.join(__dirname, "../../scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts"),
    "utf8",
  );
  assert.match(source, /generated_signal_pairs_export\.json/);
});

test("10. generated output is a JSON array", async () => {
  const fakeQuery = {
    select() {
      return fakeQuery;
    },
    not() {
      return fakeQuery;
    },
    order() {
      return fakeQuery;
    },
    limit() {
      return Promise.resolve({
        data: [{ id: "a", condition_id: "c1", token_id: "t1", resolved_at: "2026-01-01T00:00:00Z" }],
        error: null,
      });
    },
  };
  const fakeClient = { from: () => fakeQuery };

  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      client: fakeClient as never,
      outputPath,
      limit: 10,
    });
    assert.equal(result.rows, 1);
    const written = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.ok(Array.isArray(written));
    assert.equal(written.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("11. no ROI/PnL/profit keys are added by exporter", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1", real_pnl_usd: 5, realized_return_pct: 10 };
  const normalized = normalizeGeneratedSignalPairRow(row);
  const keys = Object.keys(normalized);
  assert.ok(!keys.some((k) => /roi/i.test(k)));
  // pass-through fields from source are allowed (not computed by exporter);
  // exporter must not ADD any new ROI/PnL key beyond what the source had.
  assert.equal(normalized.real_pnl_usd, 5);
  assert.equal(normalized.realized_return_pct, 10);
});

test("12. safe error when env/config missing: message names missing variables but does not print values", () => {
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

test("13. no mutation of source rows", () => {
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
