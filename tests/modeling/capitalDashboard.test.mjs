import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const root = new URL("../../", import.meta.url);
const read = (relative) => readFile(new URL(relative, root), "utf8");

test("capital dashboard projection preserves source scenarios and is independently wired", async () => {
  execFileSync(process.execPath, ["scripts/modeling/generate-capital-dashboard-data.mjs"], { cwd: new URL("../../", import.meta.url) });
  const source = JSON.parse(await read("modeling/evidence/daily-batch-capital-approx-v1/DAILY_BATCH_CAPITAL_APPROX_2026-08-04_2026-09-20.json"));
  const projectionJs = await read("modeling/evidence/modeling-dashboard-v1/CAPITAL_MODELING_DATA.js");
  const context = { window: {} };
  vm.runInNewContext(projectionJs, context);
  const projection = context.window.POLYPROPICKS_CAPITAL_MODELING_DATA;
  assert.equal(projection.models.length, 5);
  assert.equal(projection.meta.startingCapitalUsd, 100);
  assert.equal(projection.meta.cap, 30);
  assert.equal(projection.meta.dailyAggregateApproximation, true);
  assert.equal(projection.meta.exactBetLevelReplay, false);
  for (const [index, row] of source.rows.entries()) {
    const projected = projection.models[index];
    assert.equal(projected.model, row.model);
    for (const scenario of projection.scenarioNames) {
      assert.deepEqual(JSON.parse(JSON.stringify(projected.scenarios[scenario])), {
        fixed: Object.fromEntries(["ending_total_usd", "free_active_usd", "open_principal_usd", "vault_usd", "max_drawdown_usd", "executed_n", "capital_skip_n"].map((key) => [key, row.scenarios[scenario].fixed[key]])),
        protected: Object.fromEntries(["ending_total_usd", "free_active_usd", "open_principal_usd", "vault_usd", "max_drawdown_usd", "executed_n", "capital_skip_n"].map((key) => [key, row.scenarios[scenario].protected[key]])),
        protected_minus_fixed_total_usd: row.scenarios[scenario].protected_minus_fixed_total_usd,
      });
    }
    assert.equal(projected.summary.capital_skips, 0);
  }
  const html = await read("modeling/evidence/modeling-dashboard-v1/MODELING_DASHBOARD.html");
  assert.match(html, /<script src="CAPITAL_MODELING_DATA\.js"><\/script>/);
  assert.match(html, /\["capital", "CAPITAL"\]/);
  assert.match(html, /DAILY AGGREGATE APPROXIMATION/);
  assert.match(html, /NOT A FORECAST/);
  assert.match(html, /prospective exact-sequence validation and explicit capital bounds/);
  assert.match(html, /capital_skip_n/);
});
