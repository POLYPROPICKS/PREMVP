#!/usr/bin/env node
/**
 * Contur3 / Blue_model — night event reservations runner.
 * Calls /api/cron/night-event-reservations and saves a JSON log.
 * Exit 0 = HTTP ok + response ok=true. Exit 1 = any failure.
 *
 * Also appends one line to the daily battle log:
 *   modeling/fire_runs/contur3-blue-model/contur3_battle_YYYY-MM-DD.jsonl
 * Local file only — Railway filesystem is ephemeral; Supabase is the durable audit.
 */
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://polypropicks.com';
const ENDPOINT = '/api/cron/night-event-reservations';
const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

// Force rebuild deletes existing reservations/queue rows before replacing
// them -- it must never be the default. Ordinary/scheduled invocation is
// always NORMAL (no forceRebuild param). Force mode requires this exact
// explicit operator marker; any other value is rejected locally before any
// network request is made.
const FORCE_REBUILD_MARKER = 'CEO_APPROVED';

function resolveForceRebuildMode() {
  const requested = process.env.CONTUR3_FORCE_REBUILD;
  if (requested === undefined) return { forceRebuild: false, mode: 'NORMAL' };
  if (requested !== FORCE_REBUILD_MARKER) {
    console.error(
      `FORCE_REBUILD_MARKER_MISMATCH: CONTUR3_FORCE_REBUILD must be exactly "${FORCE_REBUILD_MARKER}"`
    );
    process.exit(1);
  }
  return { forceRebuild: true, mode: 'FORCE_REBUILD_EXPLICIT' };
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
  const { forceRebuild, mode } = resolveForceRebuildMode();
  const timestamp = nowIso();
  const logPath = path.join(LOG_DIR, `${timestamp}_night_reservations.json`);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  console.log(`execution_mode: ${mode}`);

  // forceRebuild must be a URL query param — route.ts reads searchParams, not the body.
  const url = new URL(`${BASE_URL}${ENDPOINT}`);
  if (forceRebuild) {
    url.searchParams.set('forceRebuild', FORCE_REBUILD_MARKER);
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
      body: JSON.stringify({}),
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

  const report = {
    timestamp,
    execution_mode: mode,
    endpoint: ENDPOINT,
    http_status: res.status,
    ok: body.ok ?? false,
    result: body.result ?? null,
    plan_run_id: body.plan_run_id ?? null,
    reserved_count: body.reserved_count ?? body.reservedCount ?? null,
    skipped_count: body.skipped_count ?? body.skippedCount ?? null,
    active_future_count: body.active_future_count ?? body.activeFutureCount ?? null,
    needs_rebuild: body.needs_rebuild ?? body.needsRebuild ?? null,
    body,
  };

  fs.writeFileSync(logPath, JSON.stringify(report, null, 2));

  const ok = res.ok && (report.ok === true);
  appendBattleLog({
    timestamp_iso: new Date().toISOString(),
    runner: 'run-night-reservations',
    endpoint: ENDPOINT,
    http_status: res.status,
    ok,
    plan_run_id: report.plan_run_id,
    reserved_count: report.reserved_count,
    skipped_count: report.skipped_count,
    next_due_iso: null,
    diagnostic_report_path: logPath,
    verdict: ok ? 'NIGHT_RESERVATIONS_OK' : 'NIGHT_RESERVATIONS_FAIL',
  });

  console.log(`http_status:          ${report.http_status}`);
  console.log(`ok:                   ${report.ok}`);
  console.log(`result:               ${report.result}`);
  console.log(`plan_run_id:          ${report.plan_run_id}`);
  console.log(`reserved_count:       ${report.reserved_count}`);
  console.log(`skipped_count:        ${report.skipped_count}`);
  console.log(`active_future_count:  ${report.active_future_count}`);
  console.log(`needs_rebuild:        ${report.needs_rebuild}`);
  console.log(`diagnostic_report_path: ${logPath}`);

  if (!res.ok || !report.ok) {
    console.error('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: OK');
}

main();
