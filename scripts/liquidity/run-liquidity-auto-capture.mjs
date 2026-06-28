#!/usr/bin/env node
/**
 * LIQUIDITY_MODEL — auto-capture scheduler runner (read-only contour).
 *
 * Plans and triggers liquidity snapshot capture for events in the next N days
 * using the founder cadence: T-12h..T-2h every 120 min, T-2h..start every
 * 10 min, in-play every 10 min (soccer default duration 130 min). All timing in
 * UTC; Minsk-local times shown for display only.
 *
 * Modes:
 *   --plan [--days 7]                 print the capture plan (no DB writes)
 *   --once                            run one capped capture cycle if any event is due
 *   --watch [--hours N]               loop due-checks for N hours, capped by cadence
 *   --event-url <url> | --event-slug <slug>   focus on one event (e.g. RSA-CAN)
 *   --event-start <iso>               focus event start override (testing without DB)
 *   --force                           treat the focused event as due (testing)
 *
 * Safety: no trading auth, no order placement; reuses the existing capped MVP
 * pipeline so CLOB rate limits/caps are preserved. If DB env is missing it
 * prints DB_ENV_MISSING and exits 0. State is kept in a gitignored JSON file.
 *
 * Run via tsx:
 *   npx tsx scripts/liquidity/run-liquidity-auto-capture.mjs --plan --days 7
 */
import fs from "node:fs";
import path from "node:path";

const { SupabaseLiquidityRepo } = await import("../../lib/liquidity/supabaseLiquidityRepo.ts");
const { buildLiquidityCapturePlan, formatInTimezone } = await import(
  "../../lib/liquidity/captureSchedule.ts"
);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function parseArgs(argv) {
  const args = { mode: "plan", days: 7, hours: 2, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") args.mode = "plan";
    else if (a === "--once") args.mode = "once";
    else if (a === "--watch") args.mode = "watch";
    else if (a === "--force") args.force = true;
    else if (a === "--days") args.days = Number(argv[++i]) || 7;
    else if (a === "--hours") args.hours = Number(argv[++i]) || 2;
    else if (a === "--event-url") args.eventUrl = argv[++i];
    else if (a === "--event-slug") args.eventSlug = argv[++i];
    else if (a === "--event-start") args.eventStart = argv[++i];
  }
  return args;
}

function slugFromUrl(url) {
  if (!url) return null;
  const m = String(url).trim().replace(/\/+$/, "").split("/");
  return m[m.length - 1] || null;
}

const REPORT_DIR = path.join(process.cwd(), "reports", "liquidity_pool");
const STATE_PATH = path.join(REPORT_DIR, "auto_capture_state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { captures: {} };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // state is best-effort; never fatal
  }
}

function firstStr(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/** Group source rows into events keyed by event slug (fallback start+league). */
function groupEventsFromSourceRows(rows, state) {
  const byKey = new Map();
  for (const r of rows) {
    const slug = firstStr(r.event_slug, r.eventSlug);
    const gameStartIso = firstStr(r.game_start_iso, r.game_start, r.start_time);
    const league = firstStr(r.league, r.sport, r.category);
    const key = slug ?? `${gameStartIso ?? "unknown"}::${league ?? "unknown"}`;
    const e = byKey.get(key) ?? {
      key,
      eventSlug: slug,
      eventTitle: firstStr(r.event_title),
      gameStartIso,
      sport: league,
      tokenCount: 0,
      lastCaptureAt: state.captures?.[key] ?? null,
    };
    e.tokenCount += 1;
    if (!e.gameStartIso && gameStartIso) e.gameStartIso = gameStartIso;
    byKey.set(key, e);
  }
  return [...byKey.values()];
}

function printPlan(plan, dbStatus, mode) {
  log(
    `LIQUIDITY_AUTO_CAPTURE_PLAN_SUMMARY now_utc=${plan.nowUtc} now_minsk=${formatInTimezone(Date.parse(plan.nowUtc))} days=${plan.windowDays} total_events=${plan.totalEvents} in_window=${plan.inWindowEvents} due=${plan.dueEvents} db_status=${dbStatus}`,
  );
  for (const e of plan.entries) {
    log(
      `LIQUIDITY_AUTO_CAPTURE_EVENT key=${e.key} slug=${e.eventSlug ?? "-"} sport=${e.sport ?? "-"} phase=${e.phase} cadence_min=${e.cadenceMinutes ?? "-"} due=${e.due} tokens=${e.tokenCount} start_utc=${e.eventStartUtc ?? "-"} start_minsk=${e.eventStartMinsk ?? "-"} next_due_utc=${e.nextDueUtc ?? "-"} next_due_minsk=${e.nextDueMinsk ?? "-"}`,
    );
  }
  log(`LIQUIDITY_AUTO_CAPTURE_DUE_SUMMARY due=${plan.dueEvents} mode=${mode}`);
}

async function loadEvents(args, state) {
  // Focused synthetic event (lets --plan work without DB for a known test event).
  const focusSlug = args.eventSlug ?? slugFromUrl(args.eventUrl);
  if (focusSlug && args.eventStart) {
    return {
      dbStatus: "FOCUSED_OVERRIDE",
      events: [
        {
          key: focusSlug,
          eventSlug: focusSlug,
          eventTitle: focusSlug,
          gameStartIso: args.eventStart,
          sport: "soccer",
          tokenCount: 0,
          lastCaptureAt: args.force ? null : (state.captures?.[focusSlug] ?? null),
        },
      ],
    };
  }

  const repo = new SupabaseLiquidityRepo();
  const now = Date.now();
  const source = await repo.getSourceRowsForWatchlist({
    gameStartGteIso: new Date(now - 30 * 60 * 1000).toISOString(),
    gameStartLteIso: new Date(now + args.days * 24 * 3600 * 1000).toISOString(),
    createdGteIso: new Date(now - 24 * 3600 * 1000).toISOString(),
    limit: 5000,
  });
  if (source.status !== "OK") {
    return { dbStatus: source.status, events: [] };
  }
  let events = groupEventsFromSourceRows(source.data, state);
  if (focusSlug) events = events.filter((e) => e.eventSlug === focusSlug);
  return { dbStatus: "OK", events };
}

async function runCappedCaptureCycle() {
  // Reuse the existing capped MVP stages; caps/rate-limits preserved.
  const { runBuildWatchlist } = await import("./build-watchlist.mjs");
  const { runCaptureSnapshots } = await import("./capture-snapshots.mjs");
  const { runEntryExitSimulations } = await import("./run-entry-exit-simulations.mjs");
  const { runFunnelLog } = await import("./liquidity-funnel-log.mjs");
  await runBuildWatchlist();
  await runCaptureSnapshots();
  await runEntryExitSimulations();
  await runFunnelLog();
}

export async function runAutoCapture(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const state = readState();
  const { dbStatus, events } = await loadEvents(args, state);

  const plan = buildLiquidityCapturePlan(events, Date.now(), { days: args.days });
  printPlan(plan, dbStatus, args.mode);

  if (args.mode === "plan") return { dbStatus, plan };

  // once / watch need DB to actually capture.
  if (dbStatus === "DB_ENV_MISSING") {
    log("LIQUIDITY_AUTO_CAPTURE_RESULT status=DB_ENV_MISSING action=none");
    return { dbStatus, plan };
  }
  if (dbStatus === "SCHEMA_MISSING") {
    log("LIQUIDITY_AUTO_CAPTURE_RESULT status=SCHEMA_MISSING action=none");
    return { dbStatus, plan };
  }

  const dueNow = plan.dueEvents > 0 || args.force;

  if (args.mode === "once") {
    if (!dueNow) {
      log("LIQUIDITY_AUTO_CAPTURE_RESULT status=NO_EVENT_DUE action=none");
      return { dbStatus, plan };
    }
    await runCappedCaptureCycle();
    const nowIso = new Date().toISOString();
    for (const e of plan.entries) if (e.due) state.captures[e.key] = nowIso;
    writeState(state);
    log("LIQUIDITY_AUTO_CAPTURE_RESULT status=FULL_CAPPED_RUN_FOR_DUE_WINDOW action=captured");
    return { dbStatus, plan };
  }

  if (args.mode === "watch") {
    const deadline = Date.now() + Math.min(args.hours, 2) * 3600 * 1000;
    const tickMs = 10 * 60 * 1000; // re-check at the tightest cadence (10 min)
    while (Date.now() < deadline) {
      const p = buildLiquidityCapturePlan(
        (await loadEvents(args, readState())).events,
        Date.now(),
        { days: args.days },
      );
      if (p.dueEvents > 0 || args.force) {
        await runCappedCaptureCycle();
        const st = readState();
        const nowIso = new Date().toISOString();
        for (const e of p.entries) if (e.due) st.captures[e.key] = nowIso;
        writeState(st);
        log(`LIQUIDITY_AUTO_CAPTURE_WATCH_TICK due=${p.dueEvents} action=captured at=${nowIso}`);
      } else {
        log(`LIQUIDITY_AUTO_CAPTURE_WATCH_TICK due=0 action=idle at=${new Date().toISOString()}`);
      }
      if (Date.now() + tickMs >= deadline) break;
      await new Promise((r) => setTimeout(r, tickMs));
    }
    log("LIQUIDITY_AUTO_CAPTURE_RESULT status=WATCH_COMPLETE action=loop_ended");
    return { dbStatus, plan };
  }

  return { dbStatus, plan };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutoCapture().catch((err) => {
    log(`LIQUIDITY_AUTO_CAPTURE_ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
