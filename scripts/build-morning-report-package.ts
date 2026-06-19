import { loadEnvConfig } from "@next/env";
import { existsSync } from "fs";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { spawnSync } from "child_process";

type ManifestFile = { kind: string; path: string; bytes: number };
type CsvRow = Record<string, string>;

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function minskDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Minsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

function run(label: string, command: string, args: string[], bestEffort = false): void {
  console.log(`[morning-package] ${label}: ${[command, ...args].join(" ")}`);
  const res = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit", shell: true });
  if (res.status !== 0 && !bestEffort) {
    throw new Error(`[morning-package] ${label} failed with exit code ${res.status ?? 1}`);
  }
  if (res.status !== 0 && bestEffort) {
    console.warn(`[morning-package] ${label} best-effort failure exit=${res.status ?? 1}`);
  }
}

function csvSplitLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = csvSplitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = csvSplitLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])) as CsvRow;
  });
}

async function fileBytes(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

async function main() {
  loadEnvConfig(process.cwd());
  const date = argValue("--date=") ?? minskDateKey();
  const email = argValue("--email=") ?? "alexgrushin@gmail.com";
  const skipLivePriority = process.argv.includes("--skip-live-priority");
  const packageDir = path.join(process.cwd(), "modeling", "morning_model_report", `${date}_0600UTC`);
  const tablesDir = path.join(packageDir, "tables");
  const summaryPath = path.join(tablesDir, "run_summary.json");
  const manifestPath = path.join(packageDir, "manifest.json");
  const auditDir = path.join(process.cwd(), "reports", "morning", date);
  const auditPath = path.join(auditDir, "two_stage_morning_pipeline_audit.md");
  await mkdir(auditDir, { recursive: true });

  if (!skipLivePriority) {
    run("resolver-live-priority", "npm", ["run", "resolve:signals:live-priority"], true);
  }
  run("resolver-cron", "npm", ["run", "resolve:signals:cron"]);
  run("resolver-verify", "npm", ["run", "verify:resolver-pipeline"]);
  run("morning-model-report", "npm", ["run", "morning:model-report", "--", "--dry-run", `--email=${email}`]);

  if (!existsSync(summaryPath)) throw new Error(`[morning-package] Missing run summary: ${summaryPath}`);
  const freezePath = path.join(packageDir, "input", "resolved_freeze.csv");
  if (!existsSync(freezePath)) throw new Error(`[morning-package] Missing freeze CSV: ${freezePath}`);
  const freezeRows = parseCsv(await readFile(freezePath, "utf8"));
  const strictResolvedTotal = new Set(
    freezeRows.map((row) => `${row.condition_id ?? ""}::${row.selected_token_id ?? ""}`),
  ).size;
  const eventGroups = new Set(
    freezeRows.map((row) => row.match_family_key || row.event_key || row.event_slug || row.market_slug || ""),
  ).size;
  const maxResolvedAt = freezeRows.reduce((max, row) => {
    const t = Date.parse(row.resolved_at || row.created_at || "");
    return Number.isFinite(t) && t > max ? t : max;
  }, Number.NEGATIVE_INFINITY);
  const maxResolvedIso = Number.isFinite(maxResolvedAt) ? new Date(maxResolvedAt).toISOString() : "";
  const files = [
    { kind: "morning_report", path: path.join(packageDir, `polypropicks_morning_report_${date}.xlsx`) },
    { kind: "ceo_dashboard", path: path.join(packageDir, `ceo_dashboard_details_${date}.xlsx`) },
    { kind: "ice_counterfactual", path: path.join(packageDir, `ice_four_models_counterfactual_${date}.xlsx`) },
  ];
  const manifestFiles: ManifestFile[] = [];
  for (const file of files) {
    if (!existsSync(file.path)) throw new Error(`[morning-package] Missing file: ${file.path}`);
    const bytes = await fileBytes(file.path);
    if (bytes <= 0) throw new Error(`[morning-package] Empty file: ${file.path}`);
    manifestFiles.push({ kind: file.kind, path: file.path, bytes });
  }
  if (manifestFiles.length !== 3) throw new Error(`[morning-package] attachment count invalid: ${manifestFiles.length}`);

  if (strictResolvedTotal <= 707) throw new Error(`[morning-package] DATASET_STALE_BLOCKER strict_resolved_total=${strictResolvedTotal}`);
  if (!maxResolvedIso || Date.parse(maxResolvedIso) <= Date.parse("2026-06-17T09:01:31.130Z")) {
    throw new Error(`[morning-package] DATASET_STALE_BLOCKER max_resolved_at=${maxResolvedIso || "MISSING"}`);
  }

  const subject = `PolyProPicks Morning Model Report — ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} — N=${strictResolvedTotal}`;
  const manifest = {
    status: "READY",
    date,
    generated_at: new Date().toISOString(),
    source: "build-morning-report-package",
    strict_resolved_total: strictResolvedTotal,
    event_groups: eventGroups,
    max_resolved_at: maxResolvedIso,
    delta_vs_ice707_rows: strictResolvedTotal - 707,
    delta_vs_ice707_events: eventGroups - 501,
    files: manifestFiles,
    subject,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(
    auditPath,
    [
      "# Two-Stage Morning Pipeline Audit",
      "",
      "Stage 1 builder: `npm run ops:morning-package`",
      "Stage 2 sender: `npm run ops:morning-send-ready -- --send-test --email=alexgrushin@gmail.com`",
      "",
      `Package dir: ${packageDir}`,
      `Manifest: ${manifestPath}`,
      `Status: READY`,
      `strict_resolved_total: ${strictResolvedTotal}`,
      `event_groups: ${eventGroups}`,
      `max_resolved_at: ${maxResolvedIso}`,
      `delta_vs_ice707_rows: ${strictResolvedTotal - 707}`,
      `delta_vs_ice707_events: ${eventGroups - 501}`,
      `attachment_count: ${manifestFiles.length}`,
      "",
      "The sender must never query generated_signal_pairs or rebuild XLSX.",
    ].join("\n") + "\n",
    "utf8",
  );

  console.log(JSON.stringify({ manifestPath, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
