import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runFrozenExecutionContractBridge } from "../../lib/modeling/strategies/runFrozenExecutionContractBridge";

const AS_OF = "2026-07-20T12:00:00.000Z";

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    condition_id: "cond-1",
    token_id: "tok-1",
    selected_outcome: "TEAM_A",
    score: 80,
    entry_price_num: 0.5,
    created_at: "2026-07-20T11:30:00.000Z",
    event_slug: "nba-team-a-vs-team-b",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    canonical_market_key: "nba-team-a-vs-team-b-moneyline",
    inferred_sport: "NBA",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
    ...overrides,
  };
}

function contur3Candidate(overrides: Record<string, unknown> = {}) {
  return {
    condition_id: "cond-1",
    token_id: "tok-1",
    side: "TEAM_A",
    selected_outcome: "TEAM_A",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    canonical_market_key: "nba-team-a-vs-team-b-moneyline",
    canonical_event_key: "nba-team-a-vs-team-b",
    match_family_key: "nba-team-a-vs-team-b",
    event_slug: "nba-team-a-vs-team-b",
    max_entry_price: 0.9,
    timing_bucket: "T_1_2H",
    inferred_sport: "NBA",
    market_family: "moneyline",
    ...overrides,
  };
}

function fixtureFile(dir: string, rows = [sourceRow()], candidates = [contur3Candidate()]) {
  const fixturePath = path.join(dir, "fixture.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({ frozenSourceRows: rows, contur3Candidates: candidates }),
    "utf8",
  );
  return fixturePath;
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "frozen-execution-bridge-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

test("runs against a fixture and writes a deterministic artifact with matching sha256", async () => {
  await withTmpDir(async (dir) => {
    const fixturePath = fixtureFile(dir);
    const outputPath = path.join(dir, "out.json");

    const summary = await runFrozenExecutionContractBridge([
      "--as-of",
      AS_OF,
      "--output",
      outputPath,
      "--fixture",
      fixturePath,
    ]);

    assert.equal(summary.frozenDecisionCount, 1);
    assert.equal(summary.contur3CandidateCount, 1);
    assert.equal(summary.exactCompatibleCount, 1);
    assert.ok(existsSync(outputPath));
    const written = readFileSync(outputPath, "utf8");
    const actualSha = createHash("sha256").update(written).digest("hex");
    assert.equal(summary.artifactSha256, actualSha);

    const parsed = JSON.parse(written);
    assert.equal(parsed.frozenModelVersion, "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M");
    assert.equal(parsed.comparisonRows.length, 1);
    assert.equal(parsed.classificationCounts.EXACT_EXECUTION_COMPATIBLE, 1);
  });
});

test("repeated runs against the same fixture produce byte-identical artifacts", async () => {
  await withTmpDir(async (dir) => {
    const fixturePath = fixtureFile(dir);
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

test("production Supabase read path always applies a bounded limit, never an unbounded select", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(
    new URL("../../lib/modeling/strategies/runFrozenExecutionContractBridge.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /supabaseAdmin\.from\("generated_signal_pairs"\)\.select\("\*"\)\.limit\(/);
  assert.match(source, /DEFAULT_SUPABASE_ROW_LIMIT/);
  // Contur3 live read must also pass an explicit bounded limit into
  // buildFireModelCandidates(limit, ...), never an unbounded call.
  assert.match(source, /buildFireModelCandidates\(boundedLimit, "all", true\)/);
});

test("does not import any write-side execution module (reservations/queue writes/order events/Ireland/CLOB)", async () => {
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
  // buildFireModelCandidates itself (the Contur3 READ path) is fine and
  // expected to be dynamically imported in live mode.
  assert.match(source, /buildFireModelCandidates/);
});
