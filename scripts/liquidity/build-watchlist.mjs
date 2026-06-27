#!/usr/bin/env node
/**
 * LIQUIDITY_MODEL — build the market tracking watchlist (read-only contour).
 *
 * Reads source research rows (generated_signal_research_snapshots, fallback
 * generated_signal_pairs) for the upcoming window, applies sport + market-family
 * + hard market-level volume gate, dedupes, enforces per-sport and
 * per-(sport,family) caps, and upserts surviving tokens into
 * market_tracking_watchlist.
 *
 * Fail-open: DB_ENV_MISSING / SCHEMA_MISSING are machine states, never crashes,
 * never prints secrets. No trading auth, no order placement.
 *
 * Run via tsx: npm run liquidity:build-watchlist
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

  const now = Date.now();
  const gameStartGteIso = new Date(now - 30 * 60 * 1000).toISOString();
  const gameStartLteIso = new Date(now + 24 * 3600 * 1000).toISOString();
  const createdGteIso = new Date(now - 24 * 3600 * 1000).toISOString();

  const repo = new SupabaseLiquidityRepo();
  const source = await repo.getSourceRowsForWatchlist({
    gameStartGteIso,
    gameStartLteIso,
    createdGteIso,
    limit: 5000,
  });

  if (source.status === "DB_ENV_MISSING" || source.status === "SCHEMA_MISSING") {
    log(
      `LIQUIDITY_WATCHLIST_BUILD_SUMMARY source_rows=0 candidates=0 family_pass=0 volume_checked=0 volume_pass=0 active_upserted=0 rejected=0 db_status=${source.status}`,
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

  const familyCapped = enforcePerSportFamilyCaps(volumePassed, {
    sportFamilyTokenLimit,
    unknownFamilyLimit,
  });
  const sportCapped = enforcePerSportCaps(familyCapped.kept, {
    sportTokenLimit,
    unknownSportLimit,
  });
  const finalCandidates = sportCapped.kept.slice(0, watchlistLimit);
  const rows = finalCandidates.map((c) => toWatchlistRow(c, null, minVolumeUsd));

  const upsert = await repo.upsertWatchlistRows(rows);
  const upserted = upsert.status === "OK" ? upsert.data : 0;
  const rejected = candidates.length - volumePassed.length;

  log(
    `LIQUIDITY_WATCHLIST_BUILD_SUMMARY source_rows=${sourceRows.length} candidates=${candidates.length} family_pass=${familyPassed.length} volume_checked=${volumeChecked} volume_pass=${volumePassed.length} active_upserted=${upserted} rejected=${rejected} db_status=${upsert.status}`,
  );

  // Per-sport gate summary.
  const bySport = new Map();
  for (const c of deduped) {
    const e = bySport.get(c.normalizedSport) ?? { source: 0, family_pass: 0, volume_pass: 0 };
    e.source += 1;
    if (c.marketFamilyGate === "SUPPORTED") e.family_pass += 1;
    if (c.marketFamilyGate === "SUPPORTED" && isVolumeGatePassed(c.volumeGate)) e.volume_pass += 1;
    bySport.set(c.normalizedSport, e);
  }
  for (const [sport, e] of [...bySport.entries()].sort()) {
    log(
      `LIQUIDITY_SPORT_GATE_SUMMARY sport=${sport} source=${e.source} family_pass=${e.family_pass} volume_pass=${e.volume_pass}`,
    );
  }

  // Per-(sport,family) gate summary.
  const byFamily = new Map();
  for (const c of deduped) {
    const key = `${c.normalizedSport}::${c.normalizedMarketFamily}`;
    const e = byFamily.get(key) ?? { source: 0, volume_pass: 0 };
    e.source += 1;
    if (c.marketFamilyGate === "SUPPORTED" && isVolumeGatePassed(c.volumeGate)) e.volume_pass += 1;
    byFamily.set(key, e);
  }
  for (const [key, e] of [...byFamily.entries()].sort()) {
    const [sport, family] = key.split("::");
    log(
      `LIQUIDITY_MARKET_FAMILY_GATE_SUMMARY sport=${sport} family=${family} source=${e.source} volume_pass=${e.volume_pass}`,
    );
  }

  return { status: upsert.status, upserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBuildWatchlist().catch((err) => {
    log(`LIQUIDITY_WATCHLIST_BUILD_ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
