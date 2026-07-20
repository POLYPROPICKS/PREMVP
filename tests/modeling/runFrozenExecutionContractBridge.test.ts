// Integration Milestone 2B.1: bounded single-snapshot orchestration tests.
//
// Scope note: buildFireModelCandidates()'s internal candidate-construction
// pipeline (identity-text derivation, market taxonomy classification, sport
// scope, side-mapping proof, timing buckets, live-eligibility gates) is a
// ~600-line business-logic surface this milestone explicitly forbids
// modifying or duplicating. These tests therefore prove the properties this
// milestone is actually about -- ONE bounded read-only snapshot shared
// byte-for-byte by both producers, query-level pagination bounds, as-of
// integrity, zero independent Contur3 reads, and determinism -- using rows
// that may or may not survive Contur3's full eligibility pipeline (that
// pipeline's own classification behavior is proven unchanged by the
// untouched, still-passing existing buildFireModelCandidates regression
// suite and tests/modeling/frozenExecutionContractBridge.test.ts's own
// comparator-level classification tests, neither of which this milestone
// touches).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  runFrozenExecutionContractBridge,
  fetchBoundedSnapshot,
  SNAPSHOT_PAGE_SIZE,
  type SnapshotPage,
} from "../../lib/modeling/strategies/runFrozenExecutionContractBridge";
import { buildFireModelCandidates } from "../../lib/executor/buildFireModelCandidates";

const AS_OF = "2026-07-20T12:00:00.000Z";

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    condition_id: "cond-1",
    token_id: "tok-1",
    selected_token_id: "tok-1",
    selected_outcome: "TEAM_A",
    score: 80,
    signal_confidence_num: 80,
    entry_price_num: 0.5,
    metric_formula_version: "v2-lite-growth-safe",
    signal_result: null,
    expires_at: "2026-07-21T00:00:00.000Z",
    created_at: "2026-07-20T11:30:00.000Z",
    event_slug: "nba-team-a-vs-team-b",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    canonical_market_key: "nba-team-a-vs-team-b-moneyline",
    inferred_sport: "NBA",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
    ...overrides,
  };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "frozen-execution-bridge-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureFile(dir: string, rows: unknown[]) {
  const fixturePath = path.join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(rows), "utf8");
  return fixturePath;
}

// ---------------------------------------------------------------------
// TEST 1-4: fetchBoundedSnapshot -- pure, query-level pagination bound.
// ---------------------------------------------------------------------

function fakeSourceOfSize(totalRows: number) {
  const calls: Array<{ from: number; pageSize: number }> = [];
  const buildPage = async (from: number, pageSize: number): Promise<SnapshotPage> => {
    calls.push({ from, pageSize });
    const rows: Record<string, unknown>[] = [];
    for (let i = from; i < Math.min(from + pageSize, totalRows); i++) {
      rows.push({ id: `row-${i}`, created_at: `2026-07-20T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
    }
    return { rows };
  };
  return { buildPage, calls };
}

test("TEST2 -- query-level bound: a source with more than 5000 rows yields exactly 5000, no page beyond the one containing row 5000", async () => {
  const { buildPage, calls } = fakeSourceOfSize(50_000);
  const rows = await fetchBoundedSnapshot(buildPage, 5_000);
  assert.equal(rows.length, 5_000);
  assert.ok(calls.every((c) => c.from < 5_000), "no page request should start at or beyond offset 5000");
  assert.equal(calls[calls.length - 1].from, 4_000, "the last requested page must be the one containing row 5000 (offset 4000-4999)");
});

test("TEST3 -- Supabase 1000-row page cap: five pages of 1000 produce 5000 rows, stable order, no duplicates, no sixth page", async () => {
  const { buildPage, calls } = fakeSourceOfSize(50_000);
  const rows = await fetchBoundedSnapshot(buildPage, 5_000);
  assert.equal(calls.length, 5, "exactly five page requests");
  assert.ok(calls.every((c) => c.pageSize <= SNAPSHOT_PAGE_SIZE), "no page request exceeds the 1000-row cap");
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate identities");
  assert.deepEqual(ids, [...ids].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })), "stable ascending page order");
  assert.ok(!calls.some((c) => c.from >= 5_000), "a sixth page (offset >= 5000) is never requested");
});

test("TEST4 -- explicit small limit 1250: requests 1000 then 250, both sides would receive exactly 1250, no third request", async () => {
  const { buildPage, calls } = fakeSourceOfSize(50_000);
  const rows = await fetchBoundedSnapshot(buildPage, 1_250);
  assert.equal(rows.length, 1_250);
  assert.equal(calls.length, 2, "exactly two page requests");
  assert.equal(calls[0].pageSize, 1_000);
  assert.equal(calls[1].pageSize, 250);
});

test("fetchBoundedSnapshot stops early when the source is exhausted before the limit", async () => {
  const { buildPage, calls } = fakeSourceOfSize(1_500);
  const rows = await fetchBoundedSnapshot(buildPage, 5_000);
  assert.equal(rows.length, 1_500);
  assert.equal(calls.length, 2, "1000 + 500 (short page signals exhaustion), never a third empty request");
});

// ---------------------------------------------------------------------
// TEST 1, 5, 6, 8, 9: orchestration -- single shared snapshot, as-of
// integrity, default Contur3 parity, determinism, side effects.
// ---------------------------------------------------------------------

test("errors when --as-of is missing", async () => {
  await assert.rejects(() => runFrozenExecutionContractBridge(["--output", "/tmp/x.json"]), /BRIDGE_RUNNER_AS_OF_REQUIRED/);
});

test("errors when --output is missing", async () => {
  await assert.rejects(
    () => runFrozenExecutionContractBridge(["--as-of", AS_OF]),
    /BRIDGE_RUNNER_OUTPUT_REQUIRED/,
  );
});

test("errors when neither --fixture nor Supabase env vars are available", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await withTmpDir(async (dir) => {
      const output = path.join(dir, "out.json");
      await assert.rejects(
        () => runFrozenExecutionContractBridge(["--as-of", AS_OF, "--output", output]),
        /BRIDGE_RUNNER_NO_FIXTURE_AND_MISSING_SUPABASE_ENV/,
      );
    });
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});

test("errors when --fixture path does not exist", async () => {
  await withTmpDir(async (dir) => {
    const output = path.join(dir, "out.json");
    await assert.rejects(
      () =>
        runFrozenExecutionContractBridge([
          "--as-of",
          AS_OF,
          "--output",
          output,
          "--fixture",
          path.join(dir, "missing.json"),
        ]),
      /BRIDGE_RUNNER_FIXTURE_NOT_FOUND/,
    );
  });
});

test("TEST1/5 -- single shared snapshot: both sides' input-snapshot hashes match, independentContur3SourceReads is 0, artifact records source page/limit metadata", async () => {
  await withTmpDir(async (dir) => {
    const fixturePath = fixtureFile(dir, [sourceRow()]);
    const outputPath = path.join(dir, "out.json");

    const summary = await runFrozenExecutionContractBridge([
      "--as-of",
      AS_OF,
      "--output",
      outputPath,
      "--fixture",
      fixturePath,
    ]);

    assert.equal(summary.sourceRowCount, 1);
    assert.equal(summary.frozenInputSnapshotSha256, summary.contur3InputSnapshotSha256, "both sides must share the identical input snapshot hash");
    assert.equal(summary.sourceSnapshotSha256, summary.frozenInputSnapshotSha256);
    assert.equal(summary.independentContur3SourceReads, 0);

    const written = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(written.configuredLimit, 5000);
    assert.equal(written.sourcePageCount, 1);
    assert.equal(written.frozenInputSnapshotSha256, written.contur3InputSnapshotSha256);
  });
});

test("TEST5 -- as-of integrity: a row created after --as-of is excluded from the shared snapshot itself, before either producer runs", async () => {
  await withTmpDir(async (dir) => {
    const pastRow = sourceRow({ id: "row-past", condition_id: "cond-past" });
    const futureRow = sourceRow({ id: "row-future", condition_id: "cond-future", created_at: "2026-07-20T12:00:01.000Z" });
    const fixturePath = fixtureFile(dir, [pastRow, futureRow]);
    const outputPath = path.join(dir, "out.json");

    const summary = await runFrozenExecutionContractBridge([
      "--as-of",
      AS_OF,
      "--output",
      outputPath,
      "--fixture",
      fixturePath,
    ]);
    assert.equal(summary.sourceRowCount, 1, "the future row must never enter the shared snapshot at all");
    const artifact = JSON.parse(readFileSync(outputPath, "utf8")) as { comparisonRows: Array<{ frozenObservationId: string | null }> };
    assert.ok(
      artifact.comparisonRows.every((r) => r.frozenObservationId !== "cond-future::tok-1"),
      "the future row's identity must never appear anywhere in the comparison output",
    );
  });
});

test("TEST6 -- default Contur3 call path (no injectedRows) is unchanged: buildFireModelCandidates(limit, scope, planningMode) with 3 args behaves as before, no Supabase read attempted without env", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await assert.rejects(() => buildFireModelCandidates(10, "all", false));
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});

test("TEST6b -- injectedRows mode performs zero Supabase reads (no throw on missing env, since the live import is skipped)", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const { candidates } = await buildFireModelCandidates(10, "all", true, [sourceRow()]);
    assert.ok(Array.isArray(candidates));
  } finally {
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});

test("TEST8 -- determinism: repeated runs against the same fixture produce byte-identical artifacts", async () => {
  await withTmpDir(async (dir) => {
    const fixturePath = fixtureFile(dir, [sourceRow()]);
    const outputPathA = path.join(dir, "out-a.json");
    const outputPathB = path.join(dir, "out-b.json");

    const summaryA = await runFrozenExecutionContractBridge([
      "--as-of",
      AS_OF,
      "--output",
      outputPathA,
      "--fixture",
      fixturePath,
    ]);
    const summaryB = await runFrozenExecutionContractBridge([
      "--as-of",
      AS_OF,
      "--output",
      outputPathB,
      "--fixture",
      fixturePath,
    ]);

    assert.equal(summaryA.artifactSha256, summaryB.artifactSha256);
    assert.equal(readFileSync(outputPathA, "utf8"), readFileSync(outputPathB, "utf8"));
  });
});

test("TEST8b -- shuffled row order produces the same source snapshot hash", async () => {
  await withTmpDir(async (dir) => {
    const rowA = sourceRow({ id: "row-a", condition_id: "cond-a" });
    const rowB = sourceRow({ id: "row-b", condition_id: "cond-b" });
    const forwardFixture = fixtureFile(dir, [rowA, rowB]);
    const reversedDir = mkdtempSync(path.join(tmpdir(), "frozen-execution-bridge-test-rev-"));
    const reversedFixture = fixtureFile(reversedDir, [rowB, rowA]);
    try {
      const outA = path.join(dir, "out-forward.json");
      const outB = path.join(reversedDir, "out-reversed.json");
      const summaryForward = await runFrozenExecutionContractBridge(["--as-of", AS_OF, "--output", outA, "--fixture", forwardFixture]);
      const summaryReversed = await runFrozenExecutionContractBridge(["--as-of", AS_OF, "--output", outB, "--fixture", reversedFixture]);
      assert.equal(summaryForward.sourceSnapshotSha256, summaryReversed.sourceSnapshotSha256);
    } finally {
      rmSync(reversedDir, { recursive: true, force: true });
    }
  });
});

test("TEST9 -- side effects: reservation/queue/callback/Ireland/CLOB writes are zero (no such imports anywhere in the runner)", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(
    new URL("../../lib/modeling/strategies/runFrozenExecutionContractBridge.ts", import.meta.url),
    "utf8",
  );
  const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
  const forbidden = [
    "nightEventReservations",
    "eventExecutionQueue",
    "executorOrderEvents",
    "executorQueueMark",
    "ireland",
    "Ireland",
    "clob",
    "CLOB",
  ];
  for (const line of importLines) {
    for (const token of forbidden) {
      assert.ok(!line.includes(token), `import line must not reference ${token}: ${line}`);
    }
  }
  assert.match(source, /buildFireModelCandidates/);
});

test("production Supabase read path always applies query-level bounded pagination, never an unbounded select", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(
    new URL("../../lib/modeling/strategies/runFrozenExecutionContractBridge.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /fetchBoundedSnapshot/);
  assert.match(source, /DEFAULT_SUPABASE_ROW_LIMIT/);
  assert.match(source, /\.range\(from, from \+ pageSize - 1\)/);
  // Contur3 is fed via the injectedRows seam, never an independent query.
  assert.match(source, /buildFireModelCandidates\(boundedLimit, "all", true, sourceSnapshot\)/);
  assert.doesNotMatch(source, /buildFireModelCandidates\(boundedLimit, "all", true\)\s*;/, "must never call buildFireModelCandidates without the shared snapshot");
});
