import { existsSync, readFileSync } from "fs";
import path from "path";
import { latestFireRunDir, parseCsv, readJson } from "./fireRunUtils";

const REQUIRED = [
  "run_manifest.json",
  "run_log.ndjson",
  "run_log.md",
  "sql_manifest.json",
  "query_execution_manifest.json",
  "command_manifest.json",
  "dataset_manifest.json",
  "model_manifest.json",
  "funnel_manifest.json",
  "data_quality_manifest.json",
  "model_comparison.csv",
  "model_change_detector.csv",
  "funnel_health.csv",
  "denominator_check.csv",
  "sport_breakdown.csv",
  "sport_x_model.csv",
  "tier_breakdown.csv",
  "tier_x_model.csv",
  "market_family_breakdown.csv",
  "family_x_model.csv",
  "live_contour_snapshot.csv",
  "warnings.md",
  "audit_summary.md",
];

async function main() {
  const runDir = latestFireRunDir();
  if (!runDir) throw new Error("FIREMODEL_DOCTOR_FAIL: no fire run directory found");
  const missing = REQUIRED.filter((file) => !existsSync(path.join(runDir, file)));
  const manifest = await readJson<Record<string, any>>(path.join(runDir, "run_manifest.json"));
  const modelRows = parseCsv(readFileSync(path.join(runDir, "model_comparison.csv"), "utf8"));
  const queryRows = await readJson<Array<Record<string, any>>>(path.join(runDir, "query_execution_manifest.json"));
  const warnings = readFileSync(path.join(runDir, "warnings.md"), "utf8");
  const allText = REQUIRED
    .filter((file) => existsSync(path.join(runDir, file)))
    .map((file) => readFileSync(path.join(runDir, file), "utf8"))
    .join("\n");
  const secretRegex = /(SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*[A-Za-z0-9._-]{12,}|RESEND_API_KEY\s*[:=]\s*[A-Za-z0-9._-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/i;
  const failures = [
    ...missing.map((file) => `missing:${file}`),
    manifest.primary_scope !== "ALL_SPORTS" ? "primary_scope_not_all_sports" : "",
    manifest.legacy_wc_smoke_test_is_benchmark !== false ? "wc_smoke_marked_benchmark" : "",
    modelRows.length < 4 ? `model_rows_lt_4:${modelRows.length}` : "",
    queryRows.some((row) => !row.query_id || !row.sql_id) ? "query_manifest_missing_query_or_sql_id" : "",
    !warnings ? "warnings_missing" : "",
    secretRegex.test(allText) ? "secret_like_value_detected" : "",
  ].filter(Boolean);

  const result = {
    code: failures.length ? "FIREMODEL_DOCTOR_FAIL" : "FIREMODEL_DOCTOR_PASS",
    status: failures.length ? "FAIL" : "PASS",
    runDir,
    primary_scope: manifest.primary_scope,
    legacy_wc_smoke_test_is_benchmark: manifest.legacy_wc_smoke_test_is_benchmark,
    model_rows: modelRows.length,
    query_rows: queryRows.length,
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
