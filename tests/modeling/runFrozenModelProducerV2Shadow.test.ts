import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runFrozenModelProducerV2Shadow } from "../../lib/modeling/strategies/runFrozenModelProducerV2Shadow";

const AS_OF = "2026-07-20T12:00:00.000Z";

function fixtureRow(overrides: Record<string, unknown> = {}) {
  return {
    condition_id: "cond-1",
    token_id: "tok-1",
    selected_outcome: "TEAM_A",
    score: 80,
    entry_price_num: 0.5,
    created_at: "2026-07-20T11:30:00.000Z", // exactly 90 minutes before game start (T-90 boundary)
    event_slug: "nba-team-a-vs-team-b",
    market_slug: "nba-team-a-vs-team-b-moneyline",
    diagnostics: { gameStartIso: "2026-07-20T13:00:00.000Z" },
    ...overrides,
  };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "frozen-model-v2-shadow-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("errors when --as-of is missing", async () => {
  await assert.rejects(() => runFrozenModelProducerV2Shadow(["--output", "/tmp/x.json"]), /FROZEN_RUNNER_AS_OF_REQUIRED/);
});

test("errors when --output is missing", async () => {
  await assert.rejects(
    () => runFrozenModelProducerV2Shadow(["--as-of", AS_OF]),
    /FROZEN_RUNNER_OUTPUT_REQUIRED/,
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
        () => runFrozenModelProducerV2Shadow(["--as-of", AS_OF, "--output", output]),
        /FROZEN_RUNNER_NO_FIXTURE_AND_MISSING_SUPABASE_ENV/,
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
        runFrozenModelProducerV2Shadow([
          "--as-of",
          AS_OF,
          "--output",
          output,
          "--fixture",
          path.join(dir, "missing.json"),
        ]),
      /FROZEN_RUNNER_FIXTURE_NOT_FOUND/,
    );
  });
});

test("runs against a JSON array fixture and writes a deterministic artifact with matching sha256", async () => {
  await withTmpDir(async (dir) => {
    const fixturePath = path.join(dir, "fixture.json");
    const outputPath = path.join(dir, "out.json");
    writeFileSync(fixturePath, JSON.stringify([fixtureRow()]), "utf8");

    const summary = await runFrozenModelProducerV2Shadow([
      "--as-of",
      AS_OF,
      "--output",
      outputPath,
      "--fixture",
      fixturePath,
    ]);

    assert.equal(summary.acceptedCount, 1);
    assert.equal(summary.rejectedCount, 0);
    assert.ok(existsSync(outputPath));
    const written = readFileSync(outputPath, "utf8");
    const actualSha = createHash("sha256").update(written).digest("hex");
    assert.equal(summary.artifactSha256, actualSha);

    const parsed = JSON.parse(written);
    assert.equal(parsed.modelVersion, "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M");
    assert.equal(parsed.acceptedDecisions.length, 1);
  });
});

test("runs against a JSONL fixture", async () => {
  await withTmpDir(async (dir) => {
    const fixturePath = path.join(dir, "fixture.jsonl");
    const outputPath = path.join(dir, "out.json");
    const lines = [fixtureRow(), fixtureRow({ condition_id: "cond-2", token_id: "tok-2", score: 40 })]
      .map((row) => JSON.stringify(row))
      .join("\n");
    writeFileSync(fixturePath, lines, "utf8");

    const summary = await runFrozenModelProducerV2Shadow([
      "--as-of",
      AS_OF,
      "--output",
      outputPath,
      "--fixture",
      fixturePath,
    ]);

    assert.equal(summary.acceptedCount, 1);
    assert.equal(summary.rejectedCount, 1);
  });
});

test("repeated runs against the same fixture produce byte-identical artifacts", async () => {
  await withTmpDir(async (dir) => {
    const fixturePath = path.join(dir, "fixture.json");
    const outputPathA = path.join(dir, "out-a.json");
    const outputPathB = path.join(dir, "out-b.json");
    writeFileSync(fixturePath, JSON.stringify([fixtureRow()]), "utf8");

    const summaryA = await runFrozenModelProducerV2Shadow([
      "--as-of",
      AS_OF,
      "--output",
      outputPathA,
      "--fixture",
      fixturePath,
    ]);
    const summaryB = await runFrozenModelProducerV2Shadow([
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

test("production Supabase read path always applies a bounded limit (explicit --limit or a default bound), never an unbounded select", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(
    new URL("../../lib/modeling/strategies/runFrozenModelProducerV2Shadow.ts", import.meta.url),
    "utf8",
  );
  // The Supabase query must always chain a .limit(...) call -- there must be
  // no code path where .select("*") is awaited without a preceding/following
  // .limit(...) in the same statement.
  assert.match(source, /supabaseAdmin\.from\("generated_signal_pairs"\)\.select\("\*"\)\.limit\(/);
  assert.match(source, /DEFAULT_SUPABASE_ROW_LIMIT/);
});

test("does not import any reservation/queue/Ireland/CLOB module", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(
    new URL("../../lib/modeling/strategies/runFrozenModelProducerV2Shadow.ts", import.meta.url),
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
});
