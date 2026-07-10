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

const FAKE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
} as unknown as NodeJS.ProcessEnv;

interface FakeKeysetRow {
  id: string;
  condition_id: string;
  token_id: string;
  resolved_at: string;
}

function makeKeysetRow(resolvedAt: string, id: string): FakeKeysetRow {
  return { id, condition_id: `c-${id}`, token_id: `t-${id}`, resolved_at: resolvedAt };
}

// Generates `count` rows already in strict resolved_at DESC, id DESC order
// (as a real `order=resolved_at.desc,id.desc` query would return), one
// second apart, with zero-padded ids so lexicographic string comparison
// matches the intended numeric ordering.
function generateDescendingRows(count: number, cutoff: Date): FakeKeysetRow[] {
  const rows: FakeKeysetRow[] = [];
  for (let i = 0; i < count; i++) {
    const resolvedAt = new Date(cutoff.getTime() - i * 1000).toISOString();
    const id = String(900000 - i).padStart(6, "0");
    rows.push(makeKeysetRow(resolvedAt, id));
  }
  return rows;
}

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

function parseCursorFromOrFilter(orValue: string | null): { resolvedAt: string; id: string } | null {
  if (!orValue) return null;
  const match = /resolved_at\.lt\.([^,]+),and\(resolved_at\.eq\.([^,]+),id\.lt\.([^)]+)\)/.exec(orValue);
  if (!match) return null;
  return { resolvedAt: match[1], id: match[3] };
}

interface FakeFetchOptions {
  rows: FakeKeysetRow[];
  pageOverride?: (ctx: {
    pageNumber: number;
    isFirstPage: boolean;
    limit: number;
  }) => ReturnType<typeof makeFakeResponse> | null;
}

// Simulates a PostgREST-style keyset-paginated endpoint operating over an
// already resolved_at-DESC,id-DESC-sorted dataset: applies the cutoff
// filter, the composite `or` cursor filter (if present), and `limit`.
function makeFakeFetch(options: FakeFetchOptions) {
  const calls: FakeFetchCall[] = [];

  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, init: init ?? {} });
    const parsedUrl = new URL(url);
    const limit = Number(parsedUrl.searchParams.get("limit"));
    const resolvedAtValues = parsedUrl.searchParams.getAll("resolved_at");
    const lteEntry = resolvedAtValues.find((v) => v.startsWith("lte."));
    const cutoff = lteEntry ? lteEntry.slice("lte.".length) : null;
    const cursor = parseCursorFromOrFilter(parsedUrl.searchParams.get("or"));

    let filtered = cutoff ? options.rows.filter((r) => r.resolved_at <= cutoff) : options.rows;
    if (cursor) {
      filtered = filtered.filter(
        (r) => r.resolved_at < cursor.resolvedAt || (r.resolved_at === cursor.resolvedAt && r.id < cursor.id),
      );
    }
    const page = filtered.slice(0, limit);

    if (options.pageOverride) {
      const overridden = options.pageOverride({
        pageNumber: calls.length,
        isFirstPage: cursor === null,
        limit,
      });
      if (overridden) return overridden;
    }

    return makeFakeResponse({ ok: true, status: 200, json: async () => page });
  };

  return { fetchImpl, calls };
}

async function withTempDir<T>(fn: (outputPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  try {
    return await fn(path.join(dir, "export.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Normalization (transport-independent) ----

test("N1. normalizes selected_token_id into token_id", () => {
  const row = { id: "a", condition_id: "c1", selected_token_id: "t1" };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.token_id, "t1");
});

test("N2. falls back to diagnostics.selectedTokenId when token_id and selected_token_id are absent", () => {
  const row = { id: "a", condition_id: "c1", diagnostics: { selectedTokenId: "t2" } };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.token_id, "t2");
});

test("N3. normalizes entry_price from diagnostics.entryPrice when entry_price_num is absent", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1", diagnostics: { entryPrice: 0.42 } };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.entry_price_num, 0.42);
});

test("N4. normalizes score from pre_event_score_num", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1", pre_event_score_num: 7.5 };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.score, 7.5);
});

test("N5. preserves diagnostics object", () => {
  const diagnostics = { selectedTokenId: "t9", entryPrice: 0.1, extra: "keep" };
  const row = { id: "a", condition_id: "c1", token_id: "t1", diagnostics };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.deepEqual(normalized.diagnostics, diagnostics);
});

test("N6. excludes undefined fields from output rows where practical", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1" };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal("resolved_at" in normalized, false);
  assert.equal("real_pnl_usd" in normalized, false);
});

test("N7. no mutation of source rows", () => {
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

test("safe error when env/config missing: message names missing variables but does not print values", () => {
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

// ---- Phase 3E.2d: keyset pagination (resolved_at DESC, id DESC) ----

const CUTOFF = new Date("2026-07-10T00:00:00.000Z");

test("K1. default full export never uses deep offset pagination", async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    for (const call of calls) {
      const url = new URL(call.url);
      assert.equal(url.searchParams.get("offset"), null, "must not send an offset query param");
      assert.equal(call.init.headers?.Range, undefined, "must not send a Range header");
    }
  });
});

test("K2. page 2 does not send Range: 1000-1999 or any offset-based equivalent", async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.ok(calls.length >= 2);
    const secondCall = calls[1];
    assert.equal(secondCall.init.headers?.Range, undefined);
    assert.doesNotMatch(secondCall.url, /Range=1000-1999/);
    assert.doesNotMatch(secondCall.url, /offset=1000/);
  });
});

test("K3. first request contains resolved_at not-null, cutoff, order resolved_at.desc,id.desc, limit=1000, no cursor", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    const first = new URL(calls[0].url);
    assert.equal(first.searchParams.getAll("resolved_at")[0], "not.is.null");
    assert.match(first.searchParams.getAll("resolved_at")[1], /^lte\./);
    assert.equal(first.searchParams.get("order"), "resolved_at.desc,id.desc");
    assert.equal(first.searchParams.get("limit"), "1000");
    assert.equal(first.searchParams.get("or"), null, "first page must not carry a cursor filter");
  });
});

test("K4. second request contains the correctly encoded composite or cursor filter", async () => {
  const rows = generateDescendingRows(1500, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.ok(calls.length >= 2);
    const second = new URL(calls[1].url);
    const orValue = second.searchParams.get("or");
    assert.ok(orValue, "expected an or= cursor filter on the second request");
    // The cursor must be built from the last row of page 1 (row index 999).
    const lastRowOfPage1 = rows[999];
    assert.match(orValue as string, new RegExp(`resolved_at\\.lt\\.${lastRowOfPage1.resolved_at.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(orValue as string, new RegExp(`id\\.lt\\.${lastRowOfPage1.id}`));
  });
});

test("K5. URL-level assertion proves both cursor branches: older resolved_at, and same resolved_at + lower id", async () => {
  const rows = generateDescendingRows(1500, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    const second = new URL(calls[1].url);
    const orValue = second.searchParams.get("or") as string;
    assert.match(orValue, /resolved_at\.lt\./, "must include the older-resolved_at branch");
    assert.match(orValue, /and\(resolved_at\.eq\./, "must include the same-resolved_at branch");
    assert.match(orValue, /id\.lt\./, "same-resolved_at branch must compare id");
  });
});

test("K6. multiple pages preserve all rows", async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.fetchedRows, 2500);
    const written = JSON.parse(readFileSync(outputPath, "utf8")) as Array<{ id: string }>;
    const writtenIds = written.map((r) => r.id).sort();
    const expectedIds = rows.map((r) => r.id).sort();
    assert.deepEqual(writtenIds, expectedIds);
  });
});

test("K7. rows with identical resolved_at and different ids are neither skipped nor duplicated across page boundaries", async () => {
  // Build a dataset where a 6-row group shares one resolved_at timestamp,
  // positioned so pageSize=4 splits the group across two pages (rows
  // 3,4,5 fall on page 1; rows 6,7,8 fall on page 2 of that group).
  const sharedTimestamp = CUTOFF.toISOString();
  const rows: FakeKeysetRow[] = [];
  for (let i = 0; i < 2; i++) {
    rows.push(makeKeysetRow(new Date(CUTOFF.getTime() + 1000).toISOString(), String(999 - i).padStart(4, "0")));
  }
  const groupIds = ["000900", "000800", "000700", "000600", "000500", "000400"];
  for (const id of groupIds) {
    rows.push(makeKeysetRow(sharedTimestamp, id));
  }
  for (let i = 0; i < 2; i++) {
    rows.push(makeKeysetRow(new Date(CUTOFF.getTime() - 1000 * (i + 1)).toISOString(), String(300 - i).padStart(4, "0")));
  }
  // rows is already in resolved_at DESC, id DESC order by construction.
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 4,
    });
    assert.equal(result.fetchedRows, rows.length);
    const written = JSON.parse(readFileSync(outputPath, "utf8")) as Array<{ id: string }>;
    const writtenIds = written.map((r) => r.id);
    const expectedIds = rows.map((r) => r.id);
    // No duplicates.
    assert.equal(new Set(writtenIds).size, writtenIds.length);
    // Every expected id present exactly once, in the same relative order.
    assert.deepEqual(writtenIds, expectedIds);
  });
});

test("K8. short final page returns completionProof LAST_PAGE_SHORT and exportCompleteness COMPLETE_BY_EXHAUSTION", async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.completionProof, "LAST_PAGE_SHORT");
    assert.equal(result.exportCompleteness, "COMPLETE_BY_EXHAUSTION");
  });
});

test("K9. empty final page returns completionProof EMPTY_PAGE and exportCompleteness COMPLETE_BY_EXHAUSTION", async () => {
  const rows = generateDescendingRows(2000, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.fetchedRows, 2000);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.completionProof, "EMPTY_PAGE");
    assert.equal(result.exportCompleteness, "COMPLETE_BY_EXHAUSTION");
  });
});

test("K10. summary includes paginationMode KEYSET_RESOLVED_AT_ID", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    assert.equal(result.paginationMode, "KEYSET_RESOLVED_AT_ID");
  });
});

test("K11. no count endpoint is called (no Prefer header, no count=exact anywhere in source)", async () => {
  const rows = generateDescendingRows(1200, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    assert.ok(calls.every((c) => c.init.headers?.Prefer === undefined));
  });
  const source = readSource();
  assert.doesNotMatch(source, /count=exact/);
  assert.doesNotMatch(source, /Content-Range/);
});

test("K12. default full path contains no ROI/PnL/profit result keys", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    const keys = Object.keys(result);
    assert.ok(!keys.some((k) => /roi|pnl|profit/i.test(k)));
  });
});

test("K13. debug --max-rows remains intentionally capped and never reports complete", { timeout: 5000 }, async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
      maxRows: 500,
    });
    assert.equal(result.exportMode, "DEBUG_CAPPED");
    assert.equal(result.exportCompleteness, "INTENTIONALLY_CAPPED");
    assert.notEqual(result.exportCompleteness, "COMPLETE_BY_EXHAUSTION");
    assert.equal(result.fetchedRows, 500);
    assert.equal(result.paginationMode, "KEYSET_RESOLVED_AT_ID");
  });
});

test("K13b. debug --max-rows spanning multiple pages still uses keyset cursors correctly", { timeout: 5000 }, async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
      maxRows: 2500,
    });
    assert.equal(result.fetchedRows, 2500);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].url.includes("or="));
    assert.ok(calls[2].url.includes("or="));
  });
});

test("K14. missing cursor fields produce KEYSET_CURSOR_FIELDS_MISSING and do not report completeness", { timeout: 5000 }, async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: (ctx) => {
      if (ctx.pageNumber === 1) {
        // First page: return a full page, but strip resolved_at/id from
        // the last row so no valid cursor can be extracted.
        const page = rows.slice(0, ctx.limit).map((r) => ({ ...r }));
        (page[page.length - 1] as Record<string, unknown>).resolved_at = "";
        (page[page.length - 1] as Record<string, unknown>).id = "";
        return makeFakeResponse({ ok: true, status: 200, json: async () => page });
      }
      return null;
    },
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () =>
        exportGeneratedSignalPairsFromSupabase({
          fetchImpl: fetchImpl as never,
          env: FAKE_ENV,
          outputPath,
          pageSize: 1000,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /KEYSET_CURSOR_FIELDS_MISSING/);
        return true;
      },
    );
  });
});

test("K15. repeated/non-advancing cursor produces CURSOR_DID_NOT_ADVANCE and does not loop forever", { timeout: 5000 }, async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const firstPage = rows.slice(0, 1000);
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: (ctx) => {
      if (ctx.pageNumber >= 2) {
        // Every subsequent page returns the identical first page again --
        // simulates a cursor filter that failed to narrow the result set.
        return makeFakeResponse({ ok: true, status: 200, json: async () => firstPage });
      }
      return null;
    },
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () =>
        exportGeneratedSignalPairsFromSupabase({
          fetchImpl: fetchImpl as never,
          env: FAKE_ENV,
          outputPath,
          pageSize: 1000,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /CURSOR_DID_NOT_ADVANCE/);
        return true;
      },
    );
  });
});

test("K16. failed keyset request includes safe page/mode diagnostics without secret or body leakage", async () => {
  const rows = generateDescendingRows(10, CUTOFF);
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: () =>
      makeFakeResponse({
        ok: false,
        status: 500,
        json: async () => ({ message: "raw-supabase-error-body-should-not-leak" }),
      }),
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /page 1/);
        assert.match(error.message, /500/);
        assert.match(error.message, /KEYSET_RESOLVED_AT_ID/);
        assert.match(error.message, /first-page/);
        assert.doesNotMatch(error.message, /raw-supabase-error-body-should-not-leak/);
        assert.doesNotMatch(error.message, /fake-service-role-key/);
        return true;
      },
    );
  });
});

test("K17. existing schema-drift normalization remains unchanged under keyset transport", async () => {
  const rows = generateDescendingRows(1, CUTOFF);
  const { token_id: _drop, ...rowWithoutTokenId } = rows[0] as unknown as Record<string, unknown>;
  const rowsWithDrift = [
    {
      ...rowWithoutTokenId,
      selected_token_id: "drift-token",
      diagnostics: { entryPrice: 0.3 },
    },
  ];
  const { fetchImpl } = makeFakeFetch({ rows: rowsWithDrift as unknown as FakeKeysetRow[] });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const written = JSON.parse(readFileSync(outputPath, "utf8")) as Array<Record<string, unknown>>;
    assert.equal(written[0].token_id, "drift-token");
    assert.equal(written[0].entry_price_num, 0.3);
  });
});

test("K18. does not include insert/update/delete/upsert/rpc/write calls (keyset transport)", () => {
  const source = readSource();
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /\.update\(/);
  assert.doesNotMatch(source, /\.delete\(/);
  assert.doesNotMatch(source, /\.upsert\(/);
  assert.doesNotMatch(source, /\.rpc\(/);
});

test("K19. does not print/log env values or raw rows in source", () => {
  const source = readSource();
  assert.doesNotMatch(source, /console\./);
});

test("K20. writes export file to modeling/local_exports/generated_signal_pairs_export.json (relative default)", () => {
  const source = readSource();
  assert.match(source, /generated_signal_pairs_export\.json/);
});

test("K21. generated output is a JSON array", async () => {
  const rows = generateDescendingRows(1, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    assert.equal(result.fetchedRows, 1);
    const written = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.ok(Array.isArray(written));
    assert.equal(written.length, 1);
  });
});

test("K22. no ROI/PnL/profit keys are added by exporter (normalization)", () => {
  const row = { id: "a", condition_id: "c1", token_id: "t1", real_pnl_usd: 5, realized_return_pct: 10 };
  const normalized = normalizeGeneratedSignalPairRow(row);
  const keys = Object.keys(normalized);
  assert.ok(!keys.some((k) => /roi/i.test(k)));
  assert.equal(normalized.real_pnl_usd, 5);
  assert.equal(normalized.realized_return_pct, 10);
});

test("K23. summary includes a valid ISO exportCutoffResolvedAt captured at export start", async () => {
  const before = new Date();
  const rows = generateDescendingRows(1, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    const after = new Date();
    const cutoff = new Date(result.exportCutoffResolvedAt);
    assert.ok(!Number.isNaN(cutoff.getTime()));
    assert.ok(cutoff.getTime() >= before.getTime() - 1000);
    assert.ok(cutoff.getTime() <= after.getTime() + 1000);
  });
});

// ---- Phase 3E.2: export summary sidecar ----

test("S1. exporter supports summaryOutputPath and writes a sidecar summary file", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
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
    assert.equal(summary.paginationMode, "KEYSET_RESOLVED_AT_ID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2. summary file contains the full compact summary shape (keyset exhaustion contract)", async () => {
  const rows = generateDescendingRows(2500, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
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
      "paginationMode",
    ]) {
      assert.ok(key in summary, `expected summary key ${key}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3. summary file contains no raw rows", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
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
  const rows = generateDescendingRows(1, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
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
  const rows = generateDescendingRows(2, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    assert.equal(result.fetchedRows, 2);
    assert.equal(result.exportCompleteness, "COMPLETE_BY_EXHAUSTION");
  });
});
