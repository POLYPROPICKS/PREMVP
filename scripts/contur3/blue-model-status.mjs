#!/usr/bin/env node
/**
 * Contur3 / Blue_model — status check.
 * Read-only: reads queue + dryRun rebalance. Does NOT forceRebuild.
 * Prints one verdict: BLUE_MODEL_GO_READY | BLUE_MODEL_ARMED_WAITING | BLUE_MODEL_NO_GO
 */
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://polypropicks.com';
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

async function fetchJson(url, options) {
  try {
    const res = await fetch(url, options);
    let body;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: String(err) };
  }
}

async function main() {
  const secret = getSecret();
  const timestamp = nowIso();
  const logPath = path.join(LOG_DIR, `${timestamp}_blue_model_status.json`);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  const headers = {
    'Content-Type': 'application/json',
    'x-executor-secret': secret,
  };

  console.log('Fetching queue and rebalance dryRun...');

  const [queueResult, rebalanceResult] = await Promise.all([
    fetchJson(`${BASE_URL}/api/executor/queue?includeUpcoming=1`, { headers }),
    fetchJson(`${BASE_URL}/api/cron/event-rebalance`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ dryRun: true }),
    }),
  ]);

  const queueBody = queueResult.body ?? {};
  const rebalanceBody = rebalanceResult.body ?? {};

  const candidates = queueBody.candidates ?? queueBody.queue ?? [];
  const candidateCount = Array.isArray(candidates) ? candidates.length : (queueBody.candidate_count ?? 0);
  const queueSource = queueBody.source ?? queueBody.queue_source ?? null;
  const nextDueIso = queueBody.next_due_iso ?? queueBody.nextDueIso ?? rebalanceBody.next_due_iso ?? null;
  const nextDueReservation = queueBody.next_due_reservation ?? queueBody.nextDueReservation ?? null;

  // Ireland contract: check top-level queueBody first, then first candidate
  let irelandContract = null;
  if (queueBody.ireland_contract && typeof queueBody.ireland_contract === 'object') {
    irelandContract = queueBody.ireland_contract;
  } else if (Array.isArray(candidates) && candidates.length > 0) {
    const c = candidates[0];
    irelandContract = {
      market_id: c.market_id ?? c.marketId ?? null,
      side: c.side ?? null,
      stake_usd: c.stake_usd ?? c.stakeUsd ?? null,
      event_start_iso: c.event_start_iso ?? c.eventStartIso ?? null,
      source: c.source ?? null,
    };
  }

  const errors = [];
  if (!queueResult.ok) errors.push(`queue_fetch_failed: HTTP ${queueResult.status}${queueResult.error ? ' ' + queueResult.error : ''}`);
  if (!rebalanceResult.ok) errors.push(`rebalance_drynrun_failed: HTTP ${rebalanceResult.status}${rebalanceResult.error ? ' ' + rebalanceResult.error : ''}`);

  const isValidSource = queueSource === 'event_execution_queue';
  const hasContract = irelandContract !== null &&
    irelandContract.market_id !== null &&
    irelandContract.side !== null &&
    irelandContract.stake_usd !== null;

  let verdict;
  if (!queueResult.ok || (!isValidSource && queueSource !== null && candidateCount > 0)) {
    verdict = 'BLUE_MODEL_NO_GO';
  } else if (candidateCount >= 1 && isValidSource && hasContract) {
    verdict = 'BLUE_MODEL_GO_READY';
  } else if (candidateCount === 0 && nextDueIso) {
    verdict = 'BLUE_MODEL_ARMED_WAITING';
  } else if (candidateCount === 0 && !nextDueIso) {
    verdict = 'BLUE_MODEL_ARMED_WAITING';
  } else {
    verdict = 'BLUE_MODEL_NO_GO';
  }

  const report = {
    generated_at_iso: new Date().toISOString(),
    verdict,
    queue: {
      http_status: queueResult.status,
      ok: queueResult.ok,
      candidate_count: candidateCount,
      source: queueSource,
    },
    next_due_iso: nextDueIso,
    next_due_reservation: nextDueReservation,
    ireland_contract: irelandContract,
    rebalance_dry_run: {
      http_status: rebalanceResult.status,
      ok: rebalanceResult.ok,
      due_count: rebalanceBody.due_count ?? rebalanceBody.dueCount ?? null,
      queued_count: rebalanceBody.queued_count ?? rebalanceBody.queuedCount ?? null,
      skipped_count: rebalanceBody.skipped_count ?? rebalanceBody.skippedCount ?? null,
      next_due_iso: rebalanceBody.next_due_iso ?? rebalanceBody.nextDueIso ?? null,
    },
    errors,
    diagnostic_report_path: logPath,
  };

  fs.writeFileSync(logPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`queue http_status:    ${report.queue.http_status}`);
  console.log(`queue source:         ${report.queue.source}`);
  console.log(`candidate_count:      ${report.queue.candidate_count}`);
  console.log(`next_due_iso:         ${report.next_due_iso}`);
  console.log(`next_due_reservation: ${report.next_due_reservation != null ? JSON.stringify(report.next_due_reservation, null, 2) : 'MISSING'}`);
  console.log(`ireland_contract:     ${report.ireland_contract != null ? JSON.stringify(report.ireland_contract, null, 2) : 'MISSING'}`);
  console.log(`rebalance dryRun ok:  ${report.rebalance_dry_run.ok}`);
  if (errors.length) console.log(`errors:               ${errors.join('; ')}`);
  console.log(`diagnostic_report_path: ${logPath}`);
  console.log('');
  console.log(`VERDICT: ${verdict}`);

  // Set exit code without calling process.exit() immediately.
  // This lets the undici connection pool drain naturally and avoids the
  // Windows libuv assertion (UV_HANDLE_CLOSING) that fires when process.exit()
  // is called while fetch handles are still in a closing state.
  process.exitCode = verdict === 'BLUE_MODEL_NO_GO' ? 1 : 0;

  // Unref'd timeout: exits as soon as the event loop is empty, or after 3s max.
  setTimeout(() => process.exit(process.exitCode), 3000).unref();
}

main();
