// Static SQL-text validation of the additive executor_order_events /
// event_execution_queue migration (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// This repo has no CI/deploy migration runner and no local Postgres to apply
// against (see /tmp/POLYPROPICKS_CALLBACK_SCHEMA_INVENTORY.md), so this file
// is the strongest available local validation: static assertions against the
// migration's SQL text. It does not and cannot prove the migration applies
// cleanly against the live database — that requires a real apply, which is
// explicitly out of scope for this change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const migrationsDir = path.join(root, "supabase/migrations");
const migrationFile = "20260719_executor_order_events_schema_and_idempotency.sql";
const sql = readFileSync(path.join(migrationsDir, migrationFile), "utf8");
// Strip `--` line comments for statement-level assertions (queue_id absence,
// destructive-operation checks) so prose explaining the absence of queue_id
// doesn't itself trip a "does it mention queue_id" check.
const sqlWithoutComments = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

const PROVEN_SOURCE_FIELDS = [
  "event_type", "source", "environment", "idempotency_key", "clob_order_id", "transaction_hashes",
  "signal_id", "candidate_id", "run_id", "market_slug",
  "condition_id", "token_id", "selected_side", "side", "order_status", "success", "dry_run",
  "live_confirm", "submitted_price", "submitted_size", "stake_usd", "making_amount", "taking_amount",
  "observed_best_bid", "observed_best_ask", "observed_price", "observed_spread", "max_entry_price",
  "fee_usd", "slippage_usd", "cost_model_version", "fee_notes", "executor_host_country",
  "executor_version", "model_rule_id", "strategic_scope", "candidate_snapshot_json",
  "response_json_sanitized", "executor_meta", "raw_event_json", "error_message",
];

// Founder-proven live information_schema inventory of public.executor_order_events:
// exactly these 43 columns, no more, no less.
const AUTHORITATIVE_LIVE_COLUMNS = [
  "id", "created_at", "event_type", "source", "environment", "idempotency_key",
  "clob_order_id", "transaction_hashes", "signal_id", "candidate_id", "run_id",
  "market_slug", "condition_id", "token_id", "selected_side", "side", "order_status",
  "success", "dry_run", "live_confirm", "submitted_price", "submitted_size", "stake_usd",
  "making_amount", "taking_amount", "observed_best_bid", "observed_best_ask",
  "observed_price", "observed_spread", "max_entry_price", "fee_usd", "slippage_usd",
  "cost_model_version", "fee_notes", "executor_host_country", "executor_version",
  "model_rule_id", "strategic_scope", "candidate_snapshot_json", "response_json_sanitized",
  "executor_meta", "raw_event_json", "error_message",
];

function extractCreateTableBody(): string {
  const match = sql.match(/create\s+table\s+if\s+not\s+exists\s+public\.executor_order_events\s*\(([\s\S]*?)\n\);/i);
  if (!match) throw new Error("could not locate executor_order_events CREATE TABLE body");
  return match[1];
}

function extractColumnNames(tableBody: string): string[] {
  return tableBody
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""))
    .map((line) => line.split(/\s+/)[0])
    .filter((token) => token.length > 0);
}

test("migration file exists in the standard migrations directory", () => {
  assert.ok(readdirSync(migrationsDir).includes(migrationFile));
});

test("the schema capture contains every field the current application source reads/writes", () => {
  for (const field of PROVEN_SOURCE_FIELDS) {
    assert.match(sql, new RegExp(`\\b${field}\\b`), `missing proven field: ${field}`);
  }
});

test("queue_id is absent from every executable SQL statement (comments explaining its absence are expected)", () => {
  assert.doesNotMatch(sqlWithoutComments, /\bqueue_id\b/);
});

test("no foreign key references queue_id", () => {
  assert.doesNotMatch(sql, /references[\s\S]{0,80}queue_id/i);
  assert.doesNotMatch(sql, /queue_id[\s\S]{0,80}references/i);
});

test("existing order-event indexes are codified with IF NOT EXISTS", () => {
  for (const indexName of [
    "executor_order_events_idempotency_key_uidx",
    "executor_order_events_clob_order_id_uidx",
    "executor_order_events_created_at_idx",
    "executor_order_events_signal_id_idx",
    "executor_order_events_token_id_idx",
  ]) {
    const re = new RegExp(`create\\s+(unique\\s+)?index\\s+if\\s+not\\s+exists\\s+${indexName}`, "i");
    assert.match(sql, re, `missing IF NOT EXISTS index: ${indexName}`);
  }
});

test("the new queue idempotency index is a partial unique index tolerant of null legacy rows", () => {
  assert.match(sql, /create\s+unique\s+index\s+if\s+not\s+exists\s+event_execution_queue_idempotency_key_uidx/i);
  assert.match(sql, /event_execution_queue_idempotency_key_uidx[\s\S]{0,200}where\s+idempotency_key\s+is\s+not\s+null/i);
});

test("the order-event unique indexes are partial, tolerant of null legacy rows", () => {
  assert.match(sql, /executor_order_events_idempotency_key_uidx[\s\S]{0,200}where\s+idempotency_key\s+is\s+not\s+null/i);
  assert.match(sql, /executor_order_events_clob_order_id_uidx[\s\S]{0,200}where\s+clob_order_id\s+is\s+not\s+null/i);
});

test("the queue status CHECK constraint contains the full backward-compatible persisted union", () => {
  const statuses = ["READY", "CLAIMED", "SENT", "EXECUTED", "SKIPPED", "FAILED", "EXPIRED", "CANCELLED"];
  const checkMatch = sql.match(/check\s*\(\s*status\s+in\s*\(([^)]+)\)\s*\)/i);
  assert.ok(checkMatch, "status CHECK constraint not found");
  const listed = checkMatch![1];
  for (const status of statuses) {
    assert.match(listed, new RegExp(`'${status}'`), `status CHECK missing legacy value: ${status}`);
  }
});

test("no partial-fill fields were introduced", () => {
  for (const forbidden of ["requested_shares", "filled_shares", "remaining_shares", "average_fill_price", "PARTIALLY_FILLED"]) {
    assert.doesNotMatch(sql, new RegExp(forbidden, "i"));
  }
});

test("the migration performs no destructive operation", () => {
  assert.doesNotMatch(sqlWithoutComments, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\btruncate\b/i);
  assert.doesNotMatch(sqlWithoutComments, /\balter\s+column\b/i);
});

test("the migration is additive-only (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)", () => {
  assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+public\.executor_order_events/i);
  const createTableStatements = sql.match(/create\s+table\b/gi) ?? [];
  const ifNotExistsTableStatements = sql.match(/create\s+table\s+if\s+not\s+exists\b/gi) ?? [];
  assert.equal(createTableStatements.length, ifNotExistsTableStatements.length, "every CREATE TABLE must use IF NOT EXISTS");
});

test("the migration file documents that it has NOT been applied", () => {
  assert.match(sql, /NOT APPLIED/i);
});

test("the executor_order_events CREATE TABLE contains exactly the proven 43-column contract, no more, no less", () => {
  const body = extractCreateTableBody();
  const columns = extractColumnNames(body);
  assert.equal(columns.length, 43, `expected exactly 43 columns, found ${columns.length}: ${columns.join(", ")}`);
  const columnSet = new Set(columns);
  for (const col of AUTHORITATIVE_LIVE_COLUMNS) {
    assert.ok(columnSet.has(col), `missing proven live column: ${col}`);
  }
  for (const col of columns) {
    assert.ok(AUTHORITATIVE_LIVE_COLUMNS.includes(col), `extra column not in the proven live schema: ${col}`);
  }
});

test("match_family_key and reservation_id are absent from the CREATE TABLE -- not real live columns", () => {
  const body = extractCreateTableBody();
  assert.doesNotMatch(body, /\bmatch_family_key\b/);
  assert.doesNotMatch(body, /\breservation_id\b/);
});

test("making_amount and taking_amount are numeric, matching the proven live column type", () => {
  const body = extractCreateTableBody();
  assert.match(body, /\bmaking_amount\s+numeric\b/, "making_amount must be numeric");
  assert.match(body, /\btaking_amount\s+numeric\b/, "taking_amount must be numeric");
  assert.doesNotMatch(body, /\bmaking_amount\s+text\b/);
  assert.doesNotMatch(body, /\btaking_amount\s+text\b/);
});

test("event_type, source, and environment are NOT NULL with the proven live defaults", () => {
  const body = extractCreateTableBody();
  assert.match(body, /\bevent_type\s+text\s+not\s+null\s+default\s+'order_event'/i);
  assert.match(body, /\bsource\s+text\s+not\s+null\s+default\s+'ireland_executor'/i);
  assert.match(body, /\benvironment\s+text\s+not\s+null\s+default\s+'production'/i);
});
