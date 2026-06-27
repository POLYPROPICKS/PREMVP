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

  const repo = new SupabaseLiquidityRepo();
  const active = await repo.getActiveWatchlistRows(snapshotLimit);

  if (active.status === "DB_ENV_MISSING" || active.status === "SCHEMA_MISSING") {
    log(
      `LIQUIDITY_SNAPSHOT_CAPTURE_SUMMARY verdict=${active.status} attempted=0 ok=0 partial=0 failed=0 inserted=0`,
    );
    return { status: active.status, inserted: 0 };
  }

  // Only capture for tokens that passed BOTH the market-family gate and the
  // hard volume gate. Never fetch/store books for unsupported/low-volume markets.
  const watchlistRows = active.data.filter(
    (r) => r.market_family_gate_status === "passed" && r.volume_gate_status === "passed",
  );
  const tokenIds = watchlistRows.map((r) => r.token_id);
  const results = await fetchOrderBooksConcurrent(tokenIds, concurrency);

  const capturedAt = new Date().toISOString();
  const snapshots = [];
  let ok = 0;
  let partial = 0;
  let failed = 0;
  for (let i = 0; i < watchlistRows.length; i++) {
    const payload = buildSnapshotInsertPayload(watchlistRows[i], results[i], { capturedAt });
    snapshots.push(payload);
    if (payload.snapshot_status === "ok") ok += 1;
    else if (payload.snapshot_status === "partial") partial += 1;
    else failed += 1;
  }

  const insert = await repo.insertSnapshotRows(snapshots);
  const inserted = insert.status === "OK" ? insert.data : 0;
  const verdict = insert.status === "OK" ? "OK_CAPTURING" : insert.status;

  log(
    `LIQUIDITY_SNAPSHOT_CAPTURE_SUMMARY verdict=${verdict} attempted=${tokenIds.length} ok=${ok} partial=${partial} failed=${failed} inserted=${inserted}`,
  );
  return { status: verdict, inserted };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCaptureSnapshots().catch((err) => {
    log(`LIQUIDITY_SNAPSHOT_CAPTURE_ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
