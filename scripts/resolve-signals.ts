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
const ONLY_EXPIRED = process.argv.includes("--only-expired");
const DEDUPE_STRICT = process.argv.includes("--dedupe-strict");

type ResolverOrderMode = "newest" | "oldest";

type ResolverRow = {
  id: string;
  created_at: string | null;
  expires_at: string | null;
  event_slug: string | null;
  condition_id: string;
  selected_outcome: string | null;
  selected_token_id: string | null;
  entry_price_num: number | null;
};

const orderMode: ResolverOrderMode = (() => {
  const arg = process.argv.find((a) => a.startsWith("--order="));
  if (!arg) return "newest";
  const value = arg.split("=")[1];
  if (value === "oldest" || value === "newest") return value;
  console.error(
    `[resolve-signals] Invalid --order=${value}. Expected --order=oldest or --order=newest.`,
  );
  process.exit(1);
})();

function strictKey(row: Pick<ResolverRow, "condition_id" | "selected_token_id">): string {
  return `${row.condition_id}::${row.selected_token_id ?? ""}`;
}

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
  const expiredCutoff = new Date().toISOString();

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
          orderMode,
          onlyExpired: ONLY_EXPIRED,
          dedupeStrict: DEDUPE_STRICT,
          expiredCutoff: ONLY_EXPIRED ? expiredCutoff : null,
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
  console.log(
    `[resolve-signals] === START mode=${mode} limit=${rawLimit} maxUpdates=${maxUpdatesLabel}` +
      ` order=${orderMode} onlyExpired=${ONLY_EXPIRED} dedupeStrict=${DEDUPE_STRICT}` +
      `${ONLY_EXPIRED ? ` expiredCutoff=${expiredCutoff}` : ""} ===`,
  );

  // Select unresolved rows with required snapshot fields
  let query = supabase
    .from("generated_signal_pairs")
    .select(
      "id, created_at, expires_at, event_slug, condition_id, selected_outcome, selected_token_id, entry_price_num"
    )
    .is("signal_result", null)
    .not("condition_id", "is", null)
    .not("selected_token_id", "is", null)
    .not("entry_price_num", "is", null)
    .not("metric_formula_version", "is", null);

  if (ONLY_EXPIRED) {
    query = query.lt("expires_at", expiredCutoff);
  }

  if (orderMode === "oldest") {
    query = query
      .order("expires_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
  } else {
    query = query.order("created_at", { ascending: false });
  }

  const { data: rows, error: selectError } = await query.limit(rawLimit);

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

  const selectedRows = ((rows ?? []) as unknown) as ResolverRow[];
  const selectedCount = selectedRows.length;
  const strictRows = DEDUPE_STRICT
    ? Array.from(
        selectedRows
          .reduce<Map<string, ResolverRow>>((acc, row) => {
            const key = strictKey(row);
            if (!acc.has(key)) acc.set(key, row);
            return acc;
          }, new Map())
          .values(),
      )
    : selectedRows;
  const strictSelectedCount = strictRows.length;
  const duplicateRowsSkippedByStrictDedupe = selectedCount - strictSelectedCount;

  console.log(`[resolve-signals] Selected ${selectedCount} unresolved rows`);
  if (DEDUPE_STRICT) {
    console.log(
      `[resolve-signals] Strict dedupe selected ${strictSelectedCount} strict tokens` +
        ` (skipped ${duplicateRowsSkippedByStrictDedupe} duplicate raw rows)`,
    );
  }

  if (selectedCount === 0) {
    console.log("[resolve-signals] Nothing to process. Done.");
    if (WRITE_MODE) {
      await tryWriteResolverJobRun({
        status: "empty",
        finishedAt: new Date().toISOString(),
        extra: {
          selected: 0,
          rawSelected: 0,
          strictSelected: 0,
          duplicateRowsSkippedByStrictDedupe: 0,
          rowsUpdatedTotal: 0,
          strictTokensUpdated: 0,
          dedupeStrict: DEDUPE_STRICT,
        },
      });
    }
    return;
  }

  // Per-row counters
  const stateCounts: Record<string, number> = {};
  const resultCounts: Record<string, number> = {};
  let rowsUpdatedTotal = 0;
  let strictTokensUpdated = 0;
  let skippedCount = 0;

  for (const row of strictRows) {
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
    if (strictTokensUpdated >= maxUpdates) {
      console.log(
        `[resolve-signals] Max updates reached (${maxUpdates}) — stopping write updates`
      );
      skippedCount++;
      break;
    }

    // Write mode: update with idempotency guard — select("id") to confirm actual rows affected
    const resolvedAt = new Date().toISOString();
    let updateQuery = supabase
      .from("generated_signal_pairs")
      .update({
        signal_result: outcome.signalResult,
        resolved_at: resolvedAt,
        winning_outcome: outcome.candidateWinningOutcome,
        realized_return_pct: outcome.realizedReturnPct,
      })
      .is("signal_result", null) // idempotency guard — never overwrite already-resolved rows
      ;

    if (DEDUPE_STRICT) {
      updateQuery = updateQuery
        .eq("condition_id", conditionId)
        .eq("selected_token_id", selectedTokenId as string);
    } else {
      updateQuery = updateQuery.eq("id", row.id as string);
    }

    const { data: updatedRows, error: updateError } = await updateQuery.select("id");

    if (updateError) {
      console.error(
        `  ERROR ${rowLabel} update failed: ${updateError.message}`
      );
      skippedCount++;
    } else {
      const affectedRows = updatedRows?.length ?? 0;
      if (affectedRows > 0) {
        rowsUpdatedTotal += affectedRows;
        strictTokensUpdated++;
        console.log(
          `  ${DEDUPE_STRICT ? "WRITE_STRICT" : "WRITE"} ${rowLabel}` +
            `${DEDUPE_STRICT ? ` strictKey=${conditionId}::${selectedTokenId} rows=${affectedRows}` : ""}` +
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
  console.log(`  order:         ${orderMode}`);
  console.log(`  only_expired:  ${ONLY_EXPIRED}`);
  console.log(`  dedupe_strict: ${DEDUPE_STRICT}`);
  console.log(`  expired_cutoff:${ONLY_EXPIRED ? ` ${expiredCutoff}` : " n/a"}`);
  console.log(`  raw_selected:  ${selectedCount}`);
  console.log(`  strict_selected:${DEDUPE_STRICT ? ` ${strictSelectedCount}` : " n/a"}`);
  console.log(`  strict_dupes:  ${duplicateRowsSkippedByStrictDedupe}`);
  console.log(`  rows_updated:  ${rowsUpdatedTotal}`);
  console.log(`  strict_updated:${strictTokensUpdated}`);
  console.log(`  skipped:       ${skippedCount}`);
  console.log(`  duration_ms:   ${durationMs}`);
  console.log(`  by_state:      ${JSON.stringify(stateCounts)}`);
  console.log(`  by_result:     ${JSON.stringify(resultCounts)}`);

  if (WRITE_MODE && rowsUpdatedTotal === 0 && selectedCount > 0) {
    console.log(
      `[resolve-signals] No rows updated — all were active, unknown, or already resolved.`
    );
  }

  // ── Write job_runs (write-mode only) ─────────────────────────────────────
  if (WRITE_MODE) {
    await tryWriteResolverJobRun({
      status: "success",
      updatedCount: rowsUpdatedTotal,
      skippedCount,
      finishedAt,
      extra: {
        selected: selectedCount,
        rawSelected: selectedCount,
        strictSelected: strictSelectedCount,
        duplicateRowsSkippedByStrictDedupe,
        rowsUpdatedTotal,
        strictTokensUpdated,
        updated: rowsUpdatedTotal,
        skipped: skippedCount,
        orderMode,
        onlyExpired: ONLY_EXPIRED,
        dedupeStrict: DEDUPE_STRICT,
        expiredCutoff: ONLY_EXPIRED ? expiredCutoff : null,
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
