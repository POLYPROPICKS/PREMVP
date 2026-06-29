#!/usr/bin/env node
/**
 * LIQUIDITY_MODEL — capture read-only orderbook snapshots for watchlist tokens.
 *
 * Reads active watchlist rows, fetches public CLOB orderbooks with bounded
 * concurrency, computes microstructure metrics, and inserts snapshot rows
 * (including failure rows). Strictly read-only: no trading auth, no orders.
 *
 * Run via tsx: npm run liquidity:capture-snapshots
 */
import { pathToFileURL } from "node:url";
// Dynamic import (see build-watchlist.mjs) for TS named exports under tsx.
const { SupabaseLiquidityRepo } = await import("../../lib/liquidity/supabaseLiquidityRepo.ts");
const { fetchOrderBooksConcurrent } = await import("../../lib/liquidity/polymarketClient.ts");
const { buildSnapshotInsertPayload } = await import("../../lib/liquidity/snapshotBuilder.ts");
const { planCaptureSuppression, renderCaptureSkipSummaryLine } = await import(
  "../../lib/liquidity/captureSuppression.ts"
);
const { tallyFailureBuckets, renderFailureBucketsLine } = await import(
  "../../lib/liquidity/failureBuckets.ts"
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

export async function runCaptureSnapshots() {
  const snapshotLimit = envInt("LIQUIDITY_SNAPSHOT_LIMIT", 200);
  const concurrency = envInt("LIQUIDITY_ORDERBOOK_CONCURRENCY", 5);
  // Repeated-http_404 suppression knobs (defaults: >=3 404s in last 24h).
  const suppressThreshold = envInt("LIQUIDITY_SUPPRESS_HTTP404_THRESHOLD", 3);
  const suppressWindowHours = envInt("LIQUIDITY_SUPPRESS_HTTP404_WINDOW_HOURS", 24);

  const repo = new SupabaseLiquidityRepo();
  const active = await repo.getActiveWatchlistRows(snapshotLimit);

  if (active.status === "DB_ENV_MISSING" || active.status === "SCHEMA_MISSING") {
    log(
      `LIQUIDITY_SNAPSHOT_CAPTURE_SUMMARY verdict=${active.status} candidates=0 skipped_repeated_http_404=0 attempted=0 ok=0 partial=0 failed=0 inserted=0`,
    );
    return { status: active.status, inserted: 0 };
  }

  // Only capture for tokens that passed BOTH the market-family gate and the
  // hard volume gate. Never fetch/store books for unsupported/low-volume markets.
  // Capture for family-passed tokens whose volume gate is passed OR deferred.
  // "deferred" = source had no volume column; the live orderbook IS the volume/
  // liquidity check, so these must reach capture. Hard-rejected volume is skipped.
  const watchlistRows = active.data.filter(
    (r) =>
      r.market_family_gate_status === "passed" &&
      (r.volume_gate_status === "passed" || r.volume_gate_status === "deferred"),
  );
  const candidateTokenIds = watchlistRows.map((r) => r.token_id);

  // Repeated-http_404 suppression: skip CLOB fetch for tokens that have already
  // 404'd >=N times in the window with no recovery. Uses existing snapshot
  // history only (no schema change, no fake rows for skipped tokens).
  const windowMs = suppressWindowHours * 3600 * 1000;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const recentByToken = new Map();
  const recent = await repo.getRecentSnapshotsByToken(candidateTokenIds, sinceIso);
  if (recent.status === "OK") {
    for (const row of recent.data) {
      const list = recentByToken.get(row.token_id) ?? [];
      list.push(row);
      recentByToken.set(row.token_id, list);
    }
  }
  const suppressionPlan = planCaptureSuppression(candidateTokenIds, recentByToken, {
    thresholdCount: suppressThreshold,
    windowMs,
  });
  log(renderCaptureSkipSummaryLine(suppressionPlan));

  // Only fetch books for kept tokens; map results back by token id.
  const fetchTokenIds = suppressionPlan.keptTokens;
  const results = await fetchOrderBooksConcurrent(fetchTokenIds, concurrency);
  const resultByToken = new Map();
  for (let i = 0; i < fetchTokenIds.length; i++) resultByToken.set(fetchTokenIds[i], results[i]);

  const capturedAt = new Date().toISOString();
  const snapshots = [];
  let ok = 0;
  let partial = 0;
  let failed = 0;
  for (const watchlistRow of watchlistRows) {
    // Skipped tokens are not fetched and produce no snapshot row (no fake data).
    if (suppressionPlan.suppressedTokens.has(watchlistRow.token_id)) continue;
    const result = resultByToken.get(watchlistRow.token_id);
    if (!result) continue;
    const payload = buildSnapshotInsertPayload(watchlistRow, result, { capturedAt });
    snapshots.push(payload);
    if (payload.snapshot_status === "ok") ok += 1;
    else if (payload.snapshot_status === "partial") partial += 1;
    else failed += 1;
  }

  // Bucket the failure reasons of this run's failed snapshots for actionable
  // diagnostics (http_404 dominates in production today).
  const failureBuckets = tallyFailureBuckets(
    snapshots.filter((s) => s.snapshot_status === "failed").map((s) => s.failure_reason),
  );
  log(renderFailureBucketsLine(failureBuckets));

  const insert = await repo.insertSnapshotRows(snapshots);
  const inserted = insert.status === "OK" ? insert.data : 0;
  const verdict = insert.status === "OK" ? "OK_CAPTURING" : insert.status;

  log(
    `LIQUIDITY_SNAPSHOT_CAPTURE_SUMMARY verdict=${verdict} candidates=${candidateTokenIds.length} skipped_repeated_http_404=${suppressionPlan.tokensSkipped} attempted=${fetchTokenIds.length} ok=${ok} partial=${partial} failed=${failed} inserted=${inserted}`,
  );
  return {
    status: verdict,
    inserted,
    candidates: candidateTokenIds.length,
    skippedRepeatedHttp404: suppressionPlan.tokensSkipped,
    attempted: fetchTokenIds.length,
    failureBuckets,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCaptureSnapshots().catch((err) => {
    log(`LIQUIDITY_SNAPSHOT_CAPTURE_ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
