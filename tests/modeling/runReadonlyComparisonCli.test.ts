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
