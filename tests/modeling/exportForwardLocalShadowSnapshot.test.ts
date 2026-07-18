import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const cli = path.join(root, "scripts/modeling/strategies/exportForwardLocalShadowSnapshot.ts");
const AS_OF = "2026-06-01T00:00:00.000Z";

// Run the real CLI with SUPABASE env deliberately stripped, so no live
// network read can ever occur: every accepted-path case must still fail on
// config resolution (never on a successful live fetch), and every rejected
// path/arg case must fail during validation, before any adapter is built.
function runCli(args: string[]) {
  const env = { ...process.env };
  delete env.SUPABASE_URL;
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.SUPABASE_ANON_KEY;
  delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: root, encoding: "utf8", env });
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pp-forward-export-cli-"));
}

test("C1: missing --as-of exits non-zero and writes nothing", () => {
  const dir = tempDir();
  try {
    const r = runCli(["--output", path.join(dir, "s.jsonl"), "--manifest", path.join(dir, "m.json")]);
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C2: missing --output exits non-zero", () => {
  const dir = tempDir();
  try {
    const r = runCli(["--as-of", AS_OF, "--manifest", path.join(dir, "m.json")]);
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: missing --manifest exits non-zero", () => {
  const dir = tempDir();
  try {
    const r = runCli(["--as-of", AS_OF, "--output", path.join(dir, "s.jsonl")]);
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C4: relative output/manifest paths are rejected before any write", () => {
  const dir = tempDir();
  try {
    const r1 = runCli(["--as-of", AS_OF, "--output", "snapshot.jsonl", "--manifest", path.join(dir, "m.json")]);
    assert.notEqual(r1.status, 0);
    assert.match(r1.stderr, /MUST_BE_ABSOLUTE/);
    assert.equal(existsSync(path.join(root, "snapshot.jsonl")), false);
    const r2 = runCli(["--as-of", AS_OF, "--output", path.join(dir, "s.jsonl"), "--manifest", "manifest.json"]);
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr, /MUST_BE_ABSOLUTE/);
    assert.equal(existsSync(path.join(root, "manifest.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C5: protected repository/frozen output targets are rejected", () => {
  const dir = tempDir();
  try {
    const targets = [
      path.join(root, "snapshot.jsonl"),
      path.join(root, "modeling/canonical/datasets/x.jsonl"),
      path.join(root, "modeling/evidence/x.jsonl"),
    ];
    for (const t of targets) {
      const r = runCli(["--as-of", AS_OF, "--output", t, "--manifest", path.join(dir, "m.json")]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /PROTECTED_ROOT_REJECTED/);
      assert.equal(existsSync(t), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C6: output and manifest resolving to the same path are rejected", () => {
  const dir = tempDir();
  try {
    const p = path.join(dir, "same.jsonl");
    const r = runCli(["--as-of", AS_OF, "--output", p, "--manifest", p]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SAME_PATH/);
    assert.equal(existsSync(p), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C7: an existing output file is never overwritten", () => {
  const dir = tempDir();
  try {
    const output = path.join(dir, "snapshot.jsonl");
    writeFileSync(output, "PRE-EXISTING", "utf8");
    const r = runCli(["--as-of", AS_OF, "--output", output, "--manifest", path.join(dir, "m.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OUTPUT_EXISTS/);
    assert.equal(readFileSync(output, "utf8"), "PRE-EXISTING");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C8: a symlinked output directory into the repo fails closed", () => {
  const dir = tempDir();
  try {
    const junction = path.join(dir, "repo-link");
    symlinkSync(root, junction, "dir");
    const r = runCli(["--as-of", AS_OF, "--output", path.join(junction, "s.jsonl"), "--manifest", path.join(dir, "m.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SYMLINK_REJECTED|PROTECTED_ROOT_REJECTED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C9: with valid external paths the CLI fails on missing Supabase config, never on a live fetch, and writes nothing", () => {
  const dir = tempDir();
  try {
    const r = runCli(["--as-of", AS_OF, "--output", path.join(dir, "snapshot.jsonl"), "--manifest", path.join(dir, "manifest.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Supabase read config|SUPABASE_URL/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C10: the CLI source imports no queue/Contur3/Ireland/child_process and no Supabase write verb", () => {
  const src = readFileSync(cli, "utf8");
  assert.doesNotMatch(src, /node:child_process|queue|reservation|contur3|ireland/i);
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete|rpc)\s*\(/);
});

test("C11: an invalid --as-of exits non-zero before any write", () => {
  const dir = tempDir();
  try {
    const r = runCli(["--as-of", "not-a-date", "--output", path.join(dir, "s.jsonl"), "--manifest", path.join(dir, "m.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /INVALID_AS_OF/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
