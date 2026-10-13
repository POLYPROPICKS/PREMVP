// Static integrity gate for Box B artifacts (no database needed). The behavioural
// PostgreSQL proof lives in boxBOutcomeBehavior.sh/.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const dir = "ops/research-clone/box-b";
const mig = readFileSync("ops/research-clone/migrations/20261013130000_market_outcome_box_b_authority_v1.sql", "utf8");
const op = readFileSync(`${dir}/operator_dbclone_box_b_v1.sql`, "utf8");
const pilot = readFileSync(`${dir}/pilot_insert.sql`, "utf8");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const manifest = JSON.parse(readFileSync(`${dir}/build_manifest.json`, "utf8"));
const index = JSON.parse(readFileSync(`${dir}/receipts/receipts_index.json`, "utf8"));

test("operator script embeds the migration verbatim and the pilot verbatim", () => {
  assert.ok(op.includes(mig));
  assert.ok(op.includes(pilot));
  assert.equal(sha(mig), manifest.migration.sha256);
  assert.equal(sha(pilot), manifest.pilot_insert_sha256);
  assert.equal(sha(op), manifest.operator_sql_sha256);
});

test("frozen input and receipts index match the manifest", () => {
  assert.equal(sha(readFileSync(`${dir}/market20_frozen_input.csv`)), manifest.frozen_input_sha256);
  assert.equal(sha(readFileSync(`${dir}/receipts/receipts_index.json`)), manifest.receipts_index_sha256);
  assert.equal(index.length, 20);
});

test("every stored raw provider body re-hashes to its recorded digest", () => {
  for (const x of index) {
    for (const rc of [x.gamma_receipt, x.clob_receipt, x.token_lookup_receipt].filter(Boolean)) {
      assert.equal(sha(readFileSync(`${dir}/receipts/${rc.file}`)), rc.raw_digest, rc.file);
    }
  }
});

test("statuses are provider-derived and absence is never recorded as an outcome", () => {
  const allowed = new Set(["FINAL", "PENDING", "VOID", "CONFLICT", "LOOKUP_FAILED"]);
  for (const x of index) {
    assert.ok(allowed.has(x.classification.status));
    if (x.classification.status !== "FINAL") assert.equal(x.classification.winner_token_id, null);
  }
});

test("Box B writes no model/bet economics and touches no other table", () => {
  const body = mig.replace(/--.*$/gm, "");
  assert.doesNotMatch(body, /\b(bet_row_key|roi|stake|has_paper_decision)\b/i);
  assert.doesNotMatch(body, /\b(alter|update|delete\s+from|insert\s+into|drop)\s+(table\s+)?(only\s+)?public\.(?!market_outcome_)/i);
  assert.doesNotMatch(pilot, /has_paper_decision|bet_row_key|roi|stake/i);
  assert.match(mig, /revoke all on public\.market_outcome_revisions from public, anon, authenticated/);
  assert.match(mig, /blind_model_reader/);
  assert.doesNotMatch(mig, /grant[^;]*(update|delete|truncate)[^;]*service_role/i);
});
