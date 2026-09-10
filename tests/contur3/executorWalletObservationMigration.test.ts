// Static SQL-text validation of the additive wallet-observation columns
// migration (node:test via tsx):
//   node --import tsx --test tests/contur3/executorWalletObservationMigration.test.ts
//
// This repo has no CI/deploy migration runner, so this is the strongest
// available local check: the migration must be strictly additive and must
// declare exactly the EXECUTOR_WALLET_STATE_V1 column contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { WALLET_OBSERVATION_COLUMN_NAMES } from "../../lib/executor/executorWalletState";

const root = process.cwd();
const migrationsDir = path.join(root, "supabase/migrations");
// Re-stamped to a version strictly greater than the live production ledger head
// (20260909123000_drop_current_serving_gsp_fk) so it applies as a clean append
// through the target-only lifecycle. DDL semantics are byte-identical to the
// original 20260909120000 file (sha256 319c4fc0…).
const migrationFile = "20260910120000_executor_wallet_observation_columns.sql";
const sql = readFileSync(path.join(migrationsDir, migrationFile), "utf8");
const sqlWithoutComments = sql.split("\n").map((l) => l.replace(/--.*\r?$/, "")).join("\n");

test("the migration file exists in the standard migrations directory", () => {
  assert.ok(readdirSync(migrationsDir).includes(migrationFile));
});

test("every EXECUTOR_WALLET_STATE_V1 column is added with ADD COLUMN IF NOT EXISTS", () => {
  const typeByColumn: Record<string, string> = {
    spendable_balance_usd: "numeric",
    collateral_balance_usd: "numeric",
    allowance_usd: "numeric",
    wallet_observed_at: "timestamptz",
    wallet_observation_lifecycle_point: "text",
  };
  for (const col of WALLET_OBSERVATION_COLUMN_NAMES) {
    assert.match(
      sqlWithoutComments,
      new RegExp(`add column if not exists\\s+${col}\\s+${typeByColumn[col]}`, "i"),
      `missing additive column: ${col}`,
    );
  }
});

test("the migration carries the PREMVP_APPLICATION_MIGRATION_V1 header required by the registered apply path", () => {
  assert.match(sql, /^\s*--\s*PREMVP_APPLICATION_MIGRATION_V1\b/m);
});

test("the migration is additive-only — no destructive or type-changing operation", () => {
  assert.doesNotMatch(sqlWithoutComments, /\bdrop\s+(table|column|index)\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\btruncate\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\balter\s+column\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\brename\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\bupdate\s+public\./i);
  assert.doesNotMatch(sqlWithoutComments, /\bcreate\s+table\b/i);
});

test("the freshness lookup index is a partial index on wallet_observed_at desc", () => {
  assert.match(
    sql,
    /create index if not exists\s+executor_order_events_wallet_observed_at_idx[\s\S]*on public\.executor_order_events \(wallet_observed_at desc\)[\s\S]*where wallet_observed_at is not null and spendable_balance_usd is not null/i,
  );
});

test("the migration documents that it has NOT been applied", () => {
  assert.match(sql, /NOT APPLIED/i);
});
