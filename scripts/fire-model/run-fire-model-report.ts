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
import { legacyWcSmokeTest } from "./fireGoldenRegression";
import { runRegisteredQuery } from "./queryRunner";
import { sqlManifest } from "./queryRegistry";
import { writeFireWorkbook } from "./fireWorkbook";
import { execSync } from "child_process";

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

function safeExec(command: string): string {
  try {
    return execSync(command, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
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
  const d7 = metric(rows, anchorMs, 24 * 7);
  const sportCoverage = [...new Set(rows.map((row) => row.sport || "UNKNOWN"))].sort().join("|");
  const tierCoverage = [...new Set(rows.map((row) => row.tier || "UNKNOWN"))].sort().join("|");
  const tinySamplePenalty = all.N_bets < 50 ? 25 : all.N_bets < 100 ? 10 : 0;
  const missingCoveragePenalty = rows.some((row) => row.tier === "UNKNOWN") ? 5 : 0;
  const negativeRecentPenalty = h96.roi < 0 ? 20 : 0;
  const fireRankScore = Math.round(
    (all.pnl > 0 ? 15 : -10) +
    (h96.pnl > 0 ? 20 : -20) +
    Math.min(30, (all.pnl_over_maxDD ?? 0) * 10) +
    Math.min(30, (h96.pnl_over_maxDD ?? 0) * 10) -
    tinySamplePenalty -
    missingCoveragePenalty -
    negativeRecentPenalty,
  );
  const verdict =
    h96.roi < 0 ? "ROLLBACK_WATCH" :
      model.role === "SHADOW" ? "SHADOW_ONLY" :
        fireRankScore >= 45 ? "PROMOTE_WATCH" :
          model.role === "BASELINE" ? "RESEARCH_ONLY" :
            "KEEP_CHAMPION";
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
    "96h_pnl_over_maxDD": round(h96.pnl_over_maxDD),
    "7d_N_bets": d7.N_bets,
    "7d_N_fixtures": d7.N_fixtures,
    "7d_pnl": round(d7.pnl) as number,
    "7d_roi": round(d7.roi) as number,
    avg_bets_per_fixture: all.N_fixtures ? round(all.N_bets / all.N_fixtures) as number : 0,
    allowed_families: model.allowed_families.join("|"),
    blocked_families: model.blocked_families.join("|"),
    sport_coverage: sportCoverage,
    tier_coverage: tierCoverage,
    fire_rank_score: fireRankScore,
    verdict,
    rollback_note: h96.roi < 0 ? "96h ROI negative" : "No automatic live-policy change from report",
    promotion_note: fireRankScore >= 45 ? "Watch only; auto_switch_allowed=false" : "No promotion",
    data_quality_status: rows.some((row) => row.score == null || row.tier === "UNKNOWN") ? "PASS_WITH_WARNINGS" : "PASS",
  };
}

function groupSummary(rows: NormalizedCandidate[], key: keyof NormalizedCandidate, window = "all-time", hours: number | null = null, modelId = "") {
  const grouped = new Map<string, NormalizedCandidate[]>();
  for (const row of rows) grouped.set(String(row[key] || "UNKNOWN"), [...(grouped.get(String(row[key] || "UNKNOWN")) ?? []), row]);
  return [...grouped.entries()].map(([group, xs]) => {
    const anchorMs = Math.max(...xs.map((row) => Date.parse(row.resolved_at)).filter(Number.isFinite));
    const m = metric(xs, anchorMs, hours);
    return {
      group,
      model_id: modelId,
      window,
      rows: xs.length,
      N_bets: m.N_bets,
      N_fixtures: m.N_fixtures,
      fixtures: new Set(xs.map((row) => row.fixture_key)).size,
      pnl: round(m.pnl),
      roi: round(m.roi),
      maxDD: round(m.maxDD),
      winrate: m.N_bets ? round((m.wins / m.N_bets) * 100) : 0,
      avg_bets_per_fixture: m.N_fixtures ? round(m.N_bets / m.N_fixtures) : 0,
      status: "PASS",
      allowed_in_live_policy: "",
      warning: "",
    };
  }).sort((a, b) => b.rows - a.rows);
}

function windows() {
  return [
    { label: "all-time", hours: null },
    { label: "96h", hours: 96 },
    { label: "7d", hours: 24 * 7 },
  ];
}

function groupWindowRows(rows: NormalizedCandidate[], key: keyof NormalizedCandidate, modelId = "") {
  return windows().flatMap((w) => groupSummary(rows, key, w.label, w.hours, modelId));
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
  const queryExecutions: Record<string, unknown>[] = [];
  await writeJson(path.join(runDir, "sql_manifest.json"), sqlRows);

  await logger.log({ run_id: runId, step: "sql_manifest", row_count: sqlRows.length, status: "OK", warning_count: 0 });

  await logger.log({ run_id: runId, step: "dataset_fetch_start", dataset_id: "ALL_SPORTS_PUBLISHED_SIGNALS_V1", query_id: "all_sports_published_signals_v1", status: "OK" });
  const published = await runRegisteredQuery("all_sports_published_signals_v1");
  queryExecutions.push(published.execution);
  await logger.log({
    run_id: runId,
    step: "dataset_fetch_complete",
    dataset_id: "ALL_SPORTS_PUBLISHED_SIGNALS_V1",
    sql_id: published.queryId,
    query_id: published.queryId,
    source_table: published.sourceTable,
    row_count: published.rows.length,
    status: published.status,
    warning_count: published.warning ? 1 : 0,
    message: published.warning,
  });
  await logger.log({ run_id: runId, step: "dataset_fetch_start", dataset_id: "ALL_SPORTS_RESEARCH_CANDIDATES_V1", query_id: "all_sports_research_candidates_v1", status: "OK" });
  const research = await runRegisteredQuery("all_sports_research_candidates_v1");
  queryExecutions.push(research.execution);
  await logger.log({
    run_id: runId,
    step: "dataset_fetch_complete",
    dataset_id: "ALL_SPORTS_RESEARCH_CANDIDATES_V1",
    sql_id: research.queryId,
    query_id: research.queryId,
    source_table: research.sourceTable,
    row_count: research.rows.length,
    status: research.status,
    warning_count: research.warning ? 1 : 0,
    message: research.warning,
  });

  await logger.log({ run_id: runId, step: "normalize_start", dataset_id: "ALL_SPORTS_PUBLISHED_SIGNALS_V1", row_count: published.rows.length, status: "OK" });
  const normalized = normalizeCandidates(published.rows).filter((row) => row.pnl10 != null);
  await logger.log({ run_id: runId, step: "normalize_complete", dataset_id: "ALL_SPORTS_RESOLVED_CANDIDATES_V1", row_count: normalized.length, included_count: normalized.length, excluded_count: published.rows.length - normalized.length, status: "OK" });
  const anchorMs = Math.max(...normalized.map((row) => Date.parse(row.resolved_at)).filter(Number.isFinite));
  const modelSelections = new Map<string, NormalizedCandidate[]>();
  const modelComparison = registry.models.map((model, index) => {
    void index;
    void logger.log({ run_id: runId, step: "model_select_start", model_id: model.model_id, dataset_id: "ALL_SPORTS_RESOLVED_CANDIDATES_V1", status: "OK" });
    const selected = modelRows(model.model_id, normalized);
    modelSelections.set(model.model_id, selected);
    return metricRow(model, 0, selected, anchorMs);
  }).sort((a, b) => b.fire_rank_score - a.fire_rank_score || b.all_time_pnl - a.all_time_pnl);
  modelComparison.forEach((row, index) => (row.rank = index + 1));

  for (const row of modelComparison) {
    await logger.log({
      run_id: runId,
      step: "metric_compute_complete",
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
  const currentChampion = modelComparison.find((row) => row.model_id === "CHAMPION_CURRENT") ?? modelComparison[0];
  const bestAllTime = [...modelComparison].sort((a, b) => b.all_time_pnl - a.all_time_pnl)[0];
  const best96h = [...modelComparison].sort((a, b) => b["96h_pnl"] - a["96h_pnl"])[0];
  const bestRisk = [...modelComparison].sort((a, b) => (b.all_time_pnl_over_maxDD ?? -999) - (a.all_time_pnl_over_maxDD ?? -999))[0];
  const modelChangeDetector = [{
    current_champion_model_id: currentChampion?.model_id ?? "",
    best_all_time_model_id: bestAllTime?.model_id ?? "",
    best_96h_model_id: best96h?.model_id ?? "",
    best_pnl_over_maxDD_model_id: bestRisk?.model_id ?? "",
    champion_96h_roi: currentChampion?.["96h_roi"] ?? 0,
    challenger_96h_roi: best96h?.["96h_roi"] ?? 0,
    champion_all_time_roi: currentChampion?.all_time_roi ?? 0,
    challenger_all_time_roi: bestAllTime?.all_time_roi ?? 0,
    delta_96h_roi: round((best96h?.["96h_roi"] ?? 0) - (currentChampion?.["96h_roi"] ?? 0)),
    delta_all_time_roi: round((bestAllTime?.all_time_roi ?? 0) - (currentChampion?.all_time_roi ?? 0)),
    recommendation: "KEEP_CHAMPION",
    reason: "FireModel is decision support only; auto_switch_allowed=false",
    auto_switch_allowed: false,
  }];

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

  await logger.log({ run_id: runId, step: "dataset_fetch_start", dataset_id: "LIVE_CONTOUR_STATE_V1", query_id: "live_contour_state_v1", status: "OK" });
  const live = await runRegisteredQuery("live_contour_state_v1");
  queryExecutions.push(live.execution);
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

  const familyBreakdown = groupWindowRows(normalized, "market_family");
  const sportBreakdown = groupWindowRows(normalized, "sport");
  const tierBreakdown = groupWindowRows(normalized, "tier").map((row) => ({ ...row, missing_tier_count: normalized.filter((candidate) => candidate.tier === "UNKNOWN").length }));
  const sportXModel = [...modelSelections.entries()].flatMap(([modelId, rows]) => groupWindowRows(rows, "sport", modelId));
  const tierXModel = [...modelSelections.entries()].flatMap(([modelId, rows]) => groupWindowRows(rows, "tier", modelId).map((row) => ({ ...row, missing_tier_count: rows.filter((candidate) => candidate.tier === "UNKNOWN").length })));
  const familyXModel = [...modelSelections.entries()].flatMap(([modelId, rows]) => groupWindowRows(rows, "market_family", modelId));
  const familyXSport = windows().flatMap((w) => {
    const grouped = new Map<string, NormalizedCandidate[]>();
    for (const row of normalized) grouped.set(`${row.market_family}::${row.sport}`, [...(grouped.get(`${row.market_family}::${row.sport}`) ?? []), row]);
    return [...grouped.entries()].map(([key, rows]) => {
      const [market_family, sport_bucket] = key.split("::");
      const m = metric(rows, anchorMs, w.hours);
      return {
        market_family,
        sport_bucket,
        window: w.label,
        N_bets: m.N_bets,
        N_fixtures: m.N_fixtures,
        pnl: round(m.pnl),
        roi: round(m.roi),
        maxDD: round(m.maxDD),
        winrate: m.N_bets ? round((m.wins / m.N_bets) * 100) : 0,
        status: "PASS",
        allowed_in_live_policy: "NEEDS_SPORT_SPECIFIC_CONFIRMATION",
        warning: "",
      };
    });
  });
  const legacySmoke = await legacyWcSmokeTest();
  const warnings = [
    ...(legacySmoke.length ? ["LEGACY_WC_SMOKE_TEST_ONLY_NOT_FIREMODEL_BENCHMARK"] : []),
    ...legacySmoke.filter((row) => row.status !== "PASS").map((row) => `${row.anchor_id}: ${row.status}`),
    ...(live.warning ? [`live_contour: ${live.warning}`] : []),
    ...funnelHealth.filter((row) => row.warnings).map((row) => `${row.funnel_id}: ${row.warnings}`),
  ];
  const rollbackWatch = modelComparison
    .filter((row) => row.verdict === "ROLLBACK_WATCH")
    .map((row) => ({ model_id: row.model_id, rollback_note: row.rollback_note, all_time_roi: row.all_time_roi, "96h_roi": row["96h_roi"] }));

  const csvFiles = [
    ["model_comparison.csv", modelComparison, Object.keys(modelComparison[0] ?? {})],
    ["model_change_detector.csv", modelChangeDetector, Object.keys(modelChangeDetector[0] ?? {})],
    ["funnel_health.csv", funnelHealth, Object.keys(funnelHealth[0] ?? {})],
    ["denominator_check.csv", denominator, Object.keys(denominator[0] ?? {})],
    ["market_family_breakdown.csv", familyBreakdown, Object.keys(familyBreakdown[0] ?? {})],
    ["family_x_model.csv", familyXModel, Object.keys(familyXModel[0] ?? {})],
    ["family_x_sport.csv", familyXSport, Object.keys(familyXSport[0] ?? {})],
    ["tier_breakdown.csv", tierBreakdown, Object.keys(tierBreakdown[0] ?? {})],
    ["tier_x_model.csv", tierXModel, Object.keys(tierXModel[0] ?? {})],
    ["sport_breakdown.csv", sportBreakdown, Object.keys(sportBreakdown[0] ?? {})],
    ["sport_x_model.csv", sportXModel, Object.keys(sportXModel[0] ?? {})],
    ["live_contour_snapshot.csv", liveContour, Object.keys(liveContour[0] ?? {})],
    ["rollback_watch.csv", rollbackWatch, Object.keys(rollbackWatch[0] ?? { model_id: "", rollback_note: "" })],
  ] as Array<[string, Record<string, unknown>[], string[]]>;
  for (const [name, rows, headers] of csvFiles) await writeFile(path.join(runDir, name), toCsv(rows, headers), "utf8");

  const runLogSummary = [
    { step: "registered_queries", count: queryExecutions.length, status: "PASS" },
    { step: "models", count: modelComparison.length, status: modelComparison.length >= 4 ? "PASS" : "FAIL" },
    { step: "primary_scope", count: 1, status: "ALL_SPORTS" },
    { step: "legacy_wc_smoke_test", count: legacySmoke.length, status: "DIAGNOSTIC_ONLY_NOT_BENCHMARK" },
  ];
  const dataQuality = [{
    missing_score_count: normalized.filter((row) => row.score == null).length,
    missing_tier_count: normalized.filter((row) => row.tier === "UNKNOWN").length,
    missing_market_family_count: normalized.filter((row) => !row.market_family || row.market_family === "UNKNOWN").length,
    missing_entry_price_count: normalizeCandidates(published.rows).filter((row) => row.entry_price == null).length,
    missing_result_count: normalizeCandidates(published.rows).filter((row) => row.result === "unknown").length,
    missing_condition_id_count: published.rows.filter((row) => !row.condition_id).length,
    missing_token_id_count: published.rows.filter((row) => !row.selected_token_id).length,
    unresolved_count: published.rows.filter((row) => !row.signal_result).length,
    duplicate_key_count: published.rows.length - new Set(published.rows.filter((row) => row.condition_id && row.selected_token_id).map((row) => `${row.condition_id}::${row.selected_token_id}`)).size,
    adapter_mode_warning: "SUPABASE_REST_REGISTERED_QUERY; direct SQL unavailable in runtime",
    row_exclusion_counts: JSON.stringify({
      missing_pnl_or_price_or_result: published.rows.length - normalized.length,
      missing_condition_or_token: published.rows.filter((row) => !row.condition_id || !row.selected_token_id).length,
    }),
  }];
  const sourceTables = [
    {
      table: "generated_signal_pairs",
      role: "SIGNAL_CACHE",
      exact_count: null,
      pulled_rows: published.rows.length,
      min_created_at: published.rows.map((row) => row.created_at).filter(Boolean).sort()[0] ?? "",
      max_created_at: published.rows.map((row) => row.created_at).filter(Boolean).sort().at(-1) ?? "",
      distinct_condition_id: publishedConditions,
      distinct_token_id: new Set(published.rows.map((row) => row.selected_token_id).filter(Boolean)).size,
      warning: "",
    },
    {
      table: "generated_signal_research_snapshots",
      role: "RESEARCH_UNIVERSE",
      exact_count: null,
      pulled_rows: research.rows.length,
      min_created_at: research.rows.map((row) => row.created_at).filter(Boolean).sort()[0] ?? "",
      max_created_at: research.rows.map((row) => row.created_at).filter(Boolean).sort().at(-1) ?? "",
      distinct_condition_id: researchConditions,
      distinct_token_id: new Set(research.rows.map((row) => row.selected_token_id || row.token_id || row.outcome_token_id).filter(Boolean)).size,
      warning: "",
    },
  ];

  const workbookPath = path.join(runDir, `polypropicks_fire_model_report_${dateKey()}.xlsx`);
  await logger.log({ run_id: runId, step: "workbook_write", row_count: modelComparison.length, status: "OK", warning_count: warnings.length });
  await writeFireWorkbook(workbookPath, {
    "Executive Summary": [{
      run_id: runId,
      status: warnings.length ? "PASS_WITH_WARNINGS" : "PASS",
      primary_scope: "ALL_SPORTS",
      benchmark_policy: "MODEL_REGISTRY_ALL_SPORTS",
      legacy_wc_smoke_test: "DIAGNOSTIC_ONLY_NOT_BENCHMARK",
      public_product_formula: "FROZEN_DO_NOT_MODIFY",
      current_champion: currentChampion?.model_id ?? "",
      best_96h_model: [...modelComparison].sort((a, b) => b["96h_roi"] - a["96h_roi"])[0]?.model_id ?? "",
      fire_run_folder: runDir,
      invoked_by: invokedBy,
    }],
    "Model Comparison": modelComparison,
    "Model Change Detector": modelChangeDetector,
    "Funnel Health": funnelHealth,
    "Live Contour": liveContour,
    "Denominator Check": denominator,
    "Sport Breakdown": sportBreakdown,
    "Sport x Model": sportXModel,
    "Tier Breakdown": tierBreakdown,
    "Tier x Model": tierXModel,
    "Market Family Breakdown": familyBreakdown,
    "Family x Model": familyXModel,
    "Family x Sport": familyXSport,
    "SQL Manifest": sqlRows as unknown as Record<string, unknown>[],
    "Run Log Summary": runLogSummary,
    "Legacy WC Smoke Test": legacySmoke as unknown as Record<string, unknown>[],
    "Warnings": warnings.length ? warnings.map((warning) => ({ warning })) : [{ warning: "NONE" }],
  });

  await logger.log({ run_id: runId, step: "manifest_write", row_count: queryExecutions.length, status: "OK", warning_count: warnings.length });
  await writeJson(path.join(runDir, "query_execution_manifest.json"), queryExecutions);
  await writeJson(path.join(runDir, "command_manifest.json"), {
    npm_script_invoked: verify ? "fire:model:verify" : "fire:model:report",
    invoked_by: invokedBy,
    node_version: process.version,
    git_commit: safeExec("git rev-parse HEAD"),
    git_branch: safeExec("git branch --show-current"),
    package_name: "sipropicks-premvp1-1",
    package_version: "0.1.0",
    env: {
      SUPABASE_URL_present: Boolean(process.env.SUPABASE_URL),
      NEXT_PUBLIC_SUPABASE_URL_present: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY_present: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      DATABASE_URL_present: Boolean(process.env.DATABASE_URL),
    },
  });
  await writeJson(path.join(runDir, "source_tables_manifest.json"), sourceTables);
  await writeJson(path.join(runDir, "data_quality_manifest.json"), dataQuality[0]);
  await writeJson(path.join(runDir, "dataset_manifest.json"), { datasets: registry.datasets, denominator });
  await writeJson(path.join(runDir, "model_manifest.json"), { models: registry.models, modelComparison });
  await writeJson(path.join(runDir, "funnel_manifest.json"), { funnels: registry.funnels, funnelHealth });
  await writeJson(path.join(runDir, "run_manifest.json"), {
    run_id: runId,
    status: warnings.length ? "PASS_WITH_WARNINGS" : "PASS",
    primary_scope: "ALL_SPORTS",
    firemodel_doctrine_version: "all_sports_v2",
    legacy_wc_smoke_test_status: legacySmoke.every((row) => row.status === "PASS") ? "PASS" : "PASS_WITH_WARNINGS",
    legacy_wc_smoke_test_is_benchmark: false,
    public_product_formula: "FROZEN_DO_NOT_MODIFY",
    query_policy: "REGISTERED_ONLY",
    invoked_by: invokedBy,
    generated_at: new Date().toISOString(),
    run_dir: runDir,
    workbook_path: workbookPath,
    adapter_mode: "SUPABASE_REST_REGISTERED_QUERY",
    model_count: modelComparison.length,
    current_champion: currentChampion?.model_id ?? "",
    best_96h_model: best96h?.model_id ?? "",
    live_contour_status: liveContour[0]?.status ?? "UNKNOWN",
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
      `Primary scope: ALL_SPORTS`,
      `Benchmark policy: MODEL_REGISTRY_ALL_SPORTS`,
      `Legacy WC smoke test: DIAGNOSTIC_ONLY_NOT_BENCHMARK`,
      `Fire rank score formula: positive all-time/96h PnL, pnl/maxDD, sample adequacy, penalties for missing tier coverage and negative 96h ROI.`,
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
    "query_execution_manifest.json",
    "command_manifest.json",
    "dataset_manifest.json",
    "model_manifest.json",
    "funnel_manifest.json",
    "source_tables_manifest.json",
    "data_quality_manifest.json",
    "model_comparison.csv",
    "model_change_detector.csv",
    "funnel_health.csv",
    "denominator_check.csv",
    "market_family_breakdown.csv",
    "family_x_model.csv",
    "family_x_sport.csv",
    "tier_breakdown.csv",
    "tier_x_model.csv",
    "sport_breakdown.csv",
    "sport_x_model.csv",
    "live_contour_snapshot.csv",
    "rollback_watch.csv",
    "warnings.md",
    "audit_summary.md",
  ];
  const missing = required.filter((file) => !existsSync(path.join(runDir, file)));
  if (missing.length) throw new Error(`FIREMODEL_VERIFY_FAIL missing=${missing.join(",")}`);
  if (modelComparison.length < 4) throw new Error(`FIREMODEL_VERIFY_FAIL model_count=${modelComparison.length}`);
  if ((await fileSize(workbookPath)) <= 0) throw new Error("FIREMODEL_VERIFY_FAIL empty workbook");
  await logger.log({ run_id: runId, step: "verification", row_count: modelComparison.length, status: "OK", warning_count: warnings.length });

  const result = {
    code: verify ? "FIREMODEL_VERIFY_PASS" : "FIREMODEL_REPORT_PASS",
    run_id: runId,
    status: warnings.length ? "PASS_WITH_WARNINGS" : "PASS",
    runDir,
    workbookPath,
    modelComparisonRows: modelComparison.length,
    primaryScope: "ALL_SPORTS",
    currentChampion: currentChampion?.model_id ?? "",
    best96hModel: best96h?.model_id ?? "",
    liveContourIncluded: true,
    warnings,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
