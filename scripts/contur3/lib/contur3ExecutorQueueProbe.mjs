/**
 * Contur3 — executor queue consumer dry-run probe (READ-ONLY).
 *
 * Pure helpers only: no fetch, no DB, no writes. Simulates what an Ireland /
 * manual consumer would see from GET /api/executor/queue without ever
 * calling a write endpoint (queue/mark, order-events, rebalance, reservation).
 */

export function buildExecutorQueueUrl({ baseUrl, dryRun = false, includeUpcoming = false }) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const url = new URL(`${base}/api/executor/queue`);
  if (dryRun) url.searchParams.set('dry', '1');
  if (includeUpcoming) url.searchParams.set('includeUpcoming', '1');
  return url.toString();
}

export function summarizeExecutorQueueRows(rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  let actionable = 0;
  let windowClosed = 0;
  for (const row of list) {
    const latestMs = Date.parse(row?.latest_entry_iso ?? '');
    if (Number.isFinite(latestMs) && latestMs > now) {
      actionable += 1;
    } else {
      windowClosed += 1;
    }
  }
  return { total: list.length, actionable, window_closed: windowClosed };
}

export function classifyExecutorQueueProbe({ rows, statusCode, authConfigured, now = Date.now() }) {
  if (!authConfigured) {
    return { verdict: 'QUEUE_PROBE_AUTH_MISSING', summary: summarizeExecutorQueueRows(rows, now) };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { verdict: 'QUEUE_PROBE_AUTH_FAILED', summary: summarizeExecutorQueueRows(rows, now) };
  }
  if (statusCode !== 200) {
    return { verdict: 'QUEUE_PROBE_API_ERROR', summary: summarizeExecutorQueueRows(rows, now) };
  }

  const summary = summarizeExecutorQueueRows(rows, now);
  if (summary.total === 0) {
    return { verdict: 'QUEUE_PROBE_NO_READY_ROWS', summary };
  }
  if (summary.actionable > 0) {
    return { verdict: 'QUEUE_PROBE_READY_ROWS_VISIBLE', summary };
  }
  return { verdict: 'QUEUE_PROBE_READY_ROWS_WINDOW_CLOSED', summary };
}
