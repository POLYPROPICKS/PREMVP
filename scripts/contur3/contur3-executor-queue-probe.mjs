#!/usr/bin/env node
/**
 * Contur3 — executor queue consumer dry-run probe (READ-ONLY).
 *
 * Simulates the external consumer handoff (Ireland / manual) against
 * GET /api/executor/queue only. Never POSTs, never marks, never rebalances,
 * never reserves, never writes DB.
 *
 * Env:
 *   EXECUTOR_BASE_URL or NEXT_PUBLIC_SITE_URL — base URL of the deployment.
 *   EXECUTOR_CANDIDATES_SECRET — sent as x-executor-secret header (never logged).
 */

import { buildExecutorQueueUrl, classifyExecutorQueueProbe } from './lib/contur3ExecutorQueueProbe.mjs';

const baseUrl = process.env.EXECUTOR_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || '';
const secret = process.env.EXECUTOR_CANDIDATES_SECRET || '';
const authConfigured = secret.length > 0;

async function main() {
  console.log('CONTUR3_EXECUTOR_QUEUE_PROBE_START');

  if (!baseUrl) {
    console.log('CONTUR3_EXECUTOR_QUEUE_PROBE_SUMMARY verdict=QUEUE_PROBE_MISCONFIGURED_BASE_URL http=null rows=0 actionable=0 window_closed=0 auth_configured=' + authConfigured);
    console.log('CONTUR3_EXECUTOR_QUEUE_PROBE_END');
    process.exitCode = 1;
    return;
  }

  const url = buildExecutorQueueUrl({ baseUrl, dryRun: true, includeUpcoming: true });
  const now = Date.now();
  let statusCode = null;
  let rows = [];

  try {
    const headers = authConfigured ? { 'x-executor-secret': secret } : {};
    const res = await fetch(url, { method: 'GET', headers });
    statusCode = res.status;
    const body = await res.json().catch(() => null);
    rows = Array.isArray(body?.candidates) ? body.candidates : [];
  } catch (err) {
    console.log('CONTUR3_EXECUTOR_QUEUE_PROBE_SUMMARY verdict=QUEUE_PROBE_API_ERROR http=null rows=0 actionable=0 window_closed=0 auth_configured=' + authConfigured);
    console.log('CONTUR3_EXECUTOR_QUEUE_PROBE_END');
    process.exitCode = 1;
    return;
  }

  const result = classifyExecutorQueueProbe({ rows, statusCode, authConfigured, now });
  const { verdict, summary } = result;

  console.log(
    `CONTUR3_EXECUTOR_QUEUE_PROBE_SUMMARY verdict=${verdict} http=${statusCode} rows=${summary.total} actionable=${summary.actionable} window_closed=${summary.window_closed} auth_configured=${authConfigured}`
  );

  for (const row of rows) {
    console.log(
      `CONTUR3_EXECUTOR_QUEUE_PROBE_ROWS event=${row.event_slug ?? 'unknown'} latest_entry_iso=${row.latest_entry_iso ?? 'unknown'} entry_state=${row.entry_state ?? 'unknown'}`
    );
  }

  console.log('CONTUR3_EXECUTOR_QUEUE_PROBE_END');

  process.exitCode = verdict === 'QUEUE_PROBE_READY_ROWS_VISIBLE'
    || verdict === 'QUEUE_PROBE_NO_READY_ROWS'
    || verdict === 'QUEUE_PROBE_READY_ROWS_WINDOW_CLOSED'
    ? 0
    : 1;
}

main();
