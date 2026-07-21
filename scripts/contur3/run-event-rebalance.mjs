#!/usr/bin/env node
/**
 * Contur3 / Blue_model — event rebalance runner.
 * Calls /api/cron/event-rebalance and saves a JSON log.
 * Exit 0 = HTTP ok + response ok=true. Exit 1 = any failure.
 *
 * Also appends one line to the daily battle log:
 *   modeling/fire_runs/contur3-blue-model/contur3_battle_YYYY-MM-DD.jsonl
 * Local file only — Railway filesystem is ephemeral; Supabase is the durable audit.
 */
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://polypropicks.com';
const ENDPOINT = '/api/cron/event-rebalance';
const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

// Controlled one-shot live-intent mode: only ever sent when the operator sets
// this exact environment marker to this exact fixed value. Any other value
// is rejected locally before any request is made -- normal scheduled
// invocation (marker absent) is completely unaffected.
const CONTROLLED_LIVE_TEST_ID = 'founder-live-order-20260721-001';

function resolveControlledLiveIntent() {
  const requested = process.env.CONTROLLED_LIVE_TEST_ID;
  if (requested === undefined) return null;
  if (requested !== CONTROLLED_LIVE_TEST_ID) {
    console.error(
      `CONTROLLED_LIVE_INTENT_ID_MISMATCH: CONTROLLED_LIVE_TEST_ID must be exactly "${CONTROLLED_LIVE_TEST_ID}"`
    );
    process.exit(1);
  }
  return requested;
}

function getSecret() {
  const secret =
    process.env.EXECUTOR_CANDIDATES_SECRET ||
    process.env.EXECUTOR_SECRET ||
    process.env.PPP_SECRET;
  if (!secret) {
    console.error('MISSING_EXECUTOR_SECRET: set EXECUTOR_CANDIDATES_SECRET, EXECUTOR_SECRET, or PPP_SECRET');
    process.exit(1);
  }
  return secret;
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function battleLogPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `contur3_battle_${date}.jsonl`);
}

function appendBattleLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(battleLogPath(), JSON.stringify(entry) + '\n', 'utf8');
    console.log(`CONTUR3_BATTLE_LOG_WRITTEN path=${battleLogPath()}`);
  } catch (err) {
    console.warn(`CONTUR3_BATTLE_LOG_WARN: append failed: ${err}`);
  }
}

async function main() {
  const secret = getSecret();
  const controlledLiveIntent = resolveControlledLiveIntent();
  const timestamp = nowIso();
  const logPath = path.join(LOG_DIR, `${timestamp}_event_rebalance.json`);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  const url = new URL(`${BASE_URL}${ENDPOINT}`);
  if (controlledLiveIntent !== null) {
    url.searchParams.set('controlledLiveIntent', controlledLiveIntent);
    console.log('CONTROLLED_LIVE_INTENT_MODE: sending exact fixed test id only');
  }

  console.log(`POST ${url.toString()}`);

  let res;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-executor-secret': secret,
      },
      body: JSON.stringify({ dryRun: false }),
    });
  } catch (err) {
    const report = { timestamp, error: String(err), endpoint: ENDPOINT };
    fs.writeFileSync(logPath, JSON.stringify(report, null, 2));
    console.error(`FETCH_ERROR: ${err}`);
    console.error(`diagnostic_report_path: ${logPath}`);
    process.exit(1);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    body = { raw: await res.text().catch(() => '') };
  }

  const ok = (body.ok ?? false) === true;
  const expiredCount = body.expired_count ?? body.expiredCount ?? null;
  const futureValidReservationsCount = body.future_valid_reservations_count ?? null;
  const scheduleGapRisk = (expiredCount ?? 0) > 0;
  const report = {
    timestamp,
    endpoint: ENDPOINT,
    http_status: res.status,
    ok,
    due_count: body.due_count ?? body.dueCount ?? null,
    queued_count: body.queued_count ?? body.queuedCount ?? null,
    skipped_count: body.skipped_count ?? body.skippedCount ?? null,
    expired_count: expiredCount,
    future_valid_reservations_count: futureValidReservationsCount,
    rebalance_schedule_gap_risk: scheduleGapRisk,
    next_due_iso: body.next_due_iso ?? body.nextDueIso ?? null,
    outcomes: body.outcomes ?? null,
    body,
  };

  fs.writeFileSync(logPath, JSON.stringify(report, null, 2));

  appendBattleLog({
    timestamp_iso: new Date().toISOString(),
    runner: 'run-event-rebalance',
    endpoint: ENDPOINT,
    http_status: res.status,
    ok,
    due_count: report.due_count,
    queued_count: report.queued_count,
    skipped_count: report.skipped_count,
    expired_count: expiredCount,
    future_valid_reservations_count: futureValidReservationsCount,
    rebalance_schedule_gap_risk: scheduleGapRisk,
    next_due_iso: report.next_due_iso,
    diagnostic_report_path: logPath,
    verdict: ok ? 'REBALANCE_OK' : 'REBALANCE_FAIL',
  });

  console.log(`http_status:          ${report.http_status}`);
  console.log(`ok:                   ${report.ok}`);
  console.log(`due_count:            ${report.due_count}`);
  console.log(`queued_count:         ${report.queued_count}`);
  console.log(`skipped_count:        ${report.skipped_count}`);
  console.log(`expired_count:        ${expiredCount}`);
  console.log(`future_valid_res:     ${futureValidReservationsCount}`);
  console.log(`next_due_iso:         ${report.next_due_iso}`);
  if (scheduleGapRisk) {
    console.warn(`REBALANCE_SCHEDULE_GAP_RISK: expired_count=${expiredCount} reservations expired before rebalance ran — verify Railway cron schedule (canonical: * * * * *)`);
  }
  console.log(`diagnostic_report_path: ${logPath}`);

  if (!res.ok || !report.ok) {
    console.error('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: OK');
}

main();
