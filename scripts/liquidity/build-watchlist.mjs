#!/usr/bin/env node
/**
 * LIQUIDITY_MODEL — build the market tracking watchlist (read-only contour).
 *
 * Reads source research rows, applies sport + market-family + hard volume gate,
 * dedupes, enforces per-sport and per-(sport,family) caps, and upserts the
 * surviving tokens into market_tracking_watchlist.
 *
 * Fail-open: DB_ENV_MISSING / SCHEMA_MISSING are reported as machine states,
 * never crashes, never prints secrets. No trading auth, no order placement.
 *
 * Run via tsx so the TypeScript lib modules resolve:
 *   npm run liquidity:build-watchlist
 */
// Dynamic import: an .mjs entry importing TypeScript named exports requires the
// dynamic form under tsx (static `.ts` imports do not expose named bindings).
const { SupabaseLiquidityRepo } = await import("../../lib/liquidity/supabaseLiquidityRepo.ts");
const { buildWatchlistCandidate, dedupeWatchlistCandidates, toWatchlistRow } = await import(
  "../../lib/liquidity/watchlistBuilder.ts"
);
const { enforcePerSportCaps, enforcePerSportFamilyCaps, isVolumeGatePassed } = await import(
  "../../lib/liquidity/marketGates.ts"
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

export async function runBuildWatchlist() {
  const minVolumeUsd = envInt("LIQUIDITY_MIN_MARKET_VOLUME_USD", 10000);
  const watchlistLimit = envInt("LIQUIDITY_WATCHLIST_LIMIT", 200);
  const sportTokenLimit = envInt("LIQUIDITY_SPORT_TOKEN_LIMIT", 50);
  const unknownSportLimit = envInt("LIQUIDITY_UNKNOWN_SPORT_LIMIT", 10);
  const sportFamilyTokenLimit = envInt("LIQUIDITY_SPORT_FAMILY_TOKEN_LIMIT", 20);
  const unknownFamilyLimit = envInt("LIQUIDITY_UNKNOWN_MARKET_FAMILY_LIMIT", 0);

  const repo = new SupabaseLiquidityRepo();
  const source = await repo.getSourceRowsForWatchlist(windowStartIso());

  if (source.status === "DB_ENV_MISSING" || source.status === "SCHEMA_MISSING") {
    log(
      `LIQUIDITY_WATCHLIST_BUILD_SUMMARY verdict=${source.status} source_rows=0 candidates=0 family_pass=0 volume_checked=0 volume_pass=0 upserted=0 rejected=0`,
    );
    return { status: source.status, upserted: 0 };
  }

  const sourceRows = source.data;
  const candidates = [];
  for (const row of sourceRows) {
    const c = buildWatchlistCandidate(row, { minVolumeUsd });
    if (c) candidates.push(c);
  }

  const deduped = dedupeWatchlistCandidates(candidates);
  const familyPassed = deduped.filter((c) => c.marketFamilyGate === "SUPPORTED");
  const volumeChecked = familyPassed.length;
  const volumePassed = familyPassed.filter((c) => isVolumeGatePassed(c.volumeGate));

  // Per-(sport,family) caps, then per-sport caps, then overall limit.
  const familyCapped = enforcePerSportFamilyCaps(volumePassed, {
    sportFamilyTokenLimit,
    unknownFamilyLimit,
  });
  const sportCapped = enforcePerSportCaps(familyCapped.kept, {
    sportTokenLimit,
    unknownSportLimit,
  });
  const finalCandidates = sportCapped.kept.slice(0, watchlistLimit);
  const rows = finalCandidates.map(toWatchlistRow);

  const upsert = await repo.upsertWatchlistRows(rows);
  const upserted = upsert.status === "OK" ? upsert.data : 0;
  const rejected = candidates.length - volumePassed.length;
  const verdict = upsert.status === "OK" ? "OK_CAPTURING" : upsert.status;

  log(
    `LIQUIDITY_WATCHLIST_BUILD_SUMMARY verdict=${verdict} source_rows=${sourceRows.length} candidates=${candidates.length} family_pass=${familyPassed.length} volume_checked=${volumeChecked} volume_pass=${volumePassed.length} upserted=${upserted} rejected=${rejected}`,
  );
  return { status: verdict, upserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBuildWatchlist().catch((err) => {
    log(`LIQUIDITY_WATCHLIST_BUILD_ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
