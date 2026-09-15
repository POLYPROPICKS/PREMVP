// TEMPORARY_HARD_STOP_RESEARCH_SYNC_UNSAFE_PRODUCTION_READ_V1 regression
// coverage (ISOLATE_UNSAFE_RESEARCH_SYNC_AND_RECOVER_MONEY_PATH_V1).
//
// Proves main() exits successfully before any env resolution or Supabase
// client creation -- with zero production credentials present, so a bypass
// of the hard stop would surface immediately as a thrown
// MISSING_SUPABASE_URL error from requiredEnv(), never a passing test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../../scripts/research-clone-daily-sync";

test("main(): hard-stops before touching any env var or creating a Supabase client", async (t) => {
  const before = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_CLONE_URL: process.env.SUPABASE_CLONE_URL,
    SUPABASE_CLONE_SERVICE_ROLE_KEY: process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY,
  };
  // Deliberately unset every credential this script would otherwise require --
  // if the hard stop is ever bypassed, main() throws MISSING_SUPABASE_URL
  // (requiredEnv) instead of returning cleanly, and this test fails loudly.
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_CLONE_URL;
  delete process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => {
    logs.push(msg);
  };

  try {
    await assert.doesNotReject(main());
  } finally {
    console.log = originalLog;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(logs.length, 1, "exactly one log line, no client/query attempt beyond it");
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.STATUS, "HARD_STOPPED");
  assert.equal(parsed.REASON, "TEMPORARY_HARD_STOP_RESEARCH_SYNC_UNSAFE_PRODUCTION_READ_V1");
  assert.equal(parsed.SOURCE, "research-clone-sync");
});
