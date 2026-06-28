#!/usr/bin/env node
/**
 * LIQUIDITY_MODEL — canonical 24h liquidity funnel log generator.
 *
 * Reads 24h funnel inputs from Supabase when available, aggregates the funnel,
 * computes the machine verdict, and writes both `*_latest` and timestamped
 * markdown + JSON reports under reports/liquidity_pool/. Always writes a report
 * even when the DB is unavailable (verdict = DB_ENV_MISSING / SCHEMA_MISSING).
 * Read-only; no secrets printed.
 *
 * Run via tsx: npm run liquidity:funnel-log
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Dynamic import (see build-watchlist.mjs) for TS named exports under tsx.
const { SupabaseLiquidityRepo } = await import("../../lib/liquidity/supabaseLiquidityRepo.ts");
const {
  summarizeLiquidityFunnel24h,
  computeMachineVerdict,
  renderLiquidityFunnelMarkdown,
  renderLiquidityFunnelJson,
} = await import("../../lib/liquidity/funnelSummary.ts");

function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

const REPORT_DIR = path.join(process.cwd(), "reports", "liquidity_pool");

function fileTimestamp(iso) {
  return iso.replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

export async function runFunnelLog() {
  const minVolumeUsd = envInt("LIQUIDITY_MIN_MARKET_VOLUME_USD", 10000);
  const generatedAt = new Date().toISOString();
  const windowEndIso = generatedAt;
  const windowStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const repo = new SupabaseLiquidityRepo();
  const inputsResult = await repo.getFunnelInputs24h(windowStart);

  let dbStatus = "OK";
  if (inputsResult.status === "DB_ENV_MISSING") dbStatus = "DB_ENV_MISSING";
  else if (inputsResult.status === "SCHEMA_MISSING") dbStatus = "SCHEMA_MISSING";

  const data = inputsResult.data;
  const summary = summarizeLiquidityFunnel24h({
    windowStartIso: windowStart,
    windowEndIso,
    dbStatus,
    sourceRows: data.sourceRows ?? [],
    watchlistRows: data.watchlistRows ?? [],
    snapshotRows: data.snapshotRows ?? [],
    simulationRows: data.simulationRows ?? [],
    minVolumeUsd,
  });

  const verdict = computeMachineVerdict(summary);
  const markdown = renderLiquidityFunnelMarkdown(summary, verdict, generatedAt);
  const json = renderLiquidityFunnelJson(summary, verdict, generatedAt);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const ts = fileTimestamp(generatedAt);
  const writes = [
    ["liquidity_funnel_latest.md", markdown],
    ["liquidity_funnel_latest.json", JSON.stringify(json, null, 2)],
    [`liquidity_funnel_${ts}.md`, markdown],
    [`liquidity_funnel_${ts}.json`, JSON.stringify(json, null, 2)],
  ];
  for (const [name, content] of writes) {
    fs.writeFileSync(path.join(REPORT_DIR, name), content, "utf8");
  }

  // Canonical one-line machine summary.
  log(
    `LIQUIDITY_POOL_FUNNEL_SUMMARY verdict=${verdict} source_rows=${summary.sourceRows} sports=${summary.sportsCovered} volume_checked=${summary.volumeChecked} volume_pass=${summary.volumePass} volume_rejected=${summary.volumeRejected} active_tokens=${summary.activeWatchlistTokens} book_attempts=${summary.bookAttempts} snapshots_written=${summary.snapshotsWritten} simulations=${summary.simulations} executable_5pct=${summary.executable5pct} executable_10pct=${summary.executable10pct} executable_15pct=${summary.executable15pct} failures=${summary.failures}`,
  );
  // Additive detail so the baseline-vs-real and source-volume state are explicit.
  log(
    `LIQUIDITY_POOL_FUNNEL_DETAIL entry_exit_simulations=${summary.entryExitSimulations} baseline_simulations=${summary.baselineSimulations} source_volume=${summary.sourceVolumeDeferred ? "deferred" : "present"} real_entry_exit=${summary.entryExitSimulations > 0 ? "yes" : "pending_history"}`,
  );
  // Honest market-level volume disposition (no fake pass; event-level != pass).
  const vd = summary.volumeDisposition;
  log(
    `LIQUIDITY_VOLUME_GATE_SUMMARY market_volume_checked=${vd.marketVolumeChecked} market_volume_pass=${vd.marketVolumePass} event_volume_only=${vd.eventVolumeOnly} volume_deferred=${vd.volumeDeferred} volume_missing=${vd.volumeMissing} volume_rejected=${vd.volumeRejected}`,
  );

  // Per-sport gate lines.
  for (const sport of Object.keys(summary.sourceRowsBySport).sort()) {
    const fam = summary.marketFamilyGateBySport[sport] ?? {
      supported: 0,
    };
    const vol = summary.volumeGateBySport[sport] ?? { checked: 0, pass: 0 };
    log(
      `LIQUIDITY_SPORT_GATE_SUMMARY sport=${sport} source_rows=${summary.sourceRowsBySport[sport] ?? 0} candidates=${summary.candidateRowsBySport[sport] ?? 0} family_supported=${fam.supported ?? 0} volume_checked=${vol.checked ?? 0} volume_pass=${vol.pass ?? 0} active=${summary.activeWatchlistBySport[sport] ?? 0}`,
    );
  }

  // Per-(sport,family) gate lines.
  for (const key of Object.keys(summary.sourceRowsBySportFamily).sort()) {
    const [sport, family] = key.split("::");
    const vol = summary.volumeGateBySportFamily[key] ?? { checked: 0, pass: 0 };
    const sim = summary.simulationSummaryBySportFamily[key] ?? { simulations: 0, executable5pct: 0 };
    log(
      `LIQUIDITY_MARKET_FAMILY_GATE_SUMMARY sport=${sport} family=${family} source_rows=${summary.sourceRowsBySportFamily[key] ?? 0} volume_checked=${vol.checked ?? 0} volume_pass=${vol.pass ?? 0} active=${summary.activeWatchlistBySportFamily[key] ?? 0} snapshots=${summary.snapshotSuccessBySportFamily[key] ?? 0} simulations=${sim.simulations ?? 0} executable_5pct=${sim.executable5pct ?? 0}`,
    );
  }

  return { verdict, reportDir: REPORT_DIR };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFunnelLog().catch((err) => {
    log(`LIQUIDITY_POOL_FUNNEL_ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
