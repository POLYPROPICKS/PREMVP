// scripts/report-sports-inventory-funnel.ts
//
// READ-ONLY production funnel reporter CLI for sports_event_market_inventory.
// SELECT-only, paginated, bounded loader + the pure analyzer in
// lib/reporting/sportsInventoryFunnelReport.ts. No write, no Polymarket call,
// no Reservation/Queue access. Emits exactly one JSON document to stdout;
// structured errors go to stderr only.
//
// Usage:
//   npx tsx scripts/report-sports-inventory-funnel.ts \
//     --fixed-now 2026-07-31T05:00:00.000Z \
//     --horizon-hours 48

import { loadEnvConfig } from "@next/env";
import {
  analyzeSportsInventoryFunnel,
  loadSportsInventoryFunnelRows,
  SportsInventoryRowReadError,
  SOURCE_TABLE,
  type SportsInventoryFunnelRow,
} from "../lib/reporting/sportsInventoryFunnelReport";

const SELECT_COLUMNS = [
  "provider",
  "provider_event_id",
  "provider_event_slug",
  "provider_market_id",
  "provider_market_slug",
  "event_title",
  "market_question",
  "event_start_iso",
  "market_end_iso",
  "condition_id",
  "clob_token_ids",
  "outcomes",
  "outcome_prices",
  "provider_tags",
  "raw_category",
  "league_hint",
  "sports_market_type",
  "volume_usd",
  "volume_24hr_usd",
  "is_confirmed_sports",
  "sports_confirmation_source",
  "sibling_market_count",
  "first_observed_at",
  "last_observed_at",
  "expires_at",
].join(",");

function arg(name: string): string | undefined {
  const pref = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

function invalidArgument(message: string): never {
  console.error(`FUNNEL_REPORT_INVALID_ARGUMENT: ${message}`);
  process.exit(2);
}

function failClosed(reason: string): never {
  console.error(reason);
  const failReport = {
    report_version: "sports-inventory-funnel-report/1",
    DB_AVAILABLE: false,
    source_table: SOURCE_TABLE,
    verdict: "STOP_PRODUCTION_READ_UNAVAILABLE",
    next_action: "RETURN_ONE_BLOCKER",
  };
  console.log(JSON.stringify(failReport));
  process.exit(1);
}

async function main(): Promise<void> {
  const fixedNowArg = arg("fixed-now");
  const horizonArg = arg("horizon-hours");

  const horizonHours = horizonArg === undefined ? 48 : Number(horizonArg);
  if (!Number.isInteger(horizonHours) || horizonHours <= 0) {
    invalidArgument("--horizon-hours must be a positive integer");
  }

  const fixedNow = fixedNowArg ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(fixedNow))) {
    invalidArgument("--fixed-now must be a valid ISO timestamp");
  }

  // Env must be bootstrapped BEFORE the Supabase server helper is imported,
  // and that import must itself happen only after this bootstrap -- hence the
  // dynamic import below rather than a static one at module top.
  loadEnvConfig(process.cwd());

  let supabaseAdmin: { from: (table: string) => any } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    ({ supabaseAdmin } = await import("../lib/supabase/server"));
  } catch {
    failClosed("FUNNEL_REPORT_ROW_READ_FAILED: Supabase server helper unavailable (missing env)");
  }

  let rows: SportsInventoryFunnelRow[] = [];
  let truncated = false;
  try {
    const result = await loadSportsInventoryFunnelRows(async ({ from, to }) => {
      const { data, error } = await supabaseAdmin!
        .from(SOURCE_TABLE)
        .select(SELECT_COLUMNS)
        .order("event_start_iso", { ascending: true })
        .order("provider_event_id", { ascending: true })
        .order("provider_market_id", { ascending: true })
        .range(from, to);
      return { data: (data as SportsInventoryFunnelRow[] | null) ?? null, error };
    });
    rows = result.rows;
    truncated = result.truncated;
  } catch (e) {
    if (e instanceof SportsInventoryRowReadError) {
      console.error(
        JSON.stringify({
          operation: "sports_inventory_funnel_read",
          page: e.page,
          row_count: rows.length,
          error_code: "FUNNEL_REPORT_ROW_READ_FAILED",
          error_message: e.message,
        }),
      );
      failClosed("FUNNEL_REPORT_ROW_READ_FAILED");
    }
    failClosed("FUNNEL_REPORT_ROW_READ_FAILED: unexpected read failure");
  }

  const report = analyzeSportsInventoryFunnel(rows, { fixedNow, horizonHours });

  if (truncated) {
    console.error("FUNNEL_REPORT_SOURCE_TRUNCATED: hard cap reached before a short final page");
    console.log(
      JSON.stringify({
        ...report,
        verdict: "STOP_SOURCE_TRUNCATED",
      }),
    );
    process.exit(1);
  }

  console.log(JSON.stringify(report));
  process.exit(0);
}

main().catch((e) => {
  console.error(`FUNNEL_REPORT_ROW_READ_FAILED: ${e instanceof Error ? e.message : "unknown error"}`);
  failClosed("FUNNEL_REPORT_ROW_READ_FAILED: unhandled error");
});
