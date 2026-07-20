// Contur3 planning-mode pagination reliability tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Exercises the REAL fetchAllPlanningRows pagination/retry/timeout logic
// through an injected fake query builder -- no live Supabase, no network,
// no real timers (a deterministic fake sleep is injected so tests run fast).
// This is the exact function the production night-reservation force-rebuild
// path calls twice per invocation (scored-rows + shadow-rows queries) to
// read generated_signal_pairs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchAllPlanningRows, type PlanningPageFetchError } from "../../lib/executor/buildFireModelCandidates";

const PAGE_SIZE = 1000;

function makeRow(id: number): { id: string } {
  return { id: `row-${id}` };
}

/**
 * A fake Supabase-shaped query builder. `pages` maps a page-start offset
 * ("from") to either a row array (success) or a fixed number of
 * "fail-then-succeed" attempts before that page's rows are finally returned.
 */
function makeFakeQueryBuilder(opts: {
  totalRows: number;
  failFirstNAttemptsAtFrom?: Map<number, number>; // from -> number of leading failures for that page
  alwaysFailAtFrom?: Set<number>; // from values that never succeed
}) {
  const attemptCounts = new Map<number, number>();
  const failFirstN = opts.failFirstNAttemptsAtFrom ?? new Map();
  const alwaysFail = opts.alwaysFailAtFrom ?? new Set();

  function builder() {
    return {
      range(from: number, to: number) {
        return {
          async abortSignal(_signal: AbortSignal) {
            const attemptNo = (attemptCounts.get(from) ?? 0) + 1;
            attemptCounts.set(from, attemptNo);

            if (alwaysFail.has(from)) {
              return { data: null, error: { message: "permanent transient failure" } };
            }
            const leadingFailures = failFirstN.get(from) ?? 0;
            if (attemptNo <= leadingFailures) {
              return { data: null, error: { message: "transient network blip" } };
            }
            const rows: Array<{ id: string }> = [];
            for (let i = from; i <= Math.min(to, opts.totalRows - 1); i++) {
              rows.push(makeRow(i));
            }
            return { data: rows, error: null };
          },
        };
      },
    };
  }
  return { builder, attemptCounts };
}

function fakeSleep(calls: number[]) {
  return async (ms: number) => {
    calls.push(ms);
  };
}

test("1: a single transient page failure is retried and the full corpus is returned complete, no duplicates", async () => {
  const { builder, attemptCounts } = makeFakeQueryBuilder({
    totalRows: 2500,
    failFirstNAttemptsAtFrom: new Map([[1000, 1]]), // page starting at 1000 fails once, then succeeds
  });
  const sleepCalls: number[] = [];

  const rows = await fetchAllPlanningRows(builder, {
    stage: "test_scored_rows_fetch",
    sleep: fakeSleep(sleepCalls),
  });

  assert.equal(rows.length, 2500, "must return the complete corpus after the retried page succeeds");
  const ids = rows.map((r: { id: string }) => r.id);
  assert.equal(new Set(ids).size, ids.length, "no row may be duplicated across pages");
  // Deterministic page order: row-0..row-999 (page 0), row-1000..row-1999 (page 1), row-2000..row-2499 (page 2).
  assert.equal(ids[0], "row-0");
  assert.equal(ids[999], "row-999");
  assert.equal(ids[1000], "row-1000");
  assert.equal(ids[ids.length - 1], "row-2499");
  assert.equal(attemptCounts.get(1000), 2, "the failing page must have been attempted exactly twice (1 fail + 1 success)");
  assert.equal(sleepCalls.length, 1, "exactly one backoff sleep for the single retried page");
});

test("2: a page that fails every attempt throws a typed, sanitized, stage-specific error with a bounded attempt count", async () => {
  const { builder } = makeFakeQueryBuilder({
    totalRows: 1500,
    alwaysFailAtFrom: new Set([0]),
  });
  const sleepCalls: number[] = [];

  await assert.rejects(
    () =>
      fetchAllPlanningRows(builder, {
        stage: "test_shadow_rows_fetch",
        retryPolicy: { maxAttempts: 3, backoffMs: () => 0, pageTimeoutMs: 15000 },
        sleep: fakeSleep(sleepCalls),
      }),
    (err: unknown) => {
      const e = err as PlanningPageFetchError;
      assert.ok(e instanceof Error);
      assert.equal(e.stage, "test_shadow_rows_fetch", "error must carry the stage name");
      assert.equal(e.page, 1, "error must carry the page number");
      assert.equal(e.attempts, 3, "error must carry the bounded attempt count");
      assert.match(e.message, /test_shadow_rows_fetch/);
      assert.match(e.message, /page=1/);
      assert.match(e.message, /attempts=3/);
      // Excludes URL credentials, auth headers, env values, raw payloads --
      // the fake error message never contained any of those, so assert the
      // sanitizer's redaction marker never appears spuriously and the raw
      // secret-shaped substring proof is exercised in test 2b below.
      return true;
    }
  );
  assert.equal(sleepCalls.length, 2, "must sleep between attempts 1->2 and 2->3, but not after the final failed attempt");
});

test("2b: a sanitized error never leaks secret-shaped query params from the underlying failure", async () => {
  const attemptCounts = new Map<number, number>();
  function builder() {
    return {
      range() {
        return {
          async abortSignal() {
            const n = (attemptCounts.get(0) ?? 0) + 1;
            attemptCounts.set(0, n);
            return {
              data: null,
              error: { message: "connection failed: postgres://user:pass@host?token=SECRETVALUE789" },
            };
          },
        };
      },
    };
  }
  await assert.rejects(
    () =>
      fetchAllPlanningRows(builder, {
        stage: "test_secret_redaction",
        retryPolicy: { maxAttempts: 1, backoffMs: () => 0, pageTimeoutMs: 15000 },
        sleep: async () => {},
      }),
    (err: unknown) => {
      const e = err as Error;
      assert.doesNotMatch(e.message, /token=SECRETVALUE789/, "secret-shaped query params must be redacted");
      return true;
    }
  );
});

test("7: a large deterministic multi-page corpus returns complete, deduplicated, deterministic results with linear page-fetch count", async () => {
  const totalRows = 12_450; // spans 13 pages of 1000 (12 full + 1 partial)
  const { builder, attemptCounts } = makeFakeQueryBuilder({ totalRows });

  const rows = await fetchAllPlanningRows(builder, {
    stage: "test_large_corpus",
    sleep: async () => {},
  });

  assert.equal(rows.length, totalRows, "must return every row exactly once");
  const ids = rows.map((r: { id: string }) => r.id);
  assert.equal(new Set(ids).size, ids.length, "zero duplicate rows across the full paginated scan");
  assert.deepEqual(ids, Array.from({ length: totalRows }, (_, i) => `row-${i}`), "row order is deterministic page-by-page");

  // Linear page count: ceil(12450/1000) = 13 distinct page "from" offsets attempted exactly once each
  // (no retries needed, no page attempted twice, no quadratic re-fetching of earlier pages).
  assert.equal(attemptCounts.size, 13, "exactly 13 distinct pages fetched for a 12,450-row corpus");
  for (const [, count] of attemptCounts) {
    assert.equal(count, 1, "each page fetched exactly once when no failures occur");
  }
});

test("timeout: a page whose query hangs past pageTimeoutMs is aborted and counted as a failed attempt", async () => {
  let sawAbort = false;
  function builder() {
    return {
      range() {
        return {
          abortSignal(signal: AbortSignal) {
            return new Promise((resolve) => {
              signal.addEventListener("abort", () => {
                sawAbort = true;
                resolve({ data: null, error: { message: "aborted" } });
              });
              // Never resolves on its own -- only the abort listener resolves it,
              // simulating a hung Supabase request.
            });
          },
        };
      },
    };
  }
  const sleepCalls: number[] = [];
  await assert.rejects(() =>
    fetchAllPlanningRows(builder, {
      stage: "test_timeout",
      retryPolicy: { maxAttempts: 1, backoffMs: () => 0, pageTimeoutMs: 20 },
      sleep: fakeSleep(sleepCalls),
    })
  );
  assert.ok(sawAbort, "the abort signal must actually fire after pageTimeoutMs");
});
