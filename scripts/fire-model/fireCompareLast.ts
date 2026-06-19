import { readFileSync } from "fs";
import path from "path";
import { listFireRunDirs, parseCsv, readJson } from "./fireRunUtils";

async function loadRun(runDir: string) {
  const manifest = await readJson<Record<string, any>>(path.join(runDir, "run_manifest.json"));
  const models = parseCsv(readFileSync(path.join(runDir, "model_comparison.csv"), "utf8"));
  const champion = models.find((row) => row.model_id === manifest.current_champion) ?? models[0];
  const best96 = [...models].sort((a, b) => Number(b["96h_roi"] || 0) - Number(a["96h_roi"] || 0))[0];
  return { runDir, manifest, models, champion, best96 };
}

async function main() {
  const dirs = listFireRunDirs();
  if (dirs.length < 2) {
    console.log(JSON.stringify({ code: "FIREMODEL_COMPARE_LAST_WARN", status: "WARN", reason: "only one or zero fire runs found", run_count: dirs.length }, null, 2));
    return;
  }
  const [latest, previous] = await Promise.all([loadRun(dirs[0]), loadRun(dirs[1])]);
  console.log(JSON.stringify({
    code: "FIREMODEL_COMPARE_LAST",
    latest_run: latest.runDir,
    previous_run: previous.runDir,
    champion_latest: latest.manifest.current_champion,
    champion_previous: previous.manifest.current_champion,
    best_96h_latest: latest.best96?.model_id,
    best_96h_previous: previous.best96?.model_id,
    champion_96h_roi_delta: Number(latest.champion?.["96h_roi"] || 0) - Number(previous.champion?.["96h_roi"] || 0),
    model_count_delta: latest.models.length - previous.models.length,
    warnings_delta: Number(latest.manifest.warning_count || 0) - Number(previous.manifest.warning_count || 0),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
