// Phase B2a — Signal outcome resolver script
// Default: dry-run (no DB writes). Pass --write to commit updates.
// Usage:
//   npm run resolve:signals               # dry-run
//   npm run resolve:signals -- --write    # write mode

import { loadEnvConfig } from "@next/env";
import {
  fetchGammaMarketByConditionId,
  resolveSignalOutcome,
} from "../lib/feed/resolveSignalOutcome";

// ---- Config ----------------------------------------------------------------

const WRITE_MODE = process.argv.includes("--write");

const rawLimit = (() => {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) return 25;
  const n = parseInt(arg.split("=")[1], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : 25;
})();

// In write mode, default maxUpdates = 1 to prevent accidental bulk writes.
// In dry-run mode, this value is logged but has no effect.
const maxUpdates = (() => {
  const arg = process.argv.find((a) => a.startsWith("--max-updates="));
  if (!arg) return WRITE_MODE ? 1 : Infinity;
  const n = parseInt(arg.split("=")[1], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : WRITE_MODE ? 1 : Infinity;
})();

// ---- Main ------------------------------------------------------------------

async function main() {
  // Load .env.local before any module that reads process.env at import time
  loadEnvConfig(process.cwd());

  const { supabaseAdmin } = await import("../lib/supabase/server");
  const supabase = supabaseAdmin;

  const startedAt = new Date().toISOString();
  const mode = WRITE_MODE ? "write" : "dry-run";

  const maxUpdatesLabel = WRITE_MODE ? String(maxUpdates) : "n/a";
  console.log(`[resolve-signals] === START mode=${mode} limit=${rawLimit} maxUpdates=${maxUpdatesLabel} ===`);

  // Select unresolved rows with required snapshot fields
  const { data: rows, error: selectError } = await supabase
    .from("generated_signal_pairs")
    .select(
      "id, created_at, event_slug, condition_id, selected_outcome, selected_token_id, entry_price_num"
    )
    .is("signal_result", null)
    .not("condition_id", "is", null)
    .not("selected_token_id", "is", null)
    .not("entry_price_num", "is", null)
    .order("created_at", { ascending: true })
    .limit(rawLimit);

  if (selectError) {
    console.error("[resolve-signals] DB select failed:", selectError.message);
    process.exit(1);
  }

  const selectedCount = rows?.length ?? 0;
  console.log(`[resolve-signals] Selected ${selectedCount} unresolved rows`);

  if (selectedCount === 0) {
    console.log("[resolve-signals] Nothing to process. Done.");
    return;
  }

  // Per-row counters
  const stateCounts: Record<string, number> = {};
  const resultCounts: Record<string, number> = {};
  let updatedCount = 0;
  let skippedCount = 0;

  for (const row of rows!) {
    const conditionId = row.condition_id as string;
    const selectedTokenId = row.selected_token_id as string | null;
    const entryPriceNum = row.entry_price_num as number | null;

    const market = await fetchGammaMarketByConditionId(conditionId);
    const outcome = resolveSignalOutcome({
      conditionId,
      selectedTokenId,
      entryPriceNum,
      market,
    });

    stateCounts[outcome.resolverState] =
      (stateCounts[outcome.resolverState] ?? 0) + 1;

    const resultKey = outcome.signalResult ?? "null";
    resultCounts[resultKey] = (resultCounts[resultKey] ?? 0) + 1;

    const rowLabel = `[${row.id}] ${row.event_slug ?? conditionId}`;

    if (outcome.resolverState !== "resolved_candidate") {
      console.log(
        `  SKIP ${rowLabel} state=${outcome.resolverState} reason=${outcome.skipReason}`
      );
      skippedCount++;
      continue;
    }

    // resolved_candidate — log what would be / was written
    console.log(
      `  ${WRITE_MODE ? "WRITE" : "WOULD"} ${rowLabel}` +
        ` result=${outcome.signalResult}` +
        ` return=${outcome.realizedReturnPct}%` +
        ` winner=${outcome.candidateWinningOutcome}`
    );

    if (!WRITE_MODE) {
      skippedCount++;
      continue;
    }

    // Write mode: enforce max-updates guard before each write
    if (updatedCount >= maxUpdates) {
      console.log(
        `[resolve-signals] Max updates reached (${maxUpdates}) — stopping write updates`
      );
      skippedCount++;
      break;
    }

    // Write mode: update with idempotency guard
    const resolvedAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("generated_signal_pairs")
      .update({
        signal_result: outcome.signalResult,
        resolved_at: resolvedAt,
        winning_outcome: outcome.candidateWinningOutcome,
        realized_return_pct: outcome.realizedReturnPct,
      })
      .eq("id", row.id as string)
      .is("signal_result", null); // idempotency guard — never overwrite already-resolved rows

    if (updateError) {
      console.error(
        `  ERROR ${rowLabel} update failed: ${updateError.message}`
      );
      skippedCount++;
    } else {
      updatedCount++;
    }
  }

  // Summary
  const finishedAt = new Date().toISOString();
  const durationMs =
    new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  console.log(`[resolve-signals] === SUMMARY ===`);
  console.log(`  mode:          ${mode}`);
  console.log(`  selected:      ${selectedCount}`);
  console.log(`  updated:       ${updatedCount}`);
  console.log(`  skipped:       ${skippedCount}`);
  console.log(`  duration_ms:   ${durationMs}`);
  console.log(`  by_state:      ${JSON.stringify(stateCounts)}`);
  console.log(`  by_result:     ${JSON.stringify(resultCounts)}`);

  if (WRITE_MODE && updatedCount === 0 && selectedCount > 0) {
    console.log(
      `[resolve-signals] No rows updated — all were active, unknown, or already resolved.`
    );
  }
}

main().catch((err) => {
  console.error("[resolve-signals] Fatal error:", err);
  process.exit(1);
});
