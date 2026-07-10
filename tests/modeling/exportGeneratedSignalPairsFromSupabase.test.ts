import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  normalizeGeneratedSignalPairRow,
  exportGeneratedSignalPairsFromSupabase,
  resolveSupabaseReadConfig,
  GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS,
  buildSelectParam,
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
  text?: () => Promise<string>;
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
    text: opts.text ?? (async () => (opts.json ? JSON.stringify(await opts.json()) : "")),
  };
}

// Parses the canonical `and=(resolved_at.not.is.null,resolved_at.lte.<cutoff>)`
// filter this transport uses instead of duplicate `resolved_at` query keys.
function parseCutoffFromAndFilter(andValue: string | null): string | null {
  if (!andValue) return null;
  const match = /resolved_at\.lte\.([^,)]+)/.exec(andValue);
  return match ? match[1] : null;
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
    const cutoff = parseCutoffFromAndFilter(parsedUrl.searchParams.get("and"));
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

test("K3. first request contains a single canonical and-cutoff filter, order resolved_at.desc,id.desc, limit=1000, no cursor", async () => {
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
    const andValue = first.searchParams.get("and");
    assert.ok(andValue, "expected a canonical and=(...) cutoff filter");
    assert.match(andValue as string, /resolved_at\.not\.is\.null/);
    assert.match(andValue as string, /resolved_at\.lte\./);
    assert.equal(first.searchParams.getAll("resolved_at").length, 0, "no duplicate resolved_at query keys");
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

test("K16. failed keyset request includes safe page/mode diagnostics and never leaks credentials (Patch C: a bounded PostgREST message field is expected, not a leak)", async () => {
  const rows = generateDescendingRows(10, CUTOFF);
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: () =>
      makeFakeResponse({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ message: "a short bounded postgrest message" }),
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

// ---- Phase 3E.2e: explicit select allowlist (Patch A) ----

const REQUIRED_DOWNSTREAM_FIELDS = [
  // normalization
  "id",
  "condition_id",
  "token_id",
  "selected_token_id",
  "created_at",
  "resolved_at",
  "formula_version",
  "metric_formula_version",
  "score",
  "signal_score",
  "pre_event_score_num",
  "coverage",
  "coverage_score",
  "signal_result",
  "result",
  "outcome_status",
  "winning_outcome",
  "selected_outcome",
  "entry_price_num",
  "entry_price",
  "realized_return_pct",
  "real_pnl_usd",
  "match_family_key",
  "canonical_event_key",
  "parent_event_key",
  "event_slug",
  "event_title",
  "market_slug",
  "league",
  "hours_until_start",
  "diagnostics",
];

test("A1. default query does not use select=*", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const first = new URL(calls[0].url);
    assert.notEqual(first.searchParams.get("select"), "*");
  });
});

test("A2. exact physical-schema select allowlist is present on every request (not the broader normalizer compat list)", async () => {
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
    for (const call of calls) {
      const url = new URL(call.url);
      assert.equal(url.searchParams.get("select"), GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS.join(","));
    }
  });
});

test("A3. the fields structurally required by dedup, DQA-R4, the trusted-formula strategy, and ROI are all physically selected", () => {
  const physical = new Set(GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS as readonly string[]);
  // Fields with no genuine live-data substitute -- if any of these were
  // missing from the physical schema, the corresponding downstream
  // consumer would have no way to function at all on real Supabase rows.
  // (Redundant alias-only inputs like signal_score/coverage_score/result/
  // outcome_status/entry_price are intentionally NOT required here -- see
  // P3 -- because normalizer's primary physical-backed field already
  // covers each: score/coverage via pre_event_score_num, signal_result via
  // signal_result itself, entry_price_num directly.)
  const structurallyRequired = [
    "id",
    "condition_id",
    "selected_token_id", // -> normalized token_id
    "created_at",
    "resolved_at",
    "formula_version",
    "metric_formula_version",
    "signal_result",
    "entry_price_num",
    "realized_return_pct",
    "winning_outcome",
  ];
  for (const field of structurallyRequired) {
    assert.ok(physical.has(field), `expected "${field}" to be physically selected`);
  }
});

test("A4. buildSelectParam() returns the comma-joined physical-schema allowlist", () => {
  assert.equal(buildSelectParam(), GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS.join(","));
});

test("A5. normalization still works with a physical-schema-shaped row (no extra unselected fields)", () => {
  const row: Record<string, unknown> = {};
  for (const field of GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS) {
    row[field] = field === "diagnostics" ? { entryPrice: 0.2 } : `value-${field}`;
  }
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.id, "value-id");
  assert.equal(normalized.condition_id, "value-condition_id");
  // selected_token_id is physical; token_id is not -- normalizer must still
  // produce a token_id from the physical selected_token_id field.
  assert.equal(normalized.token_id, "value-selected_token_id");
});

// ---- Phase 3E.2f: physical-schema REST select vs normalizer compat layer ----

test("P1. REST select contains only the 27 verified physical columns", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const selectValue = new URL(calls[0].url).searchParams.get("select") as string;
    const selectedFields = selectValue.split(",");
    assert.equal(selectedFields.length, 27);
    assert.deepEqual(selectedFields, [...GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS]);
  });
});

test("P2. token_id is not included in the REST SELECT", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const selectedFields = (new URL(calls[0].url).searchParams.get("select") as string).split(",");
    assert.ok(!selectedFields.includes("token_id"));
  });
});

test("P3. other absent aliases are not included in the REST SELECT", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const selectedFields = (new URL(calls[0].url).searchParams.get("select") as string).split(",");
    for (const absentField of [
      "signal_score",
      "coverage",
      "coverage_score",
      "result",
      "outcome_status",
      "entry_price",
      "real_pnl_usd",
      "match_family_key",
      "canonical_event_key",
      "parent_event_key",
      "event_title",
      "league",
      "hours_until_start",
    ]) {
      assert.ok(!selectedFields.includes(absentField), `expected "${absentField}" to be absent from REST select`);
    }
  });
});

test("P4. selected_token_id is included in the REST SELECT", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const selectedFields = (new URL(calls[0].url).searchParams.get("select") as string).split(",");
    assert.ok(selectedFields.includes("selected_token_id"));
  });
});

test("P5. score, pre_event_score_num, entry_price_num, signal_result, winning_outcome, realized_return_pct are included", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const selectedFields = (new URL(calls[0].url).searchParams.get("select") as string).split(",");
    for (const requiredField of [
      "score",
      "pre_event_score_num",
      "entry_price_num",
      "signal_result",
      "winning_outcome",
      "realized_return_pct",
    ]) {
      assert.ok(selectedFields.includes(requiredField), `expected "${requiredField}" to be present in REST select`);
    }
  });
});

test("P6. normalizer still accepts fixture input containing legacy aliases such as token_id", () => {
  const row = { id: "a", condition_id: "c1", token_id: "legacy-token-value" };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.token_id, "legacy-token-value");
});

test("P7. normalizer still maps selected_token_id into canonical token identity", () => {
  const row = { id: "a", condition_id: "c1", selected_token_id: "physical-token-value" };
  const normalized = normalizeGeneratedSignalPairRow(row);
  assert.equal(normalized.token_id, "physical-token-value");
});

test("P8. keyset query shape (order, limit, cursor) is unchanged by the physical-schema select", async () => {
  const rows = generateDescendingRows(1500, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    const first = new URL(calls[0].url);
    assert.equal(first.searchParams.get("order"), "resolved_at.desc,id.desc");
    assert.equal(first.searchParams.get("limit"), "1000");
    assert.equal(first.searchParams.get("or"), null);
    const second = new URL(calls[1].url);
    assert.ok(second.searchParams.get("or"));
  });
});

test("P9. canonical and-cutoff filter is unchanged by the physical-schema select", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    const andValue = new URL(calls[0].url).searchParams.get("and") as string;
    assert.match(andValue, /resolved_at\.not\.is\.null/);
    assert.match(andValue, /resolved_at\.lte\./);
  });
});

test("P10. safe PostgREST diagnostics remain unchanged", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: () =>
      makeFakeResponse({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ code: "42703", message: "column generated_signal_pairs.token_id does not exist" }),
      }),
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /postgrestCode=42703/);
        assert.match(error.message, /does not exist/);
        return true;
      },
    );
  });
});

test("P11. no count, offset, or select=* regression", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath });
    for (const call of calls) {
      const url = new URL(call.url);
      assert.notEqual(url.searchParams.get("select"), "*");
      assert.equal(url.searchParams.get("offset"), null);
      assert.equal(url.searchParams.get("Prefer"), null);
    }
  });
});

// ---- Phase 3E.2e: canonical and-filter encoding (Patch B) ----

test("B1. duplicate resolved_at query keys are absent", async () => {
  const rows = generateDescendingRows(1500, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1000,
    });
    for (const call of calls) {
      const url = new URL(call.url);
      assert.equal(url.searchParams.getAll("resolved_at").length, 0);
    }
  });
});

test("B2. cursor page preserves both the canonical and-cutoff filter and the composite or-cursor filter", async () => {
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
    assert.ok(second.searchParams.get("and"), "cursor page must still carry the cutoff filter");
    assert.ok(second.searchParams.get("or"), "cursor page must still carry the cursor filter");
  });
});

test("B3. order remains resolved_at.desc,id.desc and limit is preserved with the new filter encoding", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const { fetchImpl, calls } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 250,
    });
    const first = new URL(calls[0].url);
    assert.equal(first.searchParams.get("order"), "resolved_at.desc,id.desc");
    assert.equal(first.searchParams.get("limit"), "250");
  });
});

test("B4. UUID-shaped cursor ids are passed through verbatim, not lexically reinterpreted", async () => {
  const uuidRows: FakeKeysetRow[] = [
    makeKeysetRow("2026-07-10T00:00:02.000Z", "3f9e1c2a-1111-4a11-8a11-abcdefabcdef"),
    makeKeysetRow("2026-07-10T00:00:01.000Z", "1a2b3c4d-2222-4a11-8a11-abcdefabcdef"),
    makeKeysetRow("2026-07-10T00:00:00.000Z", "0f0e0d0c-3333-4a11-8a11-abcdefabcdef"),
  ];
  const { fetchImpl, calls } = makeFakeFetch({ rows: uuidRows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      pageSize: 1,
    });
    assert.equal(result.fetchedRows, 3);
    const second = new URL(calls[1].url);
    const orValue = second.searchParams.get("or") as string;
    assert.match(orValue, /id\.lt\.3f9e1c2a-1111-4a11-8a11-abcdefabcdef/);
  });
});

// ---- Phase 3E.2e: safe PostgREST error diagnostics (Patch C) ----

test("C1. safe JSON PostgREST error includes code/message/hint", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: () =>
      makeFakeResponse({
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({
            code: "42883",
            message: "operator does not exist: uuid < unknown",
            details: null,
            hint: "No operator matches the given name and argument types.",
          }),
      }),
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /postgrestCode=42883/);
        assert.match(error.message, /operator does not exist/);
        assert.match(error.message, /No operator matches/);
        return true;
      },
    );
  });
});

test("C2. diagnostics are bounded to a safe maximum length", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const hugeMessage = "x".repeat(5000);
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: () =>
      makeFakeResponse({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ code: "XXXXX", message: hugeMessage }),
      }),
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // The whole error, including the "Export failed (...)" prefix, must
        // stay well short of a full 5000-char dump.
        assert.ok(error.message.length < 1200, `error message too long: ${error.message.length}`);
        return true;
      },
    );
  });
});

test("C3. token/authorization-like values are redacted from error diagnostics", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const fakeJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.4Adcj3UFYzPUVaVF43FmMab6RlaQD8A9V8wFzzht-KQ";
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: () =>
      makeFakeResponse({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({ message: `Invalid token: Bearer ${fakeJwt}`, hint: `apikey=${fakeJwt}` }),
      }),
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(fakeJwt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(error.message, /fake-service-role-key/);
        return true;
      },
    );
  });
});

test("C4. successful response body is never logged in an error path (non-JSON error body is bounded, not dumped raw)", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const hugeHtml = `<html><body>${"a".repeat(3000)}</body></html>`;
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: () =>
      makeFakeResponse({
        ok: false,
        status: 502,
        text: async () => hugeHtml,
      }),
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length < 1200);
        assert.match(error.message, /502/);
        return true;
      },
    );
  });
});

test("C5. error diagnostics include page number, page context, and paginationMode", async () => {
  const rows = generateDescendingRows(5, CUTOFF);
  const { fetchImpl } = makeFakeFetch({
    rows,
    pageOverride: () => makeFakeResponse({ ok: false, status: 500, text: async () => "" }),
  });
  await withTempDir(async (outputPath) => {
    await assert.rejects(
      () => exportGeneratedSignalPairsFromSupabase({ fetchImpl: fetchImpl as never, env: FAKE_ENV, outputPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /page 1/);
        assert.match(error.message, /first-page/);
        assert.match(error.message, /paginationMode=KEYSET_RESOLVED_AT_ID/);
        return true;
      },
    );
  });
});

// ---- Phase 3E.2e: success sentinel (Patch D support) ----

test("D1. exporter writes a success sentinel file only after export and summary writes complete", async () => {
  const rows = generateDescendingRows(3, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const summaryPath = path.join(dir, "summary.json");
  const sentinelPath = path.join(dir, "sentinel.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      summaryOutputPath: summaryPath,
      sentinelOutputPath: sentinelPath,
    });
    const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
    assert.equal(sentinel.status, "SUCCESS");
    assert.equal(typeof sentinel.schemaVersion, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D2. without sentinelOutputPath, no sentinel file behavior changes anything else", async () => {
  const rows = generateDescendingRows(2, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  await withTempDir(async (outputPath) => {
    const result = await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
    });
    assert.equal(result.fetchedRows, 2);
  });
});

test("D3. sentinel contains no secrets", async () => {
  const rows = generateDescendingRows(1, CUTOFF);
  const { fetchImpl } = makeFakeFetch({ rows });
  const dir = mkdtempSync(path.join(tmpdir(), "supabase-export-test-"));
  const outputPath = path.join(dir, "export.json");
  const sentinelPath = path.join(dir, "sentinel.json");
  try {
    await exportGeneratedSignalPairsFromSupabase({
      fetchImpl: fetchImpl as never,
      env: FAKE_ENV,
      outputPath,
      sentinelOutputPath: sentinelPath,
    });
    const raw = readFileSync(sentinelPath, "utf8");
    assert.doesNotMatch(raw, /fake-service-role-key/);
    assert.doesNotMatch(raw, /condition_id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Existing keyset boundary/completeness tests must still pass unchanged ----

test("K24. existing keyset boundary and completeness behavior is unaffected by Patch A/B/C/D", async () => {
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
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.completionProof, "LAST_PAGE_SHORT");
    assert.equal(result.exportCompleteness, "COMPLETE_BY_EXHAUSTION");
    assert.equal(result.paginationMode, "KEYSET_RESOLVED_AT_ID");
  });
});
