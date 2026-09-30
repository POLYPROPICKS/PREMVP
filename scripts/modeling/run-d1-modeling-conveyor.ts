/**
 * AUTOMATED_D1_MODELING_CONVEYOR_V1 — one deterministic orchestrator for the
 * nightly research-clone job (runs after research-clone:model-ready-direct).
 *
 *   npm run research-clone:modeling-conveyor                      # normal nightly D-1 mode
 *   npm run research-clone:modeling-conveyor -- --bootstrap-through=2026-09-29   # explicit one-time bootstrap
 *
 * Normal mode never bootstraps: it scores only MODEL_READY days that have no
 * research_strategy_daily row yet, reconciles OPEN selected bets, refreshes
 * rollups/dashboard runtime and fails (non-zero) when modeling is stale.
 */
import { pathToFileURL } from "node:url";

import { connectConveyorClone, createDbDeps } from "./d1-modeling-conveyor-db";
import { parseConveyorArgs, runConveyor } from "./d1-modeling-conveyor-core";

async function main() {
  const opts = parseConveyorArgs(process.argv.slice(2));
  const t0 = Date.now();
  const res = await runConveyor(createDbDeps(connectConveyorClone()), opts);
  console.log(JSON.stringify({ STATUS: "SUCCESS", ...res, TOTAL_SECONDS: Math.round((Date.now() - t0) / 100) / 10, PRODUCTION_MUTATION_N: 0 }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
