import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const CLI_PATH = path.join(
  ROOT,
  "scripts/modeling/strategies/run-readonly-comparison.ts",
);

async function withTempInputFile<T>(
  rows: unknown[],
  fn: (inputPath: string) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "readonly-comparison-cli-test-"));
  try {
    const inputPath = path.join(dir, "rows.json");
    await writeFile(inputPath, JSON.stringify(rows), "utf8");
    return await fn(inputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("node", ["--import", "tsx", CLI_PATH, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  });
}

test("CLI outputs valid JSON on stdout for a required-only run", async () => {
  await withTempInputFile(
    [
      { id: "a", formula_version: "trusted-initial-formula-v1.1" },
      { id: "b", formula_version: "other" },
    ],
    (inputPath) => {
      const result = runCli(["--input", inputPath, "--required-only"]);

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(typeof parsed.totalInputRows, "number");
      assert.ok(Array.isArray(parsed.strategies));
    },
  );
});

test("CLI output includes FORMULA_TRUSTED_INITIAL_V1_1_ALL", async () => {
  await withTempInputFile(
    [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }],
    (inputPath) => {
      const result = runCli(["--input", inputPath, "--required-only"]);

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.ok(
        parsed.strategies.some((s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL"),
      );
    },
  );
});

test("CLI output does not include ROI/PnL fields", async () => {
  await withTempInputFile(
    [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }],
    (inputPath) => {
      const result = runCli(["--input", inputPath, "--required-only"]);

      assert.equal(result.status, 0, result.stderr);
      const lower = result.stdout.toLowerCase();
      assert.ok(!lower.includes("\"roi\""));
      assert.ok(!lower.includes("\"pnl\""));
    },
  );
});

test("CLI exits non-zero when --input is missing", () => {
  const result = runCli(["--required-only"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--input/);
  assert.equal(result.stdout.trim(), "");
});

test("CLI exits non-zero for a nonexistent --input file", () => {
  const result = runCli(["--input", "/tmp/does-not-exist-12345.json"]);

  assert.notEqual(result.status, 0);
});

test("CLI does not require any environment variables to run", async () => {
  await withTempInputFile(
    [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }],
    (inputPath) => {
      // Run with a minimal env (only PATH, so node/tsx can be found) to
      // prove no SUPABASE_URL or other env var is required.
      const result = spawnSync("node", ["--import", "tsx", CLI_PATH, "--input", inputPath, "--required-only"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv,
      });

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.ok(Array.isArray(parsed.strategies));
    },
  );
});

test("CLI --all-ready includes strategies beyond just requiredForComparison ones", async () => {
  await withTempInputFile(
    [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }],
    (inputPath) => {
      const result = runCli(["--input", inputPath, "--all-ready"]);

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.strategies.some((s: { strategyId: string }) => s.strategyId === "BASELINE_V1_CONTROL"));
    },
  );
});

test("CLI with --input-format generated_signal_pairs includes inputValidation in output", async () => {
  await withTempInputFile(
    [
      { id: "a", formula_version: "trusted-initial-formula-v1.1" },
      { id: "b", signal_result: "won" }, // outcome quirk risk: no entry_price_num/realized_return_pct
    ],
    (inputPath) => {
      const result = runCli([
        "--input",
        inputPath,
        "--required-only",
        "--input-format",
        "generated_signal_pairs",
      ]);

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.ok(parsed.inputValidation, "expected inputValidation in CLI output");
      assert.equal(parsed.inputValidation.totalRows, 2);
      assert.equal(parsed.inputValidation.rowsWithFormulaVersion, 1);
      assert.equal(parsed.inputValidation.outcomeQuirkRiskRows, 1);
    },
  );
});

test("CLI --input-format generated_signal_pairs still includes FORMULA_TRUSTED_INITIAL_V1_1_ALL in required comparison", async () => {
  await withTempInputFile(
    [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }],
    (inputPath) => {
      const result = runCli([
        "--input",
        inputPath,
        "--required-only",
        "--input-format",
        "generated_signal_pairs",
      ]);

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.ok(
        parsed.strategies.some((s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL"),
      );
    },
  );
});

test("CLI --input-format generated_signal_pairs output still has no ROI/PnL/profit fields", async () => {
  await withTempInputFile(
    [{ id: "a", formula_version: "trusted-initial-formula-v1.1", signal_result: "won" }],
    (inputPath) => {
      const result = runCli([
        "--input",
        inputPath,
        "--required-only",
        "--input-format",
        "generated_signal_pairs",
      ]);

      assert.equal(result.status, 0, result.stderr);
      const lower = result.stdout.toLowerCase();
      assert.ok(!lower.includes("\"roi\""));
      assert.ok(!lower.includes("\"pnl\""));
      assert.ok(!lower.includes("profit"));
    },
  );
});

test("CLI default --input-format loose does not include inputValidation", async () => {
  await withTempInputFile(
    [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }],
    (inputPath) => {
      const result = runCli(["--input", inputPath, "--required-only"]);

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.inputValidation, undefined);
    },
  );
});

test("CLI exits non-zero for an invalid --input-format value", async () => {
  await withTempInputFile(
    [{ id: "a", formula_version: "trusted-initial-formula-v1.1" }],
    (inputPath) => {
      const result = runCli(["--input", inputPath, "--input-format", "not-a-real-format"]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /input-format/);
    },
  );
});

const DQA_R4_FIXTURE_ROWS = [
  // win, valid entry price -- not at risk
  { id: "a", formula_version: "trusted-initial-formula-v1.1", signal_result: "won", entry_price_num: 0.5 },
  // win, missing both entry price and realized return -- at risk (blocking)
  { id: "b", formula_version: "trusted-initial-formula-v1.1", signal_result: "won" },
  // loss, no entry price -- diagnostic only, not blocking
  { id: "c", signal_result: "lost" },
  // no result label at all
  { id: "d" },
];

test("CLI with --include-dqa-r4 and generated_signal_pairs format includes top-level dqaR4", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.dqaR4, "expected top-level dqaR4 in CLI output");
  });
});

test("dqaR4.totalRows equals input row count", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dqaR4.totalRows, 4);
  });
});

test("dqaR4.winWithoutPriceOrReturnCount counts win rows missing both valid entry price and realized return", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dqaR4.winWithoutPriceOrReturnCount, 1);
  });
});

test("dqaR4.hasBlockingViolations is true when blocking rows exist", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dqaR4.hasBlockingViolations, true);
  });
});

test("--include-dqa-r4 still includes inputValidation from the generated_signal_pairs contract", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.inputValidation, "expected inputValidation to still be present");
    assert.equal(parsed.inputValidation.totalRows, 4);
  });
});

test("--include-dqa-r4 still includes FORMULA_TRUSTED_INITIAL_V1_1_ALL in strategy comparison", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.strategies.some((s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL"),
    );
  });
});

test("--include-dqa-r4 output still has no ROI/PnL/profit keys", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const lower = result.stdout.toLowerCase();
    assert.ok(!lower.includes("\"roi\""));
    assert.ok(!lower.includes("\"pnl\""));
    assert.ok(!lower.includes("profit"));
  });
});

test("without --include-dqa-r4, output does not include dqaR4", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dqaR4, undefined);
  });
});

test("--include-dqa-r4 without --input-format generated_signal_pairs exits non-zero", async () => {
  await withTempInputFile(DQA_R4_FIXTURE_ROWS, (inputPath) => {
    const result = runCli(["--input", inputPath, "--required-only", "--include-dqa-r4"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /generated_signal_pairs/);
    assert.equal(result.stdout.trim(), "");
  });
});

const DEDUP_FIXTURE_ROWS = [
  // duplicate strict key c1/t1, two candidates before resolved_at
  {
    id: "dup-older",
    formula_version: "trusted-initial-formula-v1.1",
    condition_id: "c1",
    token_id: "t1",
    created_at: "2026-07-01T00:00:00.000Z",
    resolved_at: "2026-07-05T00:00:00.000Z",
    signal_result: "won",
    entry_price_num: 0.5,
  },
  {
    id: "dup-newer",
    formula_version: "trusted-initial-formula-v1.1",
    condition_id: "c1",
    token_id: "t1",
    created_at: "2026-07-02T00:00:00.000Z",
    resolved_at: "2026-07-05T00:00:00.000Z",
    signal_result: "won",
    entry_price_num: 0.5,
  },
  // separate key, non-trusted formula
  {
    id: "other",
    formula_version: "v2-lite-growth-safe",
    condition_id: "c2",
    token_id: "t1",
    created_at: "2026-07-01T00:00:00.000Z",
    signal_result: "won",
    entry_price_num: 0.5,
  },
];

test("default CLI without --dedup-policy still compares raw rows", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dedupProjection, undefined);
    assert.equal(parsed.strategies[0].inputRows, 3);
  });
});

test("CLI with --dedup-policy strict_latest_created_before_resolved includes dedupProjection", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.dedupProjection, "expected top-level dedupProjection in CLI output");
    assert.equal(parsed.dedupProjection.rawRows, 3);
    assert.equal(parsed.dedupProjection.dedupRows, 2);
  });
});

test("with dedup flag, strategy comparison inputRows equals dedupRows", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.strategies[0].inputRows, parsed.dedupProjection.dedupRows);
  });
});

test("trusted formula selectedRows after dedup reflects deduped rows, not raw rows", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const trusted = parsed.strategies.find(
      (s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL",
    );
    assert.ok(trusted);
    // 2 trusted-formula rows collapse to 1 after dedup; the non-trusted row
    // is filtered by formulaVersionEquals either way.
    assert.equal(trusted.selectedRows, 1);
  });
});

test("inputValidation still reports raw duplicate risk regardless of dedup flag", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.inputValidation.totalRows, 3);
    assert.equal(parsed.inputValidation.duplicateStrictKeyRows, 1);
  });
});

test("dqaR4, when included alongside dedup flag, runs against deduped rows", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.dqaR4.totalRows, parsed.dedupProjection.dedupRows);
  });
});

test("--dedup-policy without --input-format generated_signal_pairs exits non-zero", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /generated_signal_pairs/);
    assert.equal(result.stdout.trim(), "");
  });
});

test("invalid --dedup-policy value exits non-zero", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--dedup-policy",
      "not-a-real-policy",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dedup-policy/);
  });
});

test("dedup projection output contains no ROI/PnL/profit keys", async () => {
  await withTempInputFile(DEDUP_FIXTURE_ROWS, (inputPath) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const lower = result.stdout.toLowerCase();
    assert.ok(!lower.includes("\"roi\""));
    assert.ok(!lower.includes("\"pnl\""));
    assert.ok(!lower.includes("profit"));
  });
});

// ---- Phase 3E.2: gated ROI integration ----

async function withTempInputAndSummary<T>(
  rows: unknown[],
  summaryOverrides: Record<string, unknown>,
  fn: (paths: { inputPath: string; summaryPath: string }) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "readonly-roi-cli-test-"));
  try {
    const inputPath = path.join(dir, "rows.json");
    const summaryPath = path.join(dir, "summary.json");
    await writeFile(inputPath, JSON.stringify(rows), "utf8");
    const summary = {
      outputPath: inputPath,
      availableResolvedRows: rows.length,
      fetchedRows: rows.length,
      targetRows: rows.length,
      pageSize: 1000,
      pagesFetched: 1,
      exportMode: "FULL_RESOLVED",
      exportCompleteness: "COMPLETE",
      missingRows: 0,
      ...summaryOverrides,
    };
    await writeFile(summaryPath, JSON.stringify(summary), "utf8");
    return await fn({ inputPath, summaryPath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Happy-path fixture: one duplicate trusted win (dedup keeps latest), one
// trusted loss, one non-trusted row rejected by the formula filter.
const ROI_HAPPY_ROWS = [
  {
    id: "dup-older",
    formula_version: "trusted-initial-formula-v1.1",
    condition_id: "c1",
    token_id: "t1",
    created_at: "2026-07-01T00:00:00.000Z",
    resolved_at: "2026-07-05T00:00:00.000Z",
    signal_result: "won",
    entry_price_num: 0.4,
    realized_return_pct: 150,
  },
  {
    id: "dup-newer",
    formula_version: "trusted-initial-formula-v1.1",
    condition_id: "c1",
    token_id: "t1",
    created_at: "2026-07-02T00:00:00.000Z",
    resolved_at: "2026-07-05T00:00:00.000Z",
    signal_result: "won",
    entry_price_num: 0.4,
    realized_return_pct: 150,
  },
  {
    id: "trusted-loss",
    formula_version: "trusted-initial-formula-v1.1",
    condition_id: "c2",
    token_id: "t2",
    created_at: "2026-07-01T00:00:00.000Z",
    resolved_at: "2026-07-05T00:00:00.000Z",
    signal_result: "lost",
    entry_price_num: 0.5,
  },
  {
    id: "non-trusted",
    formula_version: "v2-lite-growth-safe",
    condition_id: "c3",
    token_id: "t3",
    created_at: "2026-07-01T00:00:00.000Z",
    resolved_at: "2026-07-05T00:00:00.000Z",
    signal_result: "won",
    entry_price_num: 0.5,
  },
];

const ROI_FULL_FLAGS = [
  "--required-only",
  "--input-format",
  "generated_signal_pairs",
  "--include-dqa-r4",
  "--dedup-policy",
  "strict_latest_created_before_resolved",
  "--include-roi",
];

test("ROI-1. --include-roi without --export-summary exits non-zero", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /export-summary/);
  });
});

test("ROI-2. --include-roi without --input-format generated_signal_pairs exits non-zero", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath, summaryPath }) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--include-dqa-r4",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
      "--include-roi",
      "--export-summary",
      summaryPath,
    ]);
    assert.notEqual(result.status, 0);
  });
});

test("ROI-3. --include-roi without strict dedup policy exits non-zero", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath, summaryPath }) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
      "--include-roi",
      "--export-summary",
      summaryPath,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dedup/);
  });
});

test("ROI-4. --include-roi without --include-dqa-r4 exits non-zero", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath, summaryPath }) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
      "--include-roi",
      "--export-summary",
      summaryPath,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dqa-r4/i);
  });
});

test("ROI-5. exportCompleteness not COMPLETE returns blocked gate, no per-strategy ROI", async () => {
  await withTempInputAndSummary(
    ROI_HAPPY_ROWS,
    { exportCompleteness: "INCOMPLETE", missingRows: 5 },
    ({ inputPath, summaryPath }) => {
      const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.roiGate.status, "BLOCKED");
      for (const s of parsed.strategies) {
        assert.equal(s.roi, undefined);
      }
    },
  );
});

test("ROI-6. missingRows > 0 returns blocked gate", async () => {
  await withTempInputAndSummary(
    ROI_HAPPY_ROWS,
    { missingRows: 3 },
    ({ inputPath, summaryPath }) => {
      const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.roiGate.status, "BLOCKED");
    },
  );
});

test("ROI-7. fetchedRows != inputValidation.totalRows returns blocked gate", async () => {
  await withTempInputAndSummary(
    ROI_HAPPY_ROWS,
    { fetchedRows: 999, availableResolvedRows: 999 },
    ({ inputPath, summaryPath }) => {
      const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.roiGate.status, "BLOCKED");
    },
  );
});

test("ROI-8. dedupProjection.rowsMissingStrictDedupKey > 0 returns blocked gate", async () => {
  const rowsWithMissingKey = [
    ...ROI_HAPPY_ROWS,
    // trusted row lacking a strict dedup key (no condition_id/token_id)
    { id: "no-key", formula_version: "trusted-initial-formula-v1.1", signal_result: "won", realized_return_pct: 100 },
  ];
  await withTempInputAndSummary(rowsWithMissingKey, {}, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.roiGate.status, "BLOCKED");
  });
});

test("ROI-9. DQA-R4 blocking returns blocked gate", async () => {
  const rowsWithBlockingDqa = [
    ...ROI_HAPPY_ROWS,
    // trusted win missing both entry price and realized return -> DQA-R4 blocking
    {
      id: "dqa-block",
      formula_version: "trusted-initial-formula-v1.1",
      condition_id: "c9",
      token_id: "t9",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: "2026-07-05T00:00:00.000Z",
      signal_result: "won",
    },
  ];
  await withTempInputAndSummary(rowsWithBlockingDqa, {}, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.roiGate.status, "BLOCKED");
  });
});

test("ROI-10. selectedRows=0 returns blocked/no-valid-strategy state", async () => {
  const noTrustedRows = [
    {
      id: "only-non-trusted",
      formula_version: "v2-lite-growth-safe",
      condition_id: "c1",
      token_id: "t1",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: "2026-07-05T00:00:00.000Z",
      signal_result: "won",
      entry_price_num: 0.5,
    },
  ];
  await withTempInputAndSummary(noTrustedRows, {}, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.roiGate.status, "BLOCKED");
  });
});

test("ROI-11. happy path: roiGate READY and per-strategy roi summary present", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.roiGate.status, "READY");
    const trusted = parsed.strategies.find(
      (s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL",
    );
    assert.ok(trusted.roi, "expected roi summary on trusted strategy");
    assert.ok(["READY", "NO_VALID_BETS", "BLOCKED_BY_INVALID_ROWS"].includes(trusted.roi.roiState));
  });
});

test("ROI-12. ROI computes on selected deduped rows only, not raw duplicates", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    const trusted = parsed.strategies.find(
      (s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL",
    );
    // 2 raw trusted-win duplicates collapse to 1; plus 1 trusted loss = 2 valid bets
    assert.equal(trusted.selectedRows, 2);
    assert.equal(trusted.roi.validBetCount, 2);
    assert.equal(trusted.roi.winCount, 1);
    assert.equal(trusted.roi.lossCount, 1);
  });
});

test("ROI-13. output contains no selected raw row arrays", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /dup-newer/);
    assert.doesNotMatch(result.stdout, /selectedRowObjects/);
  });
});

test("ROI-14. output contains no guaranteed/profit/marketing claim fields", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const lower = result.stdout.toLowerCase();
    assert.ok(!lower.includes("guarantee"));
    assert.ok(!lower.includes("profit"));
    assert.ok(!lower.includes("marketing"));
  });
});

test("ROI-15. default CLI without --include-roi output is unchanged (no roiGate)", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, {}, ({ inputPath }) => {
    const result = runCli([
      "--input",
      inputPath,
      "--required-only",
      "--input-format",
      "generated_signal_pairs",
      "--include-dqa-r4",
      "--dedup-policy",
      "strict_latest_created_before_resolved",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.roiGate, undefined);
    for (const s of parsed.strategies) {
      assert.equal(s.roi, undefined);
    }
  });
});

// ---- Phase 3E.2b compat: exhaustion-based export completeness ----

const EXHAUSTION_SUMMARY_OVERRIDES = {
  exportMode: "FULL_RESOLVED_BY_EXHAUSTION",
  exportCompleteness: "COMPLETE_BY_EXHAUSTION",
  completionProof: "LAST_PAGE_SHORT",
  exportCutoffResolvedAt: "2026-07-10T00:00:00.000Z",
  pageSize: 1000,
  pagesFetched: 1,
};

test("ROI-16. exhaustion summary with completionProof LAST_PAGE_SHORT and valid cutoff returns roiGate READY", async () => {
  await withTempInputAndSummary(ROI_HAPPY_ROWS, EXHAUSTION_SUMMARY_OVERRIDES, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.roiGate.status, "READY");
    const trusted = parsed.strategies.find(
      (s: { strategyId: string }) => s.strategyId === "FORMULA_TRUSTED_INITIAL_V1_1_ALL",
    );
    assert.ok(trusted.roi, "expected roi summary on trusted strategy");
  });
});

test("ROI-17. exhaustion summary with completionProof EMPTY_PAGE and valid cutoff also returns roiGate READY", async () => {
  await withTempInputAndSummary(
    ROI_HAPPY_ROWS,
    { ...EXHAUSTION_SUMMARY_OVERRIDES, completionProof: "EMPTY_PAGE" },
    ({ inputPath, summaryPath }) => {
      const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.roiGate.status, "READY");
    },
  );
});

test("ROI-18. COMPLETE_BY_EXHAUSTION without completionProof is BLOCKED", async () => {
  const { completionProof: _drop, ...withoutProof } = EXHAUSTION_SUMMARY_OVERRIDES;
  await withTempInputAndSummary(ROI_HAPPY_ROWS, withoutProof, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.roiGate.status, "BLOCKED");
    assert.ok(parsed.roiGate.reasons.includes("EXPORT_COMPLETENESS_PROOF_MISSING"));
  });
});

test("ROI-19. COMPLETE_BY_EXHAUSTION with invalid completionProof is BLOCKED", async () => {
  await withTempInputAndSummary(
    ROI_HAPPY_ROWS,
    { ...EXHAUSTION_SUMMARY_OVERRIDES, completionProof: "SOMETHING_ELSE" },
    ({ inputPath, summaryPath }) => {
      const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.roiGate.status, "BLOCKED");
      assert.ok(parsed.roiGate.reasons.includes("EXPORT_COMPLETENESS_PROOF_MISSING"));
    },
  );
});

test("ROI-20. COMPLETE_BY_EXHAUSTION without exportCutoffResolvedAt is BLOCKED", async () => {
  const { exportCutoffResolvedAt: _drop, ...withoutCutoff } = EXHAUSTION_SUMMARY_OVERRIDES;
  await withTempInputAndSummary(ROI_HAPPY_ROWS, withoutCutoff, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.roiGate.status, "BLOCKED");
    assert.ok(parsed.roiGate.reasons.includes("EXPORT_CUTOFF_MISSING"));
  });
});

test("ROI-21. DEBUG_CAPPED / INTENTIONALLY_CAPPED export summary is BLOCKED", async () => {
  await withTempInputAndSummary(
    ROI_HAPPY_ROWS,
    {
      exportMode: "DEBUG_CAPPED",
      exportCompleteness: "INTENTIONALLY_CAPPED",
      completionProof: null,
      exportCutoffResolvedAt: "2026-07-10T00:00:00.000Z",
      requestedMaxRows: 4,
    },
    ({ inputPath, summaryPath }) => {
      const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.roiGate.status, "BLOCKED");
      assert.ok(parsed.roiGate.reasons.includes("EXPORT_INTENTIONALLY_CAPPED"));
      for (const s of parsed.strategies) {
        assert.equal(s.roi, undefined);
      }
    },
  );
});

test("ROI-22. INCOMPLETE (unrecognized) exportCompleteness value is BLOCKED", async () => {
  await withTempInputAndSummary(
    ROI_HAPPY_ROWS,
    { exportCompleteness: "INCOMPLETE", exportMode: "FULL_RESOLVED_BY_EXHAUSTION" },
    ({ inputPath, summaryPath }) => {
      const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.roiGate.status, "BLOCKED");
      assert.ok(parsed.roiGate.reasons.includes("EXPORT_NOT_COMPLETE"));
    },
  );
});

test("ROI-23. legacy summary shape (exportCompleteness: COMPLETE) remains accepted for backward compatibility", async () => {
  await withTempInputAndSummary(
    ROI_HAPPY_ROWS,
    { exportMode: "FULL_RESOLVED", exportCompleteness: "COMPLETE" },
    ({ inputPath, summaryPath }) => {
      const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.roiGate.status, "READY");
    },
  );
});

test("ROI-24. exhaustion-blocked output still contains no guaranteed/profit/marketing claim fields", async () => {
  const { completionProof: _drop, ...withoutProof } = EXHAUSTION_SUMMARY_OVERRIDES;
  await withTempInputAndSummary(ROI_HAPPY_ROWS, withoutProof, ({ inputPath, summaryPath }) => {
    const result = runCli(["--input", inputPath, ...ROI_FULL_FLAGS, "--export-summary", summaryPath]);
    assert.equal(result.status, 0, result.stderr);
    const lower = result.stdout.toLowerCase();
    assert.ok(!lower.includes("guarantee"));
    assert.ok(!lower.includes("profit"));
    assert.ok(!lower.includes("marketing"));
  });
});
