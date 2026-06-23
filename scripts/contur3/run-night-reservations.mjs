#!/usr/bin/env node
/**
 * Contur3 / Blue_model — night event reservations runner.
 * Calls /api/cron/night-event-reservations and saves a JSON log.
 * Exit 0 = HTTP ok + response ok=true. Exit 1 = any failure.
 */
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://polypropicks.com';
const ENDPOINT = '/api/cron/night-event-reservations';
const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

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

async function main() {
  const secret = getSecret();
  const timestamp = nowIso();
  const logPath = path.join(LOG_DIR, `${timestamp}_night_reservations.json`);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  console.log(`POST ${BASE_URL}${ENDPOINT}`);

  let res;
  try {
    res = await fetch(`${BASE_URL}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-executor-secret': secret,
      },
      body: JSON.stringify({ forceRebuild: 'CEO_APPROVED' }),
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
    endpoint: ENDPOINT,
    http_status: res.status,
    ok: body.ok ?? false,
    plan_run_id: body.plan_run_id ?? null,
    reserved_count: body.reserved_count ?? body.reservedCount ?? null,
    skipped_count: body.skipped_count ?? body.skippedCount ?? null,
    active_future_count: body.active_future_count ?? body.activeFutureCount ?? null,
    needs_rebuild: body.needs_rebuild ?? body.needsRebuild ?? null,
    body,
  };

  fs.writeFileSync(logPath, JSON.stringify(report, null, 2));

  console.log(`http_status:          ${report.http_status}`);
  console.log(`ok:                   ${report.ok}`);
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
