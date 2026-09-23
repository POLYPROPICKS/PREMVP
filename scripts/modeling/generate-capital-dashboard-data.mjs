import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = path.join(root, "modeling/evidence/daily-batch-capital-approx-v1/DAILY_BATCH_CAPITAL_APPROX_2026-08-04_2026-09-20.json");
const outputPath = path.join(root, "modeling/evidence/modeling-dashboard-v1/CAPITAL_MODELING_DATA.js");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const scenarioNames = ["EARLY_DD", "MID_DD", "LATE_DD"];
const fields = ["ending_total_usd", "free_active_usd", "open_principal_usd", "vault_usd", "max_drawdown_usd", "executed_n", "capital_skip_n"];

if (source.MISSION !== "DAILY_BATCH_CAPITAL_APPROX_V1" || source.EXACT_BET_LEVEL_REPLAY !== false || source.AUTHORITY_TOTALS_EXACT !== true) {
  throw new Error("Capital approximation source identity or authority flags changed");
}
const models = source.rows.map((row) => {
  const scenarios = Object.fromEntries(scenarioNames.map((name) => {
    const scenario = row.scenarios[name];
    if (!scenario || !scenario.fixed || !scenario.protected) throw new Error(`Missing scenario ${row.model}/${name}`);
    return [name, {
      fixed: Object.fromEntries(fields.map((field) => [field, scenario.fixed[field]])),
      protected: Object.fromEntries(fields.map((field) => [field, scenario.protected[field]])),
      protected_minus_fixed_total_usd: scenario.protected_minus_fixed_total_usd,
    }];
  }));
  const values = (policy, field) => scenarioNames.map((name) => scenarios[name][policy][field]);
  const range = (items) => ({ min: Math.min(...items), max: Math.max(...items) });
  return {
    model: row.model,
    authority: row.authority,
    scenarios,
    summary: {
      fixed_end_usd: range(values("fixed", "ending_total_usd")),
      protected_end_usd: range(values("protected", "ending_total_usd")),
      protected_upside_usd: range(scenarioNames.map((name) => scenarios[name].protected_minus_fixed_total_usd)),
      vault_usd: range(values("protected", "vault_usd")),
      max_drawdown_usd: range(scenarioNames.flatMap((name) => [scenarios[name].fixed.max_drawdown_usd, scenarios[name].protected.max_drawdown_usd])),
      capital_skips: Math.max(...scenarioNames.flatMap((name) => [scenarios[name].fixed.capital_skip_n, scenarios[name].protected.capital_skip_n])),
    },
  };
});
const data = {
  meta: {
    sourceMission: source.MISSION,
    sourceWindow: [source.rows[0].daily[0].date, source.rows[0].daily.at(-1).date],
    startingCapitalUsd: 100,
    cap: 30,
    dailyAggregateApproximation: source.DAILY_AGGREGATE_APPROXIMATION,
    exactBetLevelReplay: source.EXACT_BET_LEVEL_REPLAY,
    authorityTotalsExact: source.AUTHORITY_TOTALS_EXACT,
  },
  scenarioNames,
  models,
};
await writeFile(outputPath, `// Generated projection; source economics remain in DAILY_BATCH_CAPITAL_APPROX_V1.\nwindow.POLYPROPICKS_CAPITAL_MODELING_DATA = ${JSON.stringify(data, null, 2)};\n`);
