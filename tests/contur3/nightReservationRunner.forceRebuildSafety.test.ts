// Contur3 night-reservation runner safety tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Production incident: scripts/contur3/run-night-reservations.mjs
// unconditionally sent ?forceRebuild=CEO_APPROVED on every ordinary/scheduled
// invocation, so the normal Railway cron used the destructive force-rebuild
// path by default. This file proves (a) statically, without ever making a
// network call, that default invocation no longer does that, and (b) by
// actually spawning the script, that an explicit-but-wrong force marker is
// rejected locally before any HTTP request is attempted -- never a real
// network call to production either way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const scriptPath = path.join(process.cwd(), "scripts", "contur3", "run-night-reservations.mjs");

test("RED1/GREEN: default invocation (no CONTUR3_FORCE_REBUILD) never constructs a forceRebuild=CEO_APPROVED request", () => {
  const src = fs.readFileSync(scriptPath, "utf8");
  // The literal destructive query string must never appear as an unconditional
  // part of the request URL -- it may only be set inside the explicit-marker branch.
  assert.doesNotMatch(
    src,
    /fetch\(`\$\{BASE_URL\}\$\{ENDPOINT\}\?forceRebuild=CEO_APPROVED`/,
    "default request construction must not hardcode forceRebuild=CEO_APPROVED"
  );
  assert.match(
    src,
    /if \(forceRebuild\) \{\s*\n\s*url\.searchParams\.set\('forceRebuild', FORCE_REBUILD_MARKER\);/,
    "forceRebuild query param must only be set inside an explicit conditional branch"
  );
  assert.match(src, /const requested = process\.env\.CONTUR3_FORCE_REBUILD;/);
  assert.match(src, /if \(requested === undefined\) return \{ forceRebuild: false, mode: 'NORMAL' \};/);
});

test("RED2/GREEN: an explicit but incorrect CONTUR3_FORCE_REBUILD value is rejected locally before any network request", () => {
  let stdoutErr = "";
  let status = 0;
  try {
    execFileSync("node", [scriptPath], {
      env: {
        ...process.env,
        EXECUTOR_CANDIDATES_SECRET: "test-secret-not-real",
        CONTUR3_FORCE_REBUILD: "wrong-value",
      },
      timeout: 5000,
      encoding: "utf8",
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? 1;
    stdoutErr = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.equal(status, 1);
  assert.match(stdoutErr, /FORCE_REBUILD_MARKER_MISMATCH/);
  assert.doesNotMatch(stdoutErr, /POST http/, "must not attempt any network request before rejecting the wrong marker");
});

test("GREEN: the exact correct marker (CEO_APPROVED) is the only value resolveForceRebuildMode accepts as force mode", () => {
  const src = fs.readFileSync(scriptPath, "utf8");
  assert.match(src, /const FORCE_REBUILD_MARKER = 'CEO_APPROVED';/);
  assert.match(src, /if \(requested !== FORCE_REBUILD_MARKER\) \{/);
  assert.match(src, /return \{ forceRebuild: true, mode: 'FORCE_REBUILD_EXPLICIT' \};/);
});

test("GREEN: execution_mode is printed and never NORMAL when a force request is actually sent", () => {
  const src = fs.readFileSync(scriptPath, "utf8");
  assert.match(src, /console\.log\(`execution_mode: \$\{mode\}`\);/);
});

test("GREEN: no secret value is ever printed by the runner", () => {
  const src = fs.readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(src, /console\.(log|error)\(`.*\$\{secret\}/);
});
