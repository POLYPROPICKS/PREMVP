import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadFrozenAuditInputs } from "../../lib/modeling/postJuneCanonicalFreeze";
import { buildExecutionWaterfall } from "../../lib/modeling/executionWaterfall";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";

const root = process.cwd();
const runner = path.join(root, "scripts/modeling/strategies/runForwardLocalShadow.ts");
const AS_OF = "2026-06-01T00:00:00.000Z";

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", runner, ...args], { cwd: root, encoding: "utf8" });
}

function stripResolution(row: ExportRow): ExportRow {
  const clean: Record<string, unknown> = { ...row };
  delete clean.resolved_at;
  delete clean.result;
  delete clean.signal_result;
  delete clean.outcome_status;
  delete clean.realized_return_pct;
  delete clean.realizedReturnPct;
  return clean as ExportRow;
}

function realForwardRows(): ExportRow[] {
  const { corpus } = loadFrozenAuditInputs(root);
  const classifier = loadExecutableFunnelClassifier();
  const waterfall = buildExecutionWaterfall(corpus as ExportRow[], classifier);
  return waterfall.executionCandidates.map((candidate) => stripResolution({ ...(candidate.row as ExportRow) }));
}

const REAL_ROWS = realForwardRows();

function writeSnapshot(dir: string, rows: ExportRow[]): string {
  const snapshotPath = path.join(dir, "snapshot.jsonl");
  writeFileSync(snapshotPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  return snapshotPath;
}

test("21: missing --input exits non-zero", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const journal = path.join(temp, "journal.jsonl");
    const result = runCli(["--as-of", AS_OF, "--journal", journal]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(journal), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("22: missing --as-of exits non-zero", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const journal = path.join(temp, "journal.jsonl");
    const result = runCli(["--input", snapshotPath, "--journal", journal]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(journal), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("23: missing --journal exits non-zero", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const result = runCli(["--input", snapshotPath, "--as-of", AS_OF]);
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("24: relative input and journal paths are rejected without writes", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const journal = path.join(temp, "journal.jsonl");
    const relInputResult = runCli(["--input", "snapshot.jsonl", "--as-of", AS_OF, "--journal", journal]);
    assert.notEqual(relInputResult.status, 0);
    assert.equal(existsSync(journal), false);
    const relJournalResult = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", "journal.jsonl"]);
    assert.notEqual(relJournalResult.status, 0);
    assert.equal(existsSync(path.join(root, "journal.jsonl")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("25: repository and frozen-root input/journal targets are rejected without writes", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const repoJournal = path.join(root, "forward-shadow-journal.jsonl");
    const frozenJournal = path.join(root, "modeling/canonical/datasets/forward-shadow-journal.jsonl");
    const evidenceJournal = path.join(root, "modeling/evidence/forward-shadow-journal.jsonl");
    for (const journal of [repoJournal, frozenJournal, evidenceJournal]) {
      const result = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", journal]);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(journal), false);
    }
    const frozenDatasetPath = path.join(root, "modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/generated_signal_pairs_export.json.gz");
    const externalJournal = path.join(temp, "journal.jsonl");
    const frozenInputResult = runCli(["--input", frozenDatasetPath, "--as-of", AS_OF, "--journal", externalJournal]);
    assert.notEqual(frozenInputResult.status, 0);
    assert.equal(existsSync(externalJournal), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("26: a safe external input and journal path is accepted and creates exactly one journal file", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const journal = path.join(temp, "journal.jsonl");
    const result = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", journal]);
    assert.equal(result.status, 0);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.appended, 1);
    assert.deepEqual(readdirSync(temp).sort(), ["journal.jsonl", "snapshot.jsonl"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("27+28: exactly one journal file and no permanent lock after successful completion", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const journal = path.join(temp, "journal.jsonl");
    const result = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", journal]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(journal), true);
    assert.equal(existsSync(`${journal}.lock`), false);
    assert.deepEqual(readdirSync(temp).sort(), ["journal.jsonl", "snapshot.jsonl"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("29: a second CLI process fails closed while another process's lock is held, with no journal effects", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const journal = path.join(temp, "journal.jsonl");
    const lockPath = `${journal}.lock`;
    writeFileSync(lockPath, "", "utf8");
    try {
      const result = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", journal]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /FORWARD_EVIDENCE_JOURNAL_LOCKED/);
      assert.equal(existsSync(journal), false);
      assert.equal(existsSync(lockPath), true);
    } finally {
      rmSync(lockPath, { force: true });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("29b: two real concurrent CLI processes racing the same journal never produce duplicate or conflicting decisions", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0], REAL_ROWS[1]]);
    const journal = path.join(temp, "journal.jsonl");
    const spawnOne = () =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", runner, "--input", snapshotPath, "--as-of", AS_OF, "--journal", journal], { cwd: root });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
    const [a, b] = await Promise.all([spawnOne(), spawnOne()]);
    const statuses = [a.status, b.status];
    const successCount = statuses.filter((status) => status === 0).length;
    // Either no real overlap occurred (both succeed, second is an idempotent no-op)
    // or true lock contention occurred (exactly one fails closed on the lock).
    assert.ok(successCount === 1 || successCount === 2, `expected 1 or 2 successes, got: ${JSON.stringify({ a, b })}`);
    if (successCount === 1) {
      const failed = a.status === 0 ? b : a;
      assert.match(failed.stderr, /FORWARD_EVIDENCE_JOURNAL_LOCKED/);
    }
    assert.equal(existsSync(`${journal}.lock`), false);
    const lines = readFileSync(journal, "utf8").trim().split("\n");
    const observationIds = lines.map((line) => JSON.parse(line).observationId);
    assert.equal(new Set(observationIds).size, observationIds.length);
    assert.equal(observationIds.length, 2);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("30: the runner contains no network/Supabase/queue/Contur3/child_process imports", () => {
  const source = readFileSync(path.join(root, "scripts/modeling/strategies/runForwardLocalShadow.ts"), "utf8");
  assert.doesNotMatch(source, /node:child_process|supabase|node:https?|node:net|node:tls|undici|fetch\(|queue|reservation|contur3|app\/api/i);
});

test("31: an exact rerun via the real CLI appends zero lines and leaves the journal byte-identical", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const journal = path.join(temp, "journal.jsonl");
    const first = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", journal]);
    assert.equal(first.status, 0);
    const before = readFileSync(journal, "utf8");
    const second = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", journal]);
    assert.equal(second.status, 0);
    const summary = JSON.parse(second.stdout);
    assert.equal(summary.appended, 0);
    const after = readFileSync(journal, "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("32: a malformed snapshot exits non-zero and writes nothing", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = path.join(temp, "snapshot.jsonl");
    writeFileSync(snapshotPath, `${JSON.stringify(REAL_ROWS[0])}\n{not valid json\n`, "utf8");
    const journal = path.join(temp, "journal.jsonl");
    const result = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", journal]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(journal), false);
    assert.equal(existsSync(`${journal}.lock`), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("input and journal resolving to the same file are rejected without writes", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    const result = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", snapshotPath]);
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a symlinked journal directory into the repository fails closed", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "pp-forward-cli-"));
  const junction = path.join(temp, "repo-junction");
  try {
    const snapshotPath = writeSnapshot(temp, [REAL_ROWS[0]]);
    symlinkSync(root, junction, process.platform === "win32" ? "junction" : "dir");
    const result = runCli(["--input", snapshotPath, "--as-of", AS_OF, "--journal", path.join(junction, "journal.jsonl")]);
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
