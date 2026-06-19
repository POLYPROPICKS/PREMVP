import { readFileSync } from "fs";
import path from "path";
import { latestFireRunDir, parseCsv, readJson } from "./fireRunUtils";

async function main() {
  const runDir = latestFireRunDir();
  if (!runDir) throw new Error("FIREMODEL_LATEST_NOT_FOUND");
  const manifest = await readJson<Record<string, any>>(path.join(runDir, "run_manifest.json"));
  const models = parseCsv(readFileSync(path.join(runDir, "model_comparison.csv"), "utf8"));
  const warnings = readFileSync(path.join(runDir, "warnings.md"), "utf8").trim().split(/\r?\n/).filter(Boolean);
  console.log(JSON.stringify({
    code: "FIREMODEL_LATEST",
    runDir,
    status: manifest.status,
    workbook_path: manifest.workbook_path,
    champion: manifest.current_champion ?? models[0]?.model_id,
    best_96h_model: manifest.best_96h_model,
    warning_count: manifest.warning_count,
    warnings,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
