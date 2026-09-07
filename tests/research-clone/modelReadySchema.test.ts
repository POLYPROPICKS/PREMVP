import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync("ops/research-clone/model-ready-schema.sql", "utf8");
test("clone read model has durable identity and idempotent economics keys", () => {
  assert.match(sql, /primary key \(model_date, population_id, condition_id, selected_token_id, decision_at\)/);
  assert.match(sql, /primary key \(as_of_date, period_kind, population_id, model_id\)/);
  assert.match(sql, /DEGRADED_EXCLUDED/);
  assert.match(sql, /revoke all .* from anon, authenticated/);
});
