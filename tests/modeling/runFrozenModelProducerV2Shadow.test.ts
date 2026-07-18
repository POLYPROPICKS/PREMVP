import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { runFrozenModelProducerV2Shadow } from "../../scripts/modeling/strategies/runFrozenModelProducerV2Shadow";

const root = process.cwd();
const runner = path.join(root, "scripts/modeling/strategies/runFrozenModelProducerV2Shadow.ts");
function runCli(output?: string) { return spawnSync(process.execPath, ["--import", "tsx", runner, ...(output === undefined ? [] : [output])], { cwd: root, encoding: "utf8" }); }

test("shadow runner writes only explicit compact local evidence", () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), "polypropicks-shadow-run-"));
  const output = path.join(outputDirectory, "shadow-output.json");
  try {
    const result = runFrozenModelProducerV2Shadow(process.cwd(), output);
    assert.equal(result.noWriteSafetyVerdict, "PASS");
    assert.ok(existsSync(output));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(output, "utf8"))).sort(), ["datasetHash", "deterministicRunVerdict", "executionSequenceHash", "identitySetHash", "noWriteSafetyVerdict", "parityVerdict", "postJuneCount", "selectedCount", "sourceCommit"].sort());
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("shadow runner rejects missing, relative, worktree, repository, and frozen output targets", () => {
  assert.throws(() => runFrozenModelProducerV2Shadow(process.cwd(), undefined as never), /output/i);
  assert.throws(() => runFrozenModelProducerV2Shadow(process.cwd(), "shadow-output.json"), /absolute/i);
  assert.throws(() => runFrozenModelProducerV2Shadow(process.cwd(), path.join(process.cwd(), "modeling/evidence/shadow-output.json")), /protected|repository|worktree/i);
  assert.throws(() => runFrozenModelProducerV2Shadow(process.cwd(), path.join(process.cwd(), "shadow-output.json")), /protected|repository|worktree/i);
  assert.throws(() => runFrozenModelProducerV2Shadow(process.cwd(), path.join(process.cwd(), "modeling/canonical/datasets/shadow-output.json")), /protected|frozen/i);
  assert.throws(() => runFrozenModelProducerV2Shadow(process.cwd(), path.join(process.cwd(), "modeling/canonical/model-handoff-v1/shadow-output.json")), /protected|manifest|frozen/i);
});

test("shadow runner CLI rejects protected paths without writes and accepts exactly one external file", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "polypropicks-shadow-cli-"));
  const cases = [undefined, "relative.json", path.join(root, "shadow-output.json"), path.join(root, "modeling/canonical/datasets/shadow-output.json"), path.join(root, "modeling", "..", "shadow-output.json")];
  try {
    for (const output of cases) {
      const target = output && path.isAbsolute(output) ? path.resolve(output) : undefined;
      const before = target ? existsSync(target) : false;
      const result = runCli(output);
      assert.notEqual(result.status, 0);
      assert.equal(target ? existsSync(target) : false, before);
    }
    const output = path.join(temp, "shadow-output.json");
    const result = runCli(output);
    assert.equal(result.status, 0);
    assert.deepEqual(readdirSync(temp), ["shadow-output.json"]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(output, "utf8"))).sort(), ["datasetHash", "deterministicRunVerdict", "executionSequenceHash", "identitySetHash", "noWriteSafetyVerdict", "parityVerdict", "postJuneCount", "selectedCount", "sourceCommit"].sort());
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("shadow runner fails closed for a junction into the repository", () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), "polypropicks-shadow-link-"));
  const junction = path.join(outputDirectory, "repo-junction");
  try {
    symlinkSync(process.cwd(), junction, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => runFrozenModelProducerV2Shadow(process.cwd(), path.join(junction, "shadow-output.json")), /symlink|protected/i);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("shadow runner contains no forbidden runtime imports", () => {
  const runner = readFileSync(path.join(process.cwd(), "scripts/modeling/strategies/runFrozenModelProducerV2Shadow.ts"), "utf8");
  assert.doesNotMatch(runner, /node:child_process|supabase|node:https?|node:net|node:tls|undici|fetch\(|queue|reservation|contur3|app\/api/i);
});
