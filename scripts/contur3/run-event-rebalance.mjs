#!/usr/bin/env node
/**
 * Contur3 / Blue_model — event rebalance runner.
 * Calls /api/cron/event-rebalance and saves a JSON log.
 * Exit 0 = HTTP ok + response ok=true. Exit 1 = any failure.
 */
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://polypropicks.com';
const ENDPOINT = '/api/cron/event-rebalance';
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
  const logPath = path.join(LOG_DIR, `${timestamp}_event_rebalance.json`);

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

  const report = {
    timestamp,
    endpoint: ENDPOINT,
    http_status: res.status,
    ok: body.ok ?? false,
    due_count: body.due_count ?? body.dueCount ?? null,
    queued_count: body.queued_count ?? body.queuedCount ?? null,
    skipped_count: body.skipped_count ?? body.skippedCount ?? null,
    next_due_iso: body.next_due_iso ?? body.nextDueIso ?? null,
    body,
  };

  fs.writeFileSync(logPath, JSON.stringify(report, null, 2));

  console.log(`http_status:          ${report.http_status}`);
  console.log(`ok:                   ${report.ok}`);
  console.log(`due_count:            ${report.due_count}`);
  console.log(`queued_count:         ${report.queued_count}`);
  console.log(`skipped_count:        ${report.skipped_count}`);
  console.log(`next_due_iso:         ${report.next_due_iso}`);
  console.log(`diagnostic_report_path: ${logPath}`);

  if (!res.ok || !report.ok) {
    console.error('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: OK');
}

main();
