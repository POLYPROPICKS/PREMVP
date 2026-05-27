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
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : 25;
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
  // Dynamic import keeps loadEnvConfig ordering: env must be loaded before any
  // module that reads process.env at initialisation time (supabaseAdmin).
  const { writeJobRun } = await import("../lib/feed/cacheGeneratedSignals");
  const supabase = supabaseAdmin;

  const startedAt = new Date().toISOString();

  // ── job_runs helper (write-mode only) ────────────────────────────────────
  // source="resolver" distinguishes these rows from cache-cron source="polymarket".
  // formula_version="resolver-v1" is a stable constant (resolver has no formula).
  // generatedCount maps to updatedCount; rejectedCount maps to skippedCount.
  async function tryWriteResolverJobRun(opts: {
    status: "success" | "empty" | "error";
    updatedCount?: number;
    skippedCount?: number;
    finishedAt: string;
    errorMessage?: string;
    extra?: Record<string, unknown>;
  }) {
    const dur =
      new Date(opts.finishedAt).getTime() - new Date(startedAt).getTime();
    try {
      await writeJobRun({
        source: "resolver",
        formulaVersion: "resolver-v1",
        startedAt,
        finishedAt: opts.finishedAt,
        status: opts.status,
        generatedCount: opts.updatedCount ?? 0,
        rejectedCount: opts.skippedCount ?? 0,
        durationMs: dur,
        errorMessage: opts.errorMessage,
        diagnostics: {
          writeMode: true,
          limit: rawLimit,
          maxUpdates,
          ...(opts.extra ?? {}),
        },
      });
      console.log(
        `[resolve-signals] Job run recorded (${opts.status}, updated=${opts.updatedCount ?? 0})`,
      );
    } catch (e) {
      console.error(
        "[resolve-signals] Failed to write job run:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

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
    .not("metric_formula_version", "is", null)
    .order("created_at", { ascending: false })
    .limit(rawLimit);

  if (selectError) {
    console.error("[resolve-signals] DB select failed:", selectError.message);
    if (WRITE_MODE) {
      await tryWriteResolverJobRun({
        status: "error",
        finishedAt: new Date().toISOString(),
        errorMessage: selectError.message,
        extra: { phase: "db-select" },
      });
    }
    process.exit(1);
  }

  const selectedCount = rows?.length ?? 0;
  console.log(`[resolve-signals] Selected ${selectedCount} unresolved rows`);

  if (selectedCount === 0) {
    console.log("[resolve-signals] Nothing to process. Done.");
    if (WRITE_MODE) {
      await tryWriteResolverJobRun({
        status: "empty",
        finishedAt: new Date().toISOString(),
        extra: { selected: 0 },
      });
    }
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

    // resolved_candidate — dry-run: log and continue
    if (!WRITE_MODE) {
      console.log(
        `  WOULD ${rowLabel}` +
          ` result=${outcome.signalResult}` +
          ` return=${outcome.realizedReturnPct}%` +
          ` winner=${outcome.candidateWinningOutcome}`
      );
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

    // Write mode: update with idempotency guard — select("id") to confirm actual rows affected
    const resolvedAt = new Date().toISOString();
    const { data: updatedRows, error: updateError } = await supabase
      .from("generated_signal_pairs")
      .update({
        signal_result: outcome.signalResult,
        resolved_at: resolvedAt,
        winning_outcome: outcome.candidateWinningOutcome,
        realized_return_pct: outcome.realizedReturnPct,
      })
      .eq("id", row.id as string)
      .is("signal_result", null) // idempotency guard — never overwrite already-resolved rows
      .select("id");

    if (updateError) {
      console.error(
        `  ERROR ${rowLabel} update failed: ${updateError.message}`
      );
      skippedCount++;
    } else {
      const affectedRows = updatedRows?.length ?? 0;
      if (affectedRows > 0) {
        updatedCount++;
        console.log(
          `  WRITE ${rowLabel}` +
            ` result=${outcome.signalResult}` +
            ` return=${outcome.realizedReturnPct}%` +
            ` winner=${outcome.candidateWinningOutcome}`
        );
      } else {
        console.log(
          `  NOOP  ${rowLabel} reason=Already resolved or update matched 0 rows`
        );
        skippedCount++;
      }
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

  // ── Write job_runs (write-mode only) ─────────────────────────────────────
  if (WRITE_MODE) {
    await tryWriteResolverJobRun({
      status: "success",
      updatedCount,
      skippedCount,
      finishedAt,
      extra: {
        selected: selectedCount,
        updated: updatedCount,
        skipped: skippedCount,
        by_state: stateCounts,
        by_result: resultCounts,
      },
    });
  } else {
    console.log(
      "[resolve-signals] Dry-run mode — job_runs not written.",
    );
  }
}

main().catch(async (err) => {
  console.error("[resolve-signals] Fatal error:", err);
  // Best-effort job_runs write on fatal throw (write-mode only)
  if (WRITE_MODE) {
    try {
      const { writeJobRun: wjr } = await import(
        "../lib/feed/cacheGeneratedSignals"
      );
      const tFatal = new Date().toISOString();
      await wjr({
        source: "resolver",
        formulaVersion: "resolver-v1",
        startedAt: tFatal, // startedAt inaccessible here — use current time as sentinel
        finishedAt: tFatal,
        status: "error",
        generatedCount: 0,
        rejectedCount: 0,
        durationMs: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        diagnostics: { writeMode: true, fatal: true },
      });
    } catch {
      // non-fatal: never let job_runs failure mask the real error
    }
  }
  process.exit(1);
});
