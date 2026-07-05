// Materializer runner for public.track_record_display_signals.
//
// Default: dry-run (reads only, no insert). Pass --write to insert missing
// display rows for today's batch. Freshness-gated: if the newest
// generated_signal_pairs row is older than 36h, the run fails safe with
// verdict NO_FRESH_GENERATED_SIGNAL_PAIRS unless --allow-stale is passed.
// Idempotent via read-existing-then-insert-missing on
// (batch_day, window_days, source_row_id) — no DB unique constraint needed.
//
// Usage:
//   npm run track-record:display:materialize                # dry-run
//   npm run track-record:display:materialize -- --write     # insert missing rows
//   flags: --window-days=14 --limit=25 --allow-stale
//
// Logs only counts, dates, and verdicts — never env values, keys, or tokens.

import {
  DEFAULT_LIMIT,
  DEFAULT_MAX_SOURCE_AGE_HOURS,
  DEFAULT_WINDOW_DAYS,
  runDisplayMaterializer,
  type ExistingDisplayKey,
  type GeneratedPairSourceRow,
  type MaterializerDeps,
  type TrackRecordDisplayRow,
} from "../lib/track-record/displayMaterializer";

export interface ParsedArgs {
  write: boolean;
  allowStale: boolean;
  windowDays: number;
  limit: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const numberFlag = (name: string, fallback: number): number => {
    const raw = argv.find((a) => a.startsWith(`--${name}=`));
    if (!raw) return fallback;
    const n = Number(raw.split("=")[1]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    write: argv.includes("--write"),
    allowStale: argv.includes("--allow-stale"),
    windowDays: numberFlag("window-days", DEFAULT_WINDOW_DAYS),
    limit: numberFlag("limit", DEFAULT_LIMIT),
  };
}

const SOURCE_SELECT =
  "id, created_at, expires_at, event_slug, market_slug, condition_id, " +
  "selected_outcome, entry_price_num, score, signal_confidence_num, " +
  "metric_formula_version, premium_signal";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "[materialize-display] Missing required environment variable(s) " +
        "(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY presence check failed). " +
        "No DB access attempted."
    );
    process.exitCode = 1;
    return;
  }

  // Imported lazily so the env presence check above runs first.
  const { supabaseAdmin } = await import("../lib/supabase/server");

  const freshCutoffIso = new Date(
    Date.now() - DEFAULT_MAX_SOURCE_AGE_HOURS * 3600 * 1000
  ).toISOString();

  const deps: MaterializerDeps = {
    fetchFreshSourceRows: async (): Promise<GeneratedPairSourceRow[]> => {
      const { data, error } = await supabaseAdmin
        .from("generated_signal_pairs")
        .select(SOURCE_SELECT)
        .gte("created_at", freshCutoffIso)
        // Exclude shadow research rows; keep legacy NULL formula rows.
        .or(
          "metric_formula_version.is.null,metric_formula_version.not.like.shadow-%"
        )
        .not("entry_price_num", "is", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) {
        throw new Error(`Failed to read generated_signal_pairs: ${error.message}`);
      }
      return ((data ?? []) as unknown) as GeneratedPairSourceRow[];
    },
    fetchExistingDisplayKeys: async (
      batchDay: string,
      windowDays: number
    ): Promise<ExistingDisplayKey[]> => {
      const { data, error } = await supabaseAdmin
        .from("track_record_display_signals")
        .select("batch_day, window_days, source_row_id")
        .eq("batch_day", batchDay)
        .eq("window_days", windowDays);
      if (error) {
        throw new Error(
          `Failed to read track_record_display_signals: ${error.message}`
        );
      }
      return (data ?? []) as ExistingDisplayKey[];
    },
    insertDisplayRows: async (rows: TrackRecordDisplayRow[]): Promise<number> => {
      const { error, count } = await supabaseAdmin
        .from("track_record_display_signals")
        .insert(rows, { count: "exact" });
      if (error) {
        throw new Error(
          `Failed to insert track_record_display_signals rows: ${error.message}`
        );
      }
      return count ?? rows.length;
    },
  };

  const result = await runDisplayMaterializer(deps, {
    nowIso,
    write: args.write,
    allowStale: args.allowStale,
    windowDays: args.windowDays,
    limit: args.limit,
  });

  console.log("[materialize-display]", {
    mode: args.write ? "write" : "dry-run",
    verdict: result.verdict,
    batchDay: result.batchDay,
    windowDays: result.windowDays,
    sourceRowCount: result.sourceRowCount,
    latestGeneratedAt: result.latestGeneratedAt,
    plannedCount: result.plannedCount,
    skippedExistingCount: result.skippedExistingCount,
    insertedCount: result.insertedCount,
  });

  if (result.verdict === "NO_FRESH_GENERATED_SIGNAL_PAIRS") {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[materialize-display] FAILED:", message);
  process.exitCode = 1;
});
