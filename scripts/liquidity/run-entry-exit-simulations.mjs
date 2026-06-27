#!/usr/bin/env node
/**
 * LIQUIDITY_MODEL — build entry/exit executable-return simulations.
 *
 * Reads snapshots from the last 24h, simulates a $stake YES round-trip per
 * token (enter at best ask, exit into bids at 5/10/15% slippage), and inserts
 * up to LIQUIDITY_SIMULATION_LIMIT simulation rows. Read-only; no orders.
 *
 * Run via tsx: npm run liquidity:simulate
 */
import { pathToFileURL } from "node:url";
// Dynamic import (see build-watchlist.mjs) for TS named exports under tsx.
const { SupabaseLiquidityRepo } = await import("../../lib/liquidity/supabaseLiquidityRepo.ts");
const { buildEntryExitSimulation, selectEntryExitPairs, summarizeSimulationFlags } = await import(
  "../../lib/liquidity/simulation.ts"
);

function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function windowStartIso(hours = 24) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

export async function runEntryExitSimulations() {
  const simulationLimit = envInt("LIQUIDITY_SIMULATION_LIMIT", 5000);
  const stakeUsd = envInt("LIQUIDITY_SIMULATION_STAKE_USD", 10);

  const repo = new SupabaseLiquidityRepo();
  const snapshots = await repo.getSnapshotsForSimulation(windowStartIso());

  if (snapshots.status === "DB_ENV_MISSING" || snapshots.status === "SCHEMA_MISSING") {
    log(
      `LIQUIDITY_SIMULATION_SUMMARY verdict=${snapshots.status} tokens=0 simulations=0 executable_5pct=0 executable_10pct=0 executable_15pct=0`,
    );
    return { status: snapshots.status, simulations: 0 };
  }

  const pairs = selectEntryExitPairs(snapshots.data, simulationLimit);
  const simulationRunId = globalThis.crypto.randomUUID();
  const rows = pairs.map((pair) =>
    buildEntryExitSimulation(pair, simulationRunId, stakeUsd),
  );

  const insert = await repo.insertSimulationRows(rows);
  const flags = summarizeSimulationFlags(rows);
  const verdict = insert.status === "OK" ? "OK_CAPTURING" : insert.status;

  log(
    `LIQUIDITY_SIMULATION_SUMMARY verdict=${verdict} tokens=${flags.tokens} simulations=${flags.simulations} executable_5pct=${flags.executable5pct} executable_10pct=${flags.executable10pct} executable_15pct=${flags.executable15pct}`,
  );
  return { status: verdict, simulations: flags.simulations };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEntryExitSimulations().catch((err) => {
    log(`LIQUIDITY_SIMULATION_ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
