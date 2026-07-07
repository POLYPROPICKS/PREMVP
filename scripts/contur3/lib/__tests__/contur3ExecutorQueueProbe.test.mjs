import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecutorQueueUrl,
  summarizeExecutorQueueRows,
  classifyExecutorQueueProbe,
} from '../contur3ExecutorQueueProbe.mjs';

test('buildExecutorQueueUrl builds read-only queue URL', () => {
  const url = buildExecutorQueueUrl({ baseUrl: 'https://example.com', dryRun: true, includeUpcoming: true });
  assert.match(url, /\/api\/executor\/queue/);
  assert.match(url, /dry=1/);
  assert.match(url, /includeUpcoming=1/);
});

test('probe does not create write URLs', () => {
  const url = buildExecutorQueueUrl({ baseUrl: 'https://example.com', dryRun: true, includeUpcoming: true });
  assert.doesNotMatch(url, /queue\/mark/);
  assert.doesNotMatch(url, /order-events/);
  assert.doesNotMatch(url, /rebalance/);
  assert.doesNotMatch(url, /reservation/);
});

test('classify probe auth missing', () => {
  const verdict = classifyExecutorQueueProbe({
    rows: [],
    statusCode: null,
    authConfigured: false,
    now: Date.now(),
  });
  assert.equal(verdict.verdict, 'QUEUE_PROBE_AUTH_MISSING');
});

test('classify visible actionable rows', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const rows = [
    { latest_entry_iso: '2026-07-07T13:00:00Z' },
    { latest_entry_iso: '2026-07-07T11:00:00Z' },
  ];
  const summary = summarizeExecutorQueueRows(rows, now);
  assert.equal(summary.actionable, 1);
  assert.equal(summary.window_closed, 1);

  const verdict = classifyExecutorQueueProbe({ rows, statusCode: 200, authConfigured: true, now });
  assert.equal(verdict.verdict, 'QUEUE_PROBE_READY_ROWS_VISIBLE');
});

test('classify ready rows window closed', () => {
  const now = Date.parse('2026-07-07T12:00:00Z');
  const rows = [
    { latest_entry_iso: '2026-07-07T11:00:00Z' },
    { latest_entry_iso: '2026-07-07T10:00:00Z' },
  ];
  const verdict = classifyExecutorQueueProbe({ rows, statusCode: 200, authConfigured: true, now });
  assert.equal(verdict.verdict, 'QUEUE_PROBE_READY_ROWS_WINDOW_CLOSED');
});

test('classify no rows', () => {
  const verdict = classifyExecutorQueueProbe({ rows: [], statusCode: 200, authConfigured: true, now: Date.now() });
  assert.equal(verdict.verdict, 'QUEUE_PROBE_NO_READY_ROWS');
});

test('classify auth failed', () => {
  const verdict401 = classifyExecutorQueueProbe({ rows: [], statusCode: 401, authConfigured: true, now: Date.now() });
  assert.equal(verdict401.verdict, 'QUEUE_PROBE_AUTH_FAILED');
  const verdict403 = classifyExecutorQueueProbe({ rows: [], statusCode: 403, authConfigured: true, now: Date.now() });
  assert.equal(verdict403.verdict, 'QUEUE_PROBE_AUTH_FAILED');
});

test('classify API error', () => {
  const verdict = classifyExecutorQueueProbe({ rows: [], statusCode: 500, authConfigured: true, now: Date.now() });
  assert.equal(verdict.verdict, 'QUEUE_PROBE_API_ERROR');
});
