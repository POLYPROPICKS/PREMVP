// scripts/report-sports-inventory-scoring-dry-run.ts
//
// READ-ONLY production scoring dry run CLI. Reuses the existing paginated
// loader (loadSportsInventoryFunnelRows) and reporter-proven eligibility
// rules (computeSportsInventoryEligibleGroups) to build a deterministic
// bounded sample, then scores it through the real production
// enrichMarket()/generateLandingCardPair() boundary -- no formula copied, no
// selection invented. SELECT-only against sports_event_market_inventory,
// read-only Polymarket GET calls via the existing client, zero writes.
//
// Usage:
//   npx tsx scripts/report-sports-inventory-scoring-dry-run.ts \
//     --fixed-now 2026-07-31T06:31:00.000Z \
//     --horizon-hours 48 \
//     --max-groups 10 \
//     --max-markets-per-group 1 \
//     --concurrency 1

import { loadEnvConfig } from "@next/env";
import {
  loadSportsInventoryFunnelRows,
  SportsInventoryRowReadError,
  SOURCE_TABLE,
  type SportsInventoryFunnelRow,
} from "../lib/reporting/sportsInventoryFunnelReport";
import {
  runSportsInventoryScoringDryRun,
  validateScoringDryRunOptions,
  HARD_MAX_GROUPS,
  HARD_MAX_MARKETS_PER_GROUP,
  HARD_MAX_CONCURRENCY,
  type ScoreMarketPort,
} from "../lib/reporting/sportsInventoryScoringDryRun";

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
  console.error(`SCORING_DRY_RUN_INVALID_ARGUMENT: ${message}`);
  console.log(JSON.stringify({ verdict: "STOP_INVALID_ARGUMENT" }));
  process.exit(2);
}

function dbUnavailable(message: string): never {
  console.error(`SCORING_DRY_RUN_ROW_READ_FAILED: ${message}`);
  console.log(
    JSON.stringify({
      report_version: "sports-inventory-scoring-dry-run/1",
      DB_AVAILABLE: false,
      source_table: SOURCE_TABLE,
      verdict: "STOP_PRODUCTION_READ_UNAVAILABLE",
    }),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const fixedNow = arg("fixed-now");
  if (!fixedNow) invalidArgument("--fixed-now is required");
  const horizonHours = arg("horizon-hours") === undefined ? 48 : Number(arg("horizon-hours"));
  const maxGroups = arg("max-groups") === undefined ? 10 : Number(arg("max-groups"));
  const maxMarketsPerGroup = arg("max-markets-per-group") === undefined ? 1 : Number(arg("max-markets-per-group"));
  const concurrency = arg("concurrency") === undefined ? 1 : Number(arg("concurrency"));

  const options = { fixedNow: fixedNow as string, horizonHours, maxGroups, maxMarketsPerGroup, concurrency };
  const validation = validateScoringDryRunOptions(options);
  if (!validation.ok) {
    invalidArgument(
      `${validation.reasonCode} (hard caps: maxGroups<=${HARD_MAX_GROUPS}, maxMarketsPerGroup<=${HARD_MAX_MARKETS_PER_GROUP}, concurrency<=${HARD_MAX_CONCURRENCY})`,
    );
  }

  // Env must be bootstrapped BEFORE the Supabase server helper / enrichment
  // client are imported -- hence dynamic imports below rather than static
  // top-of-file imports.
  loadEnvConfig(process.cwd());

  let supabaseAdmin: { from: (table: string) => any } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    ({ supabaseAdmin } = await import("../lib/supabase/server"));
  } catch {
    dbUnavailable("Supabase server helper unavailable (missing env)");
  }

  let rows: SportsInventoryFunnelRow[] = [];
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
  } catch (e) {
    if (e instanceof SportsInventoryRowReadError) {
      console.error(
        JSON.stringify({
          operation: "sports_inventory_scoring_dry_run_read",
          page: e.page,
          failure_code: "SCORING_DRY_RUN_ROW_READ_FAILED",
          error_message: e.message,
        }),
      );
    }
    dbUnavailable("row read failed");
  }

  // Real production scoring boundary: enrichMarket() (read-only Polymarket
  // GET calls) then generateLandingCardPair() (pure formula, no I/O). No
  // formula is reimplemented here.
  const { enrichMarket, generateLandingCardPair } = await import("../lib/feed/buildLandingCards");
  const scorePort: ScoreMarketPort = async (event, market) => {
    let enriched: Awaited<ReturnType<typeof enrichMarket>>;
    try {
      enriched = await enrichMarket(event, market, []);
    } catch {
      return { ok: false, reasonCode: "LIVE_ENRICHMENT_FAILED" };
    }
    if (!enriched) return { ok: false, reasonCode: "LIVE_ENRICHMENT_EMPTY" };
    const pair = generateLandingCardPair(enriched);
    if (!pair) return { ok: false, reasonCode: "SCORE_NOT_PRODUCED" };
    return {
      ok: true,
      selected_outcome: enriched.selectedOutcome.name,
      selected_token_id: enriched.selectedOutcome.tokenId,
      opposing_token_id: null,
      entry_price: enriched.selectedOutcome.price,
      score: pair.premiumSignal.winProbability,
      confidence: pair.premiumSignal.displaySignalConfidence ?? pair.premiumSignal.winProbability,
      data_coverage: enriched.diagnostics.dataCoverage,
    };
  };

  const report = await runSportsInventoryScoringDryRun(
    rows,
    { fixedNow: fixedNow as string, horizonHours, maxGroups, maxMarketsPerGroup, concurrency },
    scorePort,
  );

  if (report.successfully_scored_markets === 0) {
    console.error("SCORING_DRY_RUN_NO_MARKET_SCORED");
    console.log(
      JSON.stringify({
        ...report,
        DB_AVAILABLE: true,
        source_table: SOURCE_TABLE,
        verdict: "STOP_NO_MARKET_SCORED",
      }),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      ...report,
      DB_AVAILABLE: true,
      source_table: SOURCE_TABLE,
      verdict: "PASS_LIVE_SCORING_DRY_RUN",
      next_action: "RUN_LOCAL_LIVE_SCORING_DRY_RUN",
    }),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(`SCORING_DRY_RUN_LIVE_ENRICHMENT_FAILED: ${e instanceof Error ? e.message : "unknown error"}`);
  dbUnavailable("unhandled error");
});
