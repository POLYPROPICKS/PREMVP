#!/usr/bin/env node
/**
 * LIQUIDITY_MODEL — orchestrate the full read-only liquidity pool MVP:
 *   build-watchlist → capture-snapshots → simulate → funnel-log
 *
 * Fail-open: each stage's DB_ENV_MISSING / SCHEMA_MISSING is a machine state,
 * not a crash. Exits non-zero only for unrecoverable local runtime errors.
 * No trading auth, no order placement, no secrets printed.
 *
 * Run via tsx: npm run liquidity:mvp
 */
import { runBuildWatchlist } from "./build-watchlist.mjs";
import { runCaptureSnapshots } from "./capture-snapshots.mjs";
import { runEntryExitSimulations } from "./run-entry-exit-simulations.mjs";
import { runFunnelLog } from "./liquidity-funnel-log.mjs";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function runStage(name, fn) {
  try {
    const result = await fn();
    return { name, ok: true, result };
  } catch (err) {
    // Stage-level failures are logged but do not abort the pipeline; the funnel
    // log is the canonical record of what happened.
    log(`LIQUIDITY_MVP_STAGE_ERROR stage=${name} error=${err instanceof Error ? err.message : String(err)}`);
    return { name, ok: false, error: err };
  }
}

export async function runLiquidityPoolMvp() {
  log("LIQUIDITY_MVP_START");
  await runStage("build-watchlist", runBuildWatchlist);
  await runStage("capture-snapshots", runCaptureSnapshots);
  await runStage("simulate", runEntryExitSimulations);
  const funnel = await runStage("funnel-log", runFunnelLog);

  const verdict = funnel.ok && funnel.result ? funnel.result.verdict : "DEGRADED_NO_SNAPSHOTS";
  log(`LIQUIDITY_MVP_DONE verdict=${verdict}`);
  return { verdict };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLiquidityPoolMvp().catch((err) => {
    log(`LIQUIDITY_MVP_FATAL ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
