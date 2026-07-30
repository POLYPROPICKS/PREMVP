#!/usr/bin/env npx tsx
// SPORTS UNIVERSE SOURCE-COVERAGE REPORT — READ-ONLY.
//
//   npx tsx scripts/contur3/source-coverage-funnel.ts
//   npx tsx scripts/contur3/source-coverage-funnel.ts --since-hours 72
//   npx tsx scripts/contur3/source-coverage-funnel.ts --target-file ./targets.json
//
// Quantifies where the Polymarket sports universe disappears between
// public.generated_signal_pairs and Reservation planning, and how much of that
// loss is caused by the market-policy gate classifying eventTitle instead of
// marketQuestion.
//
// SAFETY CONTRACT — this script is a pure observer:
//   * bounded .select() only; no insert/update/delete/upsert/rpc;
//   * never triggers capture, signal generation, planning, persistReservationPlan,
//     Queue, Ireland or any callback;
//   * writes NOTHING to the filesystem or the repo — stdout only.
//     Redirect to an external path if you want to keep a copy.
//   * operational errors go to stderr; credentials are never printed.
//
// Exit codes: 0 = report produced, 1 = invalid input or DB/read failure.

import { readFileSync } from "node:fs";

import { loadEnvConfig } from "@next/env";

import {
  analyzeSourceCoverage,
  SOURCE_COVERAGE_REPORT_VERSION,
  type CoverageSourceRow,
  type CoverageTarget,
} from "../../lib/contur3/sourceCoverageFunnel";

// ── Code-config facts, read from the real production constants they mirror ───
// These are CODE facts, not DB measurements, and are labelled as such in the
// output so an operator never confuses a configured cap with an observed count.
//   producer_limit / upcoming_limit  -> scripts/generate-signals.ts CONFIG
//   strategic_floor_categories       -> lib/feed/buildLandingCards.ts applyStrategicFloor
//   planning_lookback_hours          -> lib/executor/buildFireModelCandidates.ts
const SOURCE_ARCHITECTURE_CODE_FACTS = {
  producer_limit: 15,
  upcoming_limit: 10,
  strategic_floor_categories: ["WC26", "NBA", "NHL", "eSport"],
  planning_lookback_hours: 72,
  producer_source_ref: "scripts/generate-signals.ts CONFIG",
  strategic_floor_source_ref: "lib/feed/buildLandingCards.ts applyStrategicFloor",
  planning_lookback_source_ref: "lib/executor/buildFireModelCandidates.ts PLANNING_LOOKBACK_HOURS",
} as const;

const DEFAULT_SINCE_HOURS = 72;
const PLANNING_HORIZON_HOURS = 48; // discovery keyset window / RESERVATION_PIN_HORIZON_MS
const PAGE_SIZE = 1000;
const FETCH_CEILING = 200_000;

/** The Founder's observed-but-missing events, 2026-07-30 18:42-18:47 Minsk. */
const BUILTIN_TARGETS: CoverageTarget[] = [
  { target_label: "Rangers vs Rays", match_tokens: ["rangers", "rays"] },
  { target_label: "Royals vs Twins", match_tokens: ["royals", "twins"] },
  { target_label: "Yankees vs White Sox", match_tokens: ["yankees", "white sox"] },
  { target_label: "Cubs vs Cardinals", match_tokens: ["cubs", "cardinals"] },

  { target_label: "Tobyl FK vs FK Panevėžys", match_tokens: ["tobyl"] },
  { target_label: "AFC Bournemouth vs FC Augsburg", match_tokens: ["bournemouth", "augsburg"] },
  { target_label: "FC Rottach-Egern vs Bayern Munich", match_tokens: ["rottach", "bayern"] },

  { target_label: "Minnesota Lynx vs Toronto Tempo", match_tokens: ["lynx", "tempo"] },
  { target_label: "Connecticut Sun vs Chicago Sky", match_tokens: ["connecticut sun", "sky"] },
  { target_label: "New York Liberty vs Las Vegas Aces", match_tokens: ["liberty", "aces"] },

  {
    target_label: "British Columbia Lions vs Winnipeg Blue Bombers",
    match_tokens: ["lions", "blue bombers"],
  },
  { target_label: "Montreal Alouettes vs Ottawa Redblacks", match_tokens: ["alouettes", "redblacks"] },
  {
    target_label: "Calgary Stampeders vs Hamilton Tiger-Cats",
    match_tokens: ["stampeders", "tiger"],
  },

  {
    target_label: "Phoenix Flames vs Brooklyn Pickleball Team",
    match_tokens: ["phoenix flames", "brooklyn"],
  },
  {
    target_label: "St. Louis Shock vs Miami Pickleball Club",
    match_tokens: ["shock", "miami"],
  },

  {
    target_label: "Bastian Malla vs Alvaro Frutos Alonso",
    match_tokens: ["malla", "frutos"],
  },
  { target_label: "Ymerali Ibraimi vs Chen Dong", match_tokens: ["ibraimi", "chen dong"] },
];

interface CliArgs {
  sinceHours: number;
  targetFile: string | null;
}

class CliError extends Error {}

/** Fail-closed argument parsing: unknown or duplicated flags are rejected. */
export function parseArgs(argv: string[]): CliArgs {
  let sinceHours: number | null = null;
  let targetFile: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--since-hours") {
      if (sinceHours !== null) throw new CliError("duplicate flag: --since-hours");
      const raw = argv[i + 1];
      if (raw === undefined) throw new CliError("--since-hours requires a value");
      if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        throw new CliError(`--since-hours must be a positive integer, got: ${raw}`);
      }
      sinceHours = Number(raw);
      i += 1;
    } else if (flag === "--target-file") {
      if (targetFile !== null) throw new CliError("duplicate flag: --target-file");
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("--")) {
        throw new CliError("--target-file requires a path value");
      }
      targetFile = raw;
      i += 1;
    } else {
      throw new CliError(`unknown argument: ${flag}`);
    }
  }

  return { sinceHours: sinceHours ?? DEFAULT_SINCE_HOURS, targetFile };
}

function reportError(operation: string, table: string, err: unknown): void {
  const anyErr = err as { code?: string; message?: string } | null;
  // Safe context only. Never the URL, never the service-role key.
  process.stderr.write(
    JSON.stringify({
      operation,
      table,
      error_code: anyErr?.code ?? "UNKNOWN",
      error_message: (anyErr?.message ?? String(err)).slice(0, 400),
    }) + "\n"
  );
}

/**
 * Map one generated_signal_pairs row onto the analyzer's source shape. The
 * provider surfaces live inside diagnostics.providerEventContext (v1/polymarket),
 * which is the same envelope buildIdentityText reads.
 */
function toCoverageRow(raw: Record<string, unknown>): CoverageSourceRow {
  const diag = (raw.diagnostics ?? {}) as Record<string, unknown>;
  const rawCtx = diag.providerEventContext;
  const ctx =
    rawCtx && typeof rawCtx === "object" && (rawCtx as Record<string, unknown>).v === "v1"
      ? (rawCtx as Record<string, unknown>)
      : null;

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  return {
    row_id: String(raw.id ?? ""),
    provider_event_id: str(ctx?.eventId),
    provider_event_slug: str(ctx?.eventSlug) ?? str(raw.event_slug),
    provider_market_id: str(raw.condition_id),
    provider_market_question: str(ctx?.marketQuestion) ?? str(diag.marketTitle) ?? str(diag.question),
    provider_event_title: str(ctx?.eventTitle) ?? str(diag.eventTitle),
    event_start_iso: str(ctx?.eventStartIso) ?? str(diag.gameStartIso),
    observed_at_iso: str(raw.created_at),
    league_or_sport_hint: str(ctx?.league) ?? str(ctx?.sportFamily) ?? str(ctx?.game),
    market_slug: str(raw.market_slug),
    event_slug: str(raw.event_slug),
  };
}

async function fetchSourceRows(sinceIso: string): Promise<Record<string, unknown>[]> {
  // Load the repo's .env.local into process.env BEFORE lib/supabase/server.ts is
  // evaluated — that module throws at import time when SUPABASE_URL /
  // SUPABASE_SERVICE_ROLE_KEY are missing, and `npx tsx` does not load .env.local
  // on its own. Same bootstrap the LC6 reporter uses
  // (450f089:scripts/report-live-contour6-runtime.ts:23/167/194). The helper stays
  // DYNAMICALLY imported so this ordering is guaranteed by construction; a static
  // import would evaluate it before this line could run. Nothing here reads or
  // prints .env.local, and no credential value is ever logged.
  loadEnvConfig(process.cwd());
  const { supabaseAdmin } = await import("../../lib/supabase/server");
  const all: Record<string, unknown>[] = [];
  let from = 0;

  for (;;) {
    // Bounded SELECT. Read-only by construction.
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select("id, condition_id, market_slug, event_slug, diagnostics, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    const batch = (data ?? []) as Record<string, unknown>[];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    if (from > FETCH_CEILING) break;
  }
  return all;
}

function loadTargets(targetFile: string | null): CoverageTarget[] {
  if (!targetFile) return BUILTIN_TARGETS;
  // Reading an operator-supplied file is a read; it is never written to.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(targetFile, "utf8"));
  } catch (err) {
    throw new CliError(
      `--target-file could not be read as JSON: ${(err as Error).message.slice(0, 200)}`
    );
  }
  if (!Array.isArray(parsed)) throw new CliError("--target-file must contain a JSON array");
  return parsed.map((entry, index) => {
    const e = entry as Record<string, unknown>;
    const label = e?.target_label;
    const tokens = e?.match_tokens;
    if (typeof label !== "string" || !Array.isArray(tokens) || tokens.some((t) => typeof t !== "string")) {
      throw new CliError(
        `--target-file entry ${index} must be { target_label: string, match_tokens: string[] }`
      );
    }
    return { target_label: label, match_tokens: tokens as string[] };
  });
}

async function main(): Promise<number> {
  let args: CliArgs;
  let targets: CoverageTarget[];
  try {
    args = parseArgs(process.argv.slice(2));
    targets = loadTargets(args.targetFile);
  } catch (err) {
    reportError("parse_args", "-", err);
    return 1;
  }

  const fixedNow = new Date().toISOString();
  const sinceIso = new Date(Date.parse(fixedNow) - args.sinceHours * 3_600_000).toISOString();

  let rawRows: Record<string, unknown>[];
  try {
    rawRows = await fetchSourceRows(sinceIso);
  } catch (err) {
    reportError("select_source_rows", "public.generated_signal_pairs", err);
    process.stdout.write(
      JSON.stringify(
        {
          report_version: SOURCE_COVERAGE_REPORT_VERSION,
          fixed_now: fixedNow,
          DB_AVAILABLE: false,
          source_architecture: {
            code_config_facts: SOURCE_ARCHITECTURE_CODE_FACTS,
            db_measured_facts: null,
          },
          overall_funnel: null,
          coverage_by_sport: [],
          target_event_matrix: [],
          largest_loss_stage: null,
          surface_selection_loss: null,
          limitations: ["Production read unavailable; no DB-measured fact in this report."],
          verdict: "STOP_PRODUCTION_READ_UNAVAILABLE",
        },
        null,
        2
      ) + "\n"
    );
    return 1;
  }

  const report = analyzeSourceCoverage({
    rows: rawRows.map(toCoverageRow),
    nowIso: fixedNow,
    freshnessHours: args.sinceHours,
    horizonHours: PLANNING_HORIZON_HOURS,
    targets,
  });

  // Self-consistency: per-sport counts must reconcile with the overall funnel.
  const sportRowSum = report.coverage_by_sport.reduce((n, s) => n + s.source_row_count, 0);
  const consistent = sportRowSum === report.overall_funnel.source_row_count;

  const observedDistinctEvents = report.overall_funnel.distinct_provider_event_count;

  process.stdout.write(
    JSON.stringify(
      {
        report_version: report.report_version,
        fixed_now: report.fixed_now,
        DB_AVAILABLE: true,
        source_architecture: {
          code_config_facts: SOURCE_ARCHITECTURE_CODE_FACTS,
          db_measured_facts: {
            window_hours: args.sinceHours,
            since_iso: sinceIso,
            observed_source_rows: report.overall_funnel.source_row_count,
            observed_distinct_events: observedDistinctEvents,
            estimated_max_rows_per_hour:
              SOURCE_ARCHITECTURE_CODE_FACTS.producer_limit /* per producer cycle */,
          },
        },
        window: report.window,
        overall_funnel: report.overall_funnel,
        coverage_by_sport: report.coverage_by_sport,
        target_event_matrix: report.target_event_matrix,
        largest_loss_stage: report.largest_loss_stage,
        surface_selection_loss: report.surface_selection_loss,
        limitations: [
          "generated_signal_pairs is a PRODUCT DISPLAY feed capped at producer_limit rows per cycle — it is not a full Polymarket market inventory.",
          "A target absent from this report is absent FROM SOURCE STORAGE ONLY. It is NOT evidence of absence from Polymarket.",
          "No liquidity, order-book depth, bid/ask or volume is read anywhere in this path, so no executability or PnL claim is derivable from this report.",
          "event_identity_complete mirrors the documented requirements of providerEventKeyOf() (buildFireModelCandidates.ts), which production does not export; it is recomputed report-locally.",
          "normalizeSport() has no alias for CFL or pickleball, so those rows aggregate under UNKNOWN.",
          "estimated_max_rows_per_hour is a CODE-CONFIG derivation from producer_limit, not a measured write rate.",
        ],
        verdict: consistent ? "PASS_COVERAGE_BASELINE_READY" : "FAIL_REPORT_INCONSISTENT",
      },
      null,
      2
    ) + "\n"
  );

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    reportError("main", "public.generated_signal_pairs", err);
    process.exitCode = 1;
  });
