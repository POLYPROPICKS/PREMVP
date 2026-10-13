// Static integrity gate for the Box B single release payload (v2). No database needed; the behavioural
// PostgreSQL proof lives in boxBReleaseV2Behavior.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const dir = "ops/research-clone/box-b";
const rel = `${dir}/release_v2`;
const FROZEN_SOURCE_SHA = "809093ee09c46ff7ecb588cdc30266465d018c0b";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const payload = readFileSync(`${rel}/payload.sql`, "utf8");
const mig = readFileSync("ops/research-clone/migrations/20261013130000_market_outcome_box_b_authority_v1.sql", "utf8");
const pilot = readFileSync(`${dir}/pilot_insert.sql`, "utf8");
const operator = readFileSync(`${dir}/operator_dbclone_box_b_v1.sql`, "utf8");
const manifest = JSON.parse(readFileSync(`${rel}/manifest.json`, "utf8"));
const index = JSON.parse(readFileSync(`${dir}/receipts/receipts_index.json`, "utf8"));

test("payload bytes match the manifest and the frozen v1 inputs", () => {
  assert.equal(sha(readFileSync(`${rel}/payload.sql`)), manifest.payload_sha256);
  assert.equal(readFileSync(`${rel}/payload.sql`).length, manifest.payload_bytes);
  assert.equal(sha(mig), manifest.migration_sha256);
  assert.equal(sha(pilot), manifest.pilot_insert_sha256);
  assert.equal(sha(operator), manifest.operator_sql_sha256);
  assert.equal(manifest.source_sha, FROZEN_SOURCE_SHA);
  assert.equal(manifest.target_project_ref, "nppznoujvnyjargjkmnv");
});

test("payload embeds the frozen migration and the frozen pilot verbatim", () => {
  assert.ok(payload.includes(mig));
  assert.ok(payload.includes(pilot));
  const verifyBlock = operator.slice(
    operator.indexOf("do $$\ndeclare bad text;"),
    operator.lastIndexOf("commit;"),
  );
  assert.ok(verifyBlock.length > 500);
  assert.ok(payload.includes(verifyBlock));
});

test("payload has no transaction control, no ledger write and no sentinel-table identity check", () => {
  assert.doesNotMatch(payload, /^\s*(commit|rollback|savepoint|begin)\s*;/im);
  assert.doesNotMatch(payload, /^set\s/im);
  assert.doesNotMatch(payload, /supabase_migrations/);
  assert.doesNotMatch(payload, /research_inplay_core_path_observations/);
  assert.doesNotMatch(payload, /to_regclass\('(?!public\.market_outcome_)/);
  assert.equal(manifest.transaction_control, false);
  assert.equal(manifest.writes_supabase_migrations, false);
});

test("payload writes only Box B tables: 41 receipt inserts, 20 revision inserts", () => {
  const inserts = [...payload.matchAll(/^insert into (\S+)/gim)].map((m) => m[1]);
  assert.ok(inserts.every((t) => t === "public.market_outcome_provider_receipts" || t === "public.market_outcome_revisions"));
  assert.equal(inserts.filter((t) => t.endsWith("provider_receipts")).length, 41);
  assert.equal(inserts.filter((t) => t.endsWith("revisions")).length, 20);
  assert.equal(manifest.receipt_inserts, 41);
  assert.equal(manifest.revision_inserts, 20);
  assert.doesNotMatch(payload, /^\s*(update|delete\s+from|drop\s+table|truncate)\s/im);
  assert.doesNotMatch(pilot, /has_paper_decision|bet_row_key|roi|stake/i);
});

test("fail-closed verification asserts 20 distinct FINAL markets and 41 receipts before the batch ends", () => {
  const tail = payload.slice(payload.lastIndexOf("-- ===== fail-closed verification (added in v2)"));
  assert.match(tail, /count\(distinct condition_id\)[^;]*<> 20/);
  assert.match(tail, /outcome_status = 'FINAL'\) <> 20/);
  assert.match(tail, /market_outcome_provider_receipts\) <> 41/);
  assert.match(tail, /raise exception 'BOX_B_VERIFY/);
  assert.ok(payload.indexOf("BOX_B_GUARD") < payload.indexOf("create table if not exists public.market_outcome_provider_receipts"));
  assert.equal(index.length, 20);
  assert.ok(index.every((x: any) => x.classification.status === "FINAL"));
});
