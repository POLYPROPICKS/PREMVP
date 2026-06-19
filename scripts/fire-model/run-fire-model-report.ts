import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { FireLogger } from "./fireLogger";
import { fileSize, createRunDir, writeJson } from "./fireManifests";
import {
  ModelMetricRow,
  NormalizedCandidate,
  maxTwoPerFixture,
  metric,
  normalizeCandidates,
  onePerFixture,
  toCsv,
} from "./fireMetrics";
import { goldenRegression } from "./fireGoldenRegression";
import { runRegisteredQuery } from "./queryRunner";
import { sqlManifest } from "./queryRegistry";
import { writeFireWorkbook } from "./fireWorkbook";

type Registry = {
  models: Array<{
    model_id: string;
    role: string;
    sports_scope: string;
    tiers_supported: string[];
    allowed_families: string[];
    blocked_families: string[];
    dataset_contract: string;
    selection_rule: string;
    live_status: string;
    rollback_priority: number;
    sql_id: string;
  }>;
  datasets: Array<Record<string, unknown>>;
  funnels: Array<Record<string, string>>;
};

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function dateKey(now = new Date()) {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
}

function round(n: number | null, digits = 2) {
  return n == null ? null : Number(n.toFixed(digits));
}

function notNbaNhl(row: NormalizedCandidate) {
  return !["NBA", "NHL"].includes(row.sport);
}

function championRows(rows: NormalizedCandidate[]) {
  return rows.filter((row) => {
    if (!notNbaNhl(row)) return false;
    if ((row.score ?? -1) < 72) return false;
    const badBucket =
      (row.coverage ?? -1) >= 50 &&
      (row.coverage ?? -1) <= 74 &&
      (row.entry_price ?? -1) >= 0.44 &&
      (row.entry_price ?? -1) <= 0.58;
    return !badBucket;
  });
}

function fireFamilyRows(rows: NormalizedCandidate[]) {
  const allowed = new Set(["spread", "total", "corners", "moneyline"]);
  return maxTwoPerFixture(rows.filter((row) => (row.score == null || row.score >= 60) && allowed.has(row.market_family)));
}

function tieredRows(rows: NormalizedCandidate[]) {
  const tiers = new Set(["TIER1", "TIER2", "TIER3"]);
  return rows.filter((row) => tiers.has(row.tier) && row.condition_id && row.selected_token_id && row.selected_outcome);
}

function modelRows(modelId: string, rows: NormalizedCandidate[]) {
  if (modelId === "SAFETY_BASELINE") return rows;
  if (modelId === "CHAMPION_CURRENT") return championRows(rows);
  if (modelId === "PUBLISHED_ONE_PER_FIXTURE") return onePerFixture(championRows(rows));
  if (modelId === "TIERED_LIVE_CONTOUR") return tieredRows(rows);
  if (modelId === "FIRE_FAMILY_SELECTIVE") return fireFamilyRows(rows);
  return rows;
}

function metricRow(
  model: Registry["models"][number],
  rank: number,
  rows: NormalizedCandidate[],
  anchorMs: number,
): ModelMetricRow {
  const all = metric(rows, anchorMs, null);
  const h96 = metric(rows, anchorMs, 96);
  return {
    rank,
    model_id: model.model_id,
    role: model.role,
    status: rows.length ? "PASS" : "WARN_NO_ROWS",
    sports_scope: model.sports_scope,
    tiers_supported: model.tiers_supported.join("|"),
    all_time_N_bets: all.N_bets,
    all_time_N_fixtures: all.N_fixtures,
    all_time_turnover: round(all.turnover) as number,
    all_time_pnl: round(all.pnl) as number,
    all_time_roi: round(all.roi) as number,
    all_time_maxDD: round(all.maxDD) as number,
    all_time_pnl_over_maxDD: round(all.pnl_over_maxDD),
    "96h_N_bets": h96.N_bets,
    "96h_N_fixtures": h96.N_fixtures,
    "96h_turnover": round(h96.turnover) as number,
    "96h_pnl": round(h96.pnl) as number,
    "96h_roi": round(h96.roi) as number,
    "96h_maxDD": round(h96.maxDD) as number,
    avg_bets_per_fixture: all.N_fixtures ? round(all.N_bets / all.N_fixtures) as number : 0,
    allowed_families: model.allowed_families.join("|"),
    blocked_families: model.blocked_families.join("|"),
    verdict: h96.roi >= 0 && all.roi >= 0 ? "KEEP_ON_WATCH" : "ROLLBACK_WATCH",
    rollback_note: h96.roi < 0 ? "96h ROI negative" : "No automatic live-policy change from report",
  };
}

function groupSummary(rows: NormalizedCandidate[], key: keyof NormalizedCandidate) {
  const grouped = new Map<string, NormalizedCandidate[]>();
  for (const row of rows) grouped.set(String(row[key] || "UNKNOWN"), [...(grouped.get(String(row[key] || "UNKNOWN")) ?? []), row]);
  return [...grouped.entries()].map(([group, xs]) => {
    const anchorMs = Math.max(...xs.map((row) => Date.parse(row.resolved_at)).filter(Number.isFinite));
    const m = metric(xs, anchorMs, null);
    return {
      group,
      rows: xs.length,
      fixtures: new Set(xs.map((row) => row.fixture_key)).size,
      pnl: round(m.pnl),
      roi: round(m.roi),
      winrate: m.N_bets ? round((m.wins / m.N_bets) * 100) : 0,
    };
  }).sort((a, b) => b.rows - a.rows);
}

async function main() {
  const verify = process.argv.includes("--verify");
  const invokedBy = argValue("--invoked-by=") ?? "direct";
  const runId = `fire_${dateKey()}_${Date.now()}`;
  const runDir = await createRunDir();
  const logger = new FireLogger(runDir);
  await logger.init();
  const registryPath = path.join(process.cwd(), "modeling", "fire_model_registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as Registry;
  const sqlRows = await sqlManifest();
  await writeJson(path.join(runDir, "sql_manifest.json"), sqlRows);

  await logger.log({ run_id: runId, step: "sql_manifest", row_count: sqlRows.length, status: "OK", warning_count: 0 });

  const published = await runRegisteredQuery("all_sports_published_signals_v1");
  await logger.log({
    run_id: runId,
    step: "dataset_fetch",
    dataset_id: "ALL_SPORTS_PUBLISHED_SIGNALS_V1",
    sql_id: published.queryId,
    query_id: published.queryId,
    source_table: published.sourceTable,
    row_count: published.rows.length,
    status: published.status,
    warning_count: published.warning ? 1 : 0,
    message: published.warning,
  });
  const research = await runRegisteredQuery("all_sports_research_candidates_v1");
  await logger.log({
    run_id: runId,
    step: "dataset_fetch",
    dataset_id: "ALL_SPORTS_RESEARCH_CANDIDATES_V1",
    sql_id: research.queryId,
    query_id: research.queryId,
    source_table: research.sourceTable,
    row_count: research.rows.length,
    status: research.status,
    warning_count: research.warning ? 1 : 0,
    message: research.warning,
  });

  const normalized = normalizeCandidates(published.rows).filter((row) => row.pnl10 != null);
  const anchorMs = Math.max(...normalized.map((row) => Date.parse(row.resolved_at)).filter(Number.isFinite));
  const modelComparison = registry.models.map((model, index) => {
    const selected = modelRows(model.model_id, normalized);
    return metricRow(model, index + 1, selected, anchorMs);
  }).sort((a, b) => b.all_time_pnl_over_maxDD! - a.all_time_pnl_over_maxDD!);
  modelComparison.forEach((row, index) => (row.rank = index + 1));

  for (const row of modelComparison) {
    await logger.log({
      run_id: runId,
      step: "model_metric",
      model_id: row.model_id,
      dataset_id: "ALL_SPORTS_RESOLVED_CANDIDATES_V1",
      sql_id: registry.models.find((m) => m.model_id === row.model_id)?.sql_id,
      row_count: row.all_time_N_bets,
      included_count: row.all_time_N_bets,
      excluded_count: normalized.length - row.all_time_N_bets,
      warning_count: row.status.startsWith("WARN") ? 1 : 0,
      status: row.status.startsWith("WARN") ? "WARN" : "OK",
    });
  }

  const researchConditions = new Set(research.rows.map((row) => row.condition_id).filter(Boolean)).size;
  const publishedConditions = new Set(published.rows.map((row) => row.condition_id).filter(Boolean)).size;
  const funnelHealth = [
    { funnel_id: "L0_RAW_MARKET_INVENTORY", rows: research.rows.length, fixtures: new Set(research.rows.map((r) => r.event_slug || r.market_slug)).size, distinct_condition_id: researchConditions, distinct_token_id: new Set(research.rows.map((r) => r.selected_token_id || r.token_id || r.outcome_token_id).filter(Boolean)).size, coverage_pct: 100, unresolved_count: research.rows.filter((r) => !r.signal_result).length, warnings: research.rows.length ? "" : "WARN_NO_RESEARCH_ROWS" },
    { funnel_id: "L1_RESEARCH_CANDIDATES", rows: research.rows.length, fixtures: new Set(research.rows.map((r) => r.event_slug || r.market_slug)).size, distinct_condition_id: researchConditions, distinct_token_id: new Set(research.rows.map((r) => r.selected_token_id || r.token_id || r.outcome_token_id).filter(Boolean)).size, coverage_pct: 100, unresolved_count: research.rows.filter((r) => !r.signal_result).length, warnings: "" },
    { funnel_id: "L2_SCORED_CANDIDATES", rows: research.rows.filter((r) => r.score != null || r.signal_score != null || r.confidence != null).length, fixtures: new Set(research.rows.map((r) => r.event_slug || r.market_slug)).size, distinct_condition_id: researchConditions, distinct_token_id: new Set(research.rows.map((r) => r.selected_token_id || r.token_id || r.outcome_token_id).filter(Boolean)).size, coverage_pct: research.rows.length ? round((research.rows.filter((r) => r.score != null || r.signal_score != null || r.confidence != null).length / research.rows.length) * 100) : 0, unresolved_count: 0, warnings: "score_missing_count=" + research.rows.filter((r) => r.score == null && r.signal_score == null && r.confidence == null).length },
    { funnel_id: "L3_DECISION_LAYER", rows: published.rows.length, fixtures: new Set(published.rows.map((r) => r.event_slug || r.market_slug)).size, distinct_condition_id: publishedConditions, distinct_token_id: new Set(published.rows.map((r) => r.selected_token_id).filter(Boolean)).size, coverage_pct: 100, unresolved_count: published.rows.filter((r) => !r.signal_result).length, warnings: "" },
    { funnel_id: "L4_EXECUTION_LAYER", rows: 0, fixtures: 0, distinct_condition_id: 0, distinct_token_id: 0, coverage_pct: 0, unresolved_count: 0, warnings: "see live_contour_snapshot.csv" },
    { funnel_id: "L5_RESOLUTION_LAYER", rows: normalized.length, fixtures: new Set(normalized.map((r) => r.fixture_key)).size, distinct_condition_id: new Set(normalized.map((r) => r.condition_id)).size, distinct_token_id: new Set(normalized.map((r) => r.selected_token_id)).size, coverage_pct: published.rows.length ? round((normalized.length / published.rows.length) * 100) : 0, unresolved_count: published.rows.length - normalized.length, warnings: "" },
  ];

  const live = await runRegisteredQuery("live_contour_state_v1");
  const liveRows = live.rows.filter((row) => !row.firemodel_warning);
  const liveContour = [{
    status: live.warning ? "WARN" : "PASS",
    current_live_candidate_count: liveRows.filter((row) => row.stage === "EXPOSED_BY_API").length,
    tier1_count: liveRows.filter((row) => String(row.tier).toUpperCase() === "TIER1").length,
    tier2_count: liveRows.filter((row) => String(row.tier).toUpperCase() === "TIER2").length,
    tier3_count: liveRows.filter((row) => String(row.tier).toUpperCase() === "TIER3").length,
    planned_exposure: round(liveRows.reduce((sum, row) => sum + (Number(row.stake_usd) || 0), 0)),
    executed_exposure: 0,
    pending_orders: 0,
    filled_orders: 0,
    failed_orders: 0,
    duplicate_prevented: liveRows.filter((row) => /duplicate/i.test(String(row.reason))).length,
    latest_executor_audit_event_timestamp: liveRows[0]?.created_at ?? "",
    latest_order_event_timestamp: "",
    live_priority_resolver_freshness: "verify:resolver-pipeline owns this check",
    warning: live.warning ?? "",
  }];

  const denominator = [{
    dataset_id: "ALL_SPORTS_RESEARCH_CANDIDATES_V1",
    rows: research.rows.length,
    fixtures: new Set(research.rows.map((row) => row.event_slug || row.market_slug)).size,
    conditions: researchConditions,
    tokens: new Set(research.rows.map((row) => row.selected_token_id || row.token_id || row.outcome_token_id).filter(Boolean)).size,
    warnings: "",
  }, {
    dataset_id: "ALL_SPORTS_PUBLISHED_SIGNALS_V1",
    rows: published.rows.length,
    fixtures: new Set(published.rows.map((row) => row.event_slug || row.market_slug)).size,
    conditions: publishedConditions,
    tokens: new Set(published.rows.map((row) => row.selected_token_id).filter(Boolean)).size,
    warnings: "",
  }, {
    dataset_id: "ALL_SPORTS_STRICT_RESOLVED_V1",
    rows: normalized.length,
    fixtures: new Set(normalized.map((row) => row.fixture_key)).size,
    conditions: new Set(normalized.map((row) => row.condition_id)).size,
    tokens: new Set(normalized.map((row) => row.selected_token_id)).size,
    warnings: "",
  }];

  const familyBreakdown = groupSummary(normalized, "market_family");
  const sportBreakdown = groupSummary(normalized, "sport");
  const tierBreakdown = groupSummary(normalized, "tier");
  const golden = await goldenRegression();
  const warnings = [
    ...golden.filter((row) => row.status !== "PASS").map((row) => `${row.anchor_id}: ${row.status}`),
    ...(live.warning ? [`live_contour: ${live.warning}`] : []),
    ...funnelHealth.filter((row) => row.warnings).map((row) => `${row.funnel_id}: ${row.warnings}`),
  ];
  const rollbackWatch = modelComparison
    .filter((row) => row.verdict === "ROLLBACK_WATCH")
    .map((row) => ({ model_id: row.model_id, rollback_note: row.rollback_note, all_time_roi: row.all_time_roi, "96h_roi": row["96h_roi"] }));

  const csvFiles = [
    ["model_comparison.csv", modelComparison, Object.keys(modelComparison[0] ?? {})],
    ["funnel_health.csv", funnelHealth, Object.keys(funnelHealth[0] ?? {})],
    ["denominator_check.csv", denominator, Object.keys(denominator[0] ?? {})],
    ["market_family_breakdown.csv", familyBreakdown, Object.keys(familyBreakdown[0] ?? {})],
    ["tier_breakdown.csv", tierBreakdown, Object.keys(tierBreakdown[0] ?? {})],
    ["sport_breakdown.csv", sportBreakdown, Object.keys(sportBreakdown[0] ?? {})],
    ["live_contour_snapshot.csv", liveContour, Object.keys(liveContour[0] ?? {})],
    ["rollback_watch.csv", rollbackWatch, Object.keys(rollbackWatch[0] ?? { model_id: "", rollback_note: "" })],
  ] as Array<[string, Record<string, unknown>[], string[]]>;
  for (const [name, rows, headers] of csvFiles) await writeFile(path.join(runDir, name), toCsv(rows, headers), "utf8");

  const workbookPath = path.join(runDir, `polypropicks_fire_model_report_${dateKey()}.xlsx`);
  await writeFireWorkbook(workbookPath, {
    "Executive Summary": [{
      run_id: runId,
      status: warnings.length ? "PASS_WITH_WARNINGS" : "PASS",
      current_champion: modelComparison[0]?.model_id ?? "",
      best_96h_model: [...modelComparison].sort((a, b) => b["96h_roi"] - a["96h_roi"])[0]?.model_id ?? "",
      fire_run_folder: runDir,
      invoked_by: invokedBy,
    }],
    "Model Comparison": modelComparison,
    "Funnel Health": funnelHealth,
    "Live Contour": liveContour,
    "Denominator Check": denominator,
    "Market Family Breakdown": familyBreakdown,
    "Tier Breakdown": tierBreakdown,
    "SQL Manifest": sqlRows as unknown as Record<string, unknown>[],
    "Warnings": warnings.length ? warnings.map((warning) => ({ warning })) : [{ warning: "NONE" }],
  });

  await writeJson(path.join(runDir, "dataset_manifest.json"), { datasets: registry.datasets, denominator });
  await writeJson(path.join(runDir, "model_manifest.json"), { models: registry.models, modelComparison });
  await writeJson(path.join(runDir, "funnel_manifest.json"), { funnels: registry.funnels, funnelHealth });
  await writeJson(path.join(runDir, "run_manifest.json"), {
    run_id: runId,
    status: warnings.length ? "PASS_WITH_WARNINGS" : "PASS",
    invoked_by: invokedBy,
    generated_at: new Date().toISOString(),
    run_dir: runDir,
    workbook_path: workbookPath,
    adapter_mode: "SUPABASE_REST_REGISTERED_QUERY",
    model_count: modelComparison.length,
    warning_count: warnings.length,
  });
  await writeFile(path.join(runDir, "warnings.md"), warnings.length ? warnings.map((w) => `- ${w}`).join("\n") + "\n" : "No warnings.\n", "utf8");
  await writeFile(
    path.join(runDir, "audit_summary.md"),
    [
      "# FireModel Audit Summary",
      "",
      `Run ID: ${runId}`,
      `Status: ${warnings.length ? "PASS_WITH_WARNINGS" : "PASS"}`,
      `Adapter mode: SUPABASE_REST_REGISTERED_QUERY`,
      `Model comparison rows: ${modelComparison.length}`,
      `Workbook: ${workbookPath}`,
      `Live contour included: ${liveContour.length > 0 ? "yes" : "no"}`,
    ].join("\n") + "\n",
    "utf8",
  );

  const required = [
    "run_manifest.json",
    "run_log.ndjson",
    "run_log.md",
    "sql_manifest.json",
    "dataset_manifest.json",
    "model_manifest.json",
    "funnel_manifest.json",
    "model_comparison.csv",
    "funnel_health.csv",
    "denominator_check.csv",
    "market_family_breakdown.csv",
    "tier_breakdown.csv",
    "sport_breakdown.csv",
    "live_contour_snapshot.csv",
    "rollback_watch.csv",
    "warnings.md",
    "audit_summary.md",
  ];
  const missing = required.filter((file) => !existsSync(path.join(runDir, file)));
  if (missing.length) throw new Error(`FIREMODEL_VERIFY_FAIL missing=${missing.join(",")}`);
  if (modelComparison.length < 4) throw new Error(`FIREMODEL_VERIFY_FAIL model_count=${modelComparison.length}`);
  if ((await fileSize(workbookPath)) <= 0) throw new Error("FIREMODEL_VERIFY_FAIL empty workbook");

  const result = {
    code: verify ? "FIREMODEL_VERIFY_PASS" : "FIREMODEL_REPORT_PASS",
    run_id: runId,
    status: warnings.length ? "PASS_WITH_WARNINGS" : "PASS",
    runDir,
    workbookPath,
    modelComparisonRows: modelComparison.length,
    liveContourIncluded: true,
    warnings,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
