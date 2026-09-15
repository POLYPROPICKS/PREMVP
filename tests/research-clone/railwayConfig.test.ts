import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// The `research-clone-daily-sync` Railway service builds `main` alongside every
// sibling service (PREMVP web + the contur3 / signal-resolve / ops-report
// crons). A repository-root `railway.toml` / `railway.json` is applied by
// Railway to services that have no explicit config path, so a root deploy
// config here would silently rewrite sibling start commands. These tests are
// the guard that landing the research-clone sync never reintroduces one.

test("no repository-root Railway deployment config exists", () => {
  for (const name of ["railway.toml", "railway.json"]) {
    assert.equal(
      existsSync(repoRoot + name),
      false,
      `${name} must not exist at the repository root: a root deploy config would leak startCommand/cron into sibling Railway services`,
    );
  }
});

test("service-scoped config exists only at a non-auto-discovered path and targets the sync command", () => {
  const scopedPath = repoRoot + "ops/railway/research-clone-daily-sync.toml";
  assert.equal(existsSync(scopedPath), true, "expected ops/railway/research-clone-daily-sync.toml");

  const contents = readFileSync(scopedPath, "utf8");
  assert.match(
    contents,
    /startCommand\s*=\s*"npm run research-clone:sync && npm run research-clone:model-ready; npm run research-clone:model-ready-direct"/,
  );
  assert.match(contents, /cronSchedule\s*=\s*"0 2 \* \* \*"/);
  assert.match(contents, /restartPolicyType\s*=\s*"NEVER"/);
});

test("research-clone:model-ready-direct is never gated on the legacy sync/model-ready chain's exit code", () => {
  const scopedPath = repoRoot + "ops/railway/research-clone-daily-sync.toml";
  const contents = readFileSync(scopedPath, "utf8");
  const startCommandLine = contents
    .split("\n")
    .find((line) => line.trim().startsWith("startCommand"));
  assert.ok(startCommandLine, "expected a startCommand line");
  // `;` (not `&&`) immediately before the direct materializer step is the
  // proven fix for OLD_SYNC_FAILURE_BLOCKS_DIRECT_MATERIALIZER: with `&&` a
  // nonzero exit from research-clone:sync or research-clone:model-ready
  // (scripts/research-clone-daily-sync.ts sets process.exitCode=75/1) aborts
  // the chain before research-clone:model-ready-direct ever runs.
  assert.match(startCommandLine!, /model-ready;\s*npm run research-clone:model-ready-direct/);
  assert.doesNotMatch(startCommandLine!, /model-ready\s*&&\s*npm run research-clone:model-ready-direct/);
});

test("main exposes the research-clone:sync package command and its implementation", () => {
  const pkg = JSON.parse(readFileSync(repoRoot + "package.json", "utf8"));
  assert.equal(pkg.scripts["research-clone:sync"], "tsx scripts/research-clone-daily-sync.ts");
  assert.equal(pkg.scripts["research-clone:model-ready"], "tsx scripts/modeling/clone-model-ready-pipeline.ts");
  assert.equal(
    pkg.scripts["research-clone:model-ready-direct"],
    "tsx scripts/modeling/materialize-research-model-ready.ts",
  );
  assert.equal(existsSync(repoRoot + "scripts/research-clone-daily-sync.ts"), true);
  assert.equal(existsSync(repoRoot + "scripts/modeling/materialize-research-model-ready.ts"), true);
  assert.equal(existsSync(repoRoot + "lib/research-clone/dailySync.ts"), true);
});
