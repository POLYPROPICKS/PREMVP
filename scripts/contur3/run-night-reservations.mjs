#!/usr/bin/env node
/**
 * Contur3 / Blue_model — night event reservations runner.
 * Calls /api/cron/night-event-reservations and saves a JSON log.
 * Exit 0 = HTTP ok + response ok=true. Exit 1 = any failure.
 *
 * Also appends one line to the daily battle log:
 *   modeling/fire_runs/contur3-blue-model/contur3_battle_YYYY-MM-DD.jsonl
 * Local file only — Railway filesystem is ephemeral; Supabase is the durable audit.
 *
 * Testability: resolveForceRebuildMode(), buildReservationRequestUrl(), and
 * runNightReservations() are pure/injectable and exported so tests can import
 * this module without ever executing main() or reaching a real network. main()
 * only runs when this file is executed directly as the script entrypoint.
 */
import fs from 'fs';
import path from 'path';

export const BASE_URL = 'https://polypropicks.com';
export const ENDPOINT = '/api/cron/night-event-reservations';
const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

// Force rebuild deletes existing reservations/queue rows before replacing
// them -- it must never be the default. Ordinary/scheduled invocation is
// always NORMAL (no forceRebuild param). Force mode requires this exact
// explicit operator marker; any other value is rejected locally before any
// network request is made.
export const FORCE_REBUILD_MARKER = 'CEO_APPROVED';

/**
 * Pure: decide execution mode from env only. No I/O, no process.exit.
 * @param {Record<string, string | undefined>} env
 */
export function resolveForceRebuildMode(env = process.env) {
  const requested = env.CONTUR3_FORCE_REBUILD;
  if (requested === undefined) return { forceRebuild: false, mode: 'NORMAL', error: null };
  if (requested !== FORCE_REBUILD_MARKER) {
    return {
      forceRebuild: false,
      mode: null,
      error: `FORCE_REBUILD_MARKER_MISMATCH: CONTUR3_FORCE_REBUILD must be exactly "${FORCE_REBUILD_MARKER}"`,
    };
  }
  return { forceRebuild: true, mode: 'FORCE_REBUILD_EXPLICIT', error: null };
}

/** Pure: build the exact request URL. No I/O. */
export function buildReservationRequestUrl(baseUrl, forceRebuild) {
  const url = new URL(`${baseUrl}${ENDPOINT}`);
  if (forceRebuild) {
    url.searchParams.set('forceRebuild', FORCE_REBUILD_MARKER);
  }
  return url;
}

/** @param {Record<string, string | undefined>} env */
function getSecret(env = process.env) {
  return env.EXECUTOR_CANDIDATES_SECRET || env.EXECUTOR_SECRET || env.PPP_SECRET || null;
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

/**
 * Full orchestration, injectable for tests. fetchImpl defaults to the global
 * fetch (real network) only when not supplied -- tests always supply a mock
 * and must never reach this default. Returns a result object instead of
 * calling process.exit so tests can assert on outcomes directly; the real
 * script entrypoint (main()) is the only caller that translates the result
 * into a process exit code.
 * @param {{ fetchImpl?: (url: string, init?: RequestInit) => Promise<{ ok: boolean, status: number, json: () => Promise<any>, text: () => Promise<string> }>, env?: Record<string, string | undefined>, baseUrl?: string, writeLogs?: boolean }} [opts]
 */
export async function runNightReservations({
  fetchImpl,
  env = process.env,
  baseUrl = BASE_URL,
  writeLogs = true,
} = {}) {
  const secret = getSecret(env);
  if (!secret) {
    return { exitCode: 1, reason: 'MISSING_EXECUTOR_SECRET', mode: null, fetchCalled: false };
  }

  const { forceRebuild, mode, error } = resolveForceRebuildMode(env);
  if (error) {
    return { exitCode: 1, reason: error, mode: null, fetchCalled: false };
  }

  const timestamp = nowIso();
  const logPath = path.join(LOG_DIR, `${timestamp}_night_reservations.json`);
  if (writeLogs) fs.mkdirSync(LOG_DIR, { recursive: true });

  console.log(`execution_mode: ${mode}`);

  const url = buildReservationRequestUrl(baseUrl, forceRebuild);
  console.log(`POST ${url.toString()}`);

  if (typeof fetchImpl !== 'function') {
    // Safety net: never silently fall back to a real network call if a
    // caller forgets to inject fetchImpl (e.g. from a test).
    throw new Error('runNightReservations requires an injected fetchImpl (no implicit network fetch)');
  }

  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-executor-secret': secret,
      },
      body: JSON.stringify({}),
    });
  } catch (err) {
    if (writeLogs) {
      const report = { timestamp, error: String(err), endpoint: ENDPOINT };
      fs.writeFileSync(logPath, JSON.stringify(report, null, 2));
    }
    console.error(`FETCH_ERROR: ${err}`);
    return { exitCode: 1, reason: 'FETCH_ERROR', mode, fetchCalled: true, logPath };
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

  if (writeLogs) fs.writeFileSync(logPath, JSON.stringify(report, null, 2));

  const ok = res.ok && report.ok === true;
  if (writeLogs) {
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
  }

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
    return { exitCode: 1, reason: 'RESULT_FAIL', mode, fetchCalled: true, report, logPath };
  }
  console.log('RESULT: OK');
  return { exitCode: 0, reason: 'OK', mode, fetchCalled: true, report, logPath };
}

async function main() {
  const result = await runNightReservations({ fetchImpl: globalThis.fetch });
  if (result.reason === 'MISSING_EXECUTOR_SECRET') {
    console.error('MISSING_EXECUTOR_SECRET: set EXECUTOR_CANDIDATES_SECRET, EXECUTOR_SECRET, or PPP_SECRET');
  } else if (result.mode === null && result.reason) {
    console.error(result.reason);
  }
  if (result.logPath) console.error(`diagnostic_report_path: ${result.logPath}`);
  process.exit(result.exitCode);
}

// Only run as a real network-facing script when executed directly, never on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
