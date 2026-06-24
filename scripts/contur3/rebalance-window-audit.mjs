#!/usr/bin/env node
/**
 * Contur3 / Blue_model — rebalance window audit.
 *
 * Checks whether all future reservations have a valid rebalance window ahead.
 * Detects MISSED_REBALANCE_WINDOW: reservations that expired without being queued.
 *
 * KEY PRINCIPLE: Process schedule ≠ betting entry window.
 *   Process schedule: continuous 24/7 (canonical Railway cron: * * * * *)
 *   Business entry window: T-70m to T-3m enforced in code (isDueForRebalance)
 *
 * Usage: npm run contur3:rebalance-window-audit
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Exit 0 = no schedule gaps. Exit 1 = REBALANCE_SCHEDULE_GAP_RISK detected.
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

// Mirrors nightWindow.ts — keep in sync.
const REBALANCE_MINUTES_BEFORE_START = 70;
const LATEST_ENTRY_MINUTES_BEFORE = 3;

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function classifyDueWindowState(gameStartIso, nowMs) {
  const startMs = Date.parse(gameStartIso);
  if (!Number.isFinite(startMs)) return 'INVALID_START';
  const minutesToStart = (startMs - nowMs) / 60_000;
  if (minutesToStart > REBALANCE_MINUTES_BEFORE_START) return 'BEFORE_WINDOW';
  if (minutesToStart > LATEST_ENTRY_MINUTES_BEFORE) return 'IN_WINDOW';
  return 'EXPIRED';
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('MISSING_SUPABASE_ENV: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseKey);

  const nowMs = Date.now();
  const generatedAt = new Date().toISOString();
  const timestamp = nowIso();

  console.log(`\n=== REBALANCE WINDOW AUDIT ===`);
  console.log(`generated_at:          ${generatedAt}`);
  console.log(`due_window_open:       T-${REBALANCE_MINUTES_BEFORE_START}m before start`);
  console.log(`due_window_close:      T-${LATEST_ENTRY_MINUTES_BEFORE}m before start`);
  console.log(`process_schedule_rule: continuous 24/7`);
  console.log(`canonical_railway_cron: * * * * * (every 1 min)`);
  console.log(`business_window_rule:  code-level T-70 to T-3 per-event gate\n`);

  const { data: rows, error } = await supabase
    .from('night_event_reservations')
    .select('id,match_family_key,event_title,game_start_iso,status,selection_reason,created_at,plan_run_id')
    .order('game_start_iso', { ascending: true })
    .limit(100);

  if (error) {
    console.error(`QUERY_ERROR: ${error.message}`);
    process.exit(1);
  }

  const reservations = rows ?? [];
  console.log(`reservations_total: ${reservations.length}`);

  const classified = reservations.map(r => {
    const dueWindowState = r.status === 'EXPIRED'
      ? 'EXPIRED'
      : classifyDueWindowState(r.game_start_iso, nowMs);
    const startMs = Date.parse(r.game_start_iso);
    const minutesToStart = Number.isFinite(startMs) ? (startMs - nowMs) / 60_000 : null;
    const dueWindowStartIso = Number.isFinite(startMs)
      ? new Date(startMs - REBALANCE_MINUTES_BEFORE_START * 60_000).toISOString()
      : null;
    const dueWindowEndIso = Number.isFinite(startMs)
      ? new Date(startMs - LATEST_ENTRY_MINUTES_BEFORE * 60_000).toISOString()
      : null;
    return {
      match_family_key: r.match_family_key,
      event_title: r.event_title,
      game_start_iso: r.game_start_iso,
      status: r.status,
      selection_reason: r.selection_reason ?? null,
      due_window_start_iso: dueWindowStartIso,
      due_window_end_iso: dueWindowEndIso,
      due_window_state: dueWindowState,
      minutes_to_start: minutesToStart !== null ? Math.round(minutesToStart) : null,
    };
  });

  const beforeWindow = classified.filter(r => r.due_window_state === 'BEFORE_WINDOW');
  const inWindow    = classified.filter(r => r.due_window_state === 'IN_WINDOW');
  const expired     = classified.filter(r => r.due_window_state === 'EXPIRED');
  const invalidStart = classified.filter(r => r.due_window_state === 'INVALID_START');

  const missedRebalanceCount = expired.length;
  const scheduleGapRisk = missedRebalanceCount > 0;

  console.log(`before_window:         ${beforeWindow.length}`);
  console.log(`in_window (due now):   ${inWindow.length}`);
  console.log(`expired_missed:        ${missedRebalanceCount}`);
  console.log(`invalid_start:         ${invalidStart.length}`);

  let verdict;
  if (scheduleGapRisk) {
    verdict = 'REBALANCE_SCHEDULE_GAP_RISK';
    console.warn(`\nREBALANCE_SCHEDULE_GAP_RISK: ${missedRebalanceCount} reservation(s) expired before rebalance queued them`);
    console.warn(`  ACTION: Verify Railway cron for contur3-event-rebalance-cron`);
    console.warn(`  CANONICAL CRON: * * * * * (every 1 min, continuous 24/7)`);
    console.warn(`  PRINCIPLE: Do NOT restrict cron to daypart windows.`);
    console.warn(`             Business entry window T-70..T-3 is enforced in code.`);
    for (const r of expired) {
      console.warn(`  MISSED: ${r.event_title ?? r.match_family_key} | start=${r.game_start_iso} | due_window_end=${r.due_window_end_iso}`);
    }
  } else if (inWindow.length > 0) {
    verdict = 'IN_WINDOW_REBALANCE_EXPECTED';
    console.log(`\nIN_WINDOW: ${inWindow.length} event(s) are due for rebalance NOW`);
    for (const r of inWindow) {
      console.log(`  DUE: ${r.event_title ?? r.match_family_key} | start=${r.game_start_iso} | minutes_to_start=${r.minutes_to_start}`);
    }
    console.log(`  Run npm run contur3:event-rebalance to create queue rows if not already done.`);
  } else {
    verdict = 'BEFORE_WINDOW_OK';
    if (beforeWindow.length > 0) {
      const next = beforeWindow[0];
      console.log(`\nOK: all reservations BEFORE_WINDOW — no gaps detected`);
      console.log(`  Next due: ${next.event_title ?? next.match_family_key} at ${next.due_window_start_iso}`);
    } else {
      console.log(`\nOK: no reservations in system — no gaps to detect`);
    }
  }

  const report = {
    generated_at: generatedAt,
    rebalance_window: {
      opens_at: `T-${REBALANCE_MINUTES_BEFORE_START}m`,
      closes_at: `T-${LATEST_ENTRY_MINUTES_BEFORE}m`,
      process_schedule: '* * * * * (continuous 24/7)',
      business_window_note: 'Process schedule is continuous; business entry window T-70..T-3 is enforced in code by isDueForRebalance()',
    },
    summary: {
      total: reservations.length,
      before_window: beforeWindow.length,
      in_window: inWindow.length,
      expired_missed: missedRebalanceCount,
      invalid_start: invalidStart.length,
      rebalance_schedule_gap_risk: scheduleGapRisk,
    },
    verdict,
    action: scheduleGapRisk
      ? 'Verify Railway cron: contur3-event-rebalance-cron must run on * * * * * (every 1 min). Check Railway → Service → Settings → Cron. Do NOT use daypart-restricted schedules.'
      : inWindow.length > 0
        ? 'Rebalance window is open. Run npm run contur3:event-rebalance to create queue rows if rebalance cron has not run recently.'
        : 'No action required. All reservations are BEFORE_WINDOW.',
    reservations: classified,
    missed_reservations: expired,
  };

  fs.mkdirSync(LOG_DIR, { recursive: true });

  const jsonPath = path.join(LOG_DIR, `${timestamp}_rebalance_window_audit.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const tableRows = classified.map(r =>
    `| ${r.event_title ?? r.match_family_key ?? '?'} | ${r.game_start_iso ?? '?'} | ${r.status} | ${r.due_window_start_iso ?? '?'} | ${r.due_window_end_iso ?? '?'} | **${r.due_window_state}** |`
  ).join('\n');

  const gapBlock = scheduleGapRisk
    ? `## ⛔ REBALANCE_SCHEDULE_GAP_RISK

**${missedRebalanceCount} reservation(s) expired before rebalance queued them.**

**Root cause:** Railway cron for \`contur3-event-rebalance-cron\` has daypart gaps.

**Fix:**
1. Open Railway → contur3-event-rebalance-cron → Settings → Cron Schedule
2. Set schedule to \`* * * * *\` (every 1 min)
3. Do NOT restrict to daypart windows — process schedule must be continuous 24/7
4. Business entry window T-70..T-3 is enforced in code, not by cron

| Event | Start | Due Window Closes | State |
|-------|-------|-------------------|-------|
${expired.map(r => `| ${r.event_title ?? r.match_family_key} | ${r.game_start_iso} | ${r.due_window_end_iso} | EXPIRED |`).join('\n')}
`
    : inWindow.length > 0
      ? `## ⏳ IN_WINDOW — Rebalance Expected Now

| Event | Start | Minutes to Start |
|-------|-------|-----------------|
${inWindow.map(r => `| ${r.event_title ?? r.match_family_key} | ${r.game_start_iso} | ${r.minutes_to_start} |`).join('\n')}
`
      : `## ✅ OK — No Schedule Gaps

All reservations are BEFORE_WINDOW. Rebalance cron will fire when events enter T-70..T-3 window.
`;

  const md = `# Rebalance Window Audit

**Generated:** ${generatedAt}
**Due window:** T-${REBALANCE_MINUTES_BEFORE_START}m → T-${LATEST_ENTRY_MINUTES_BEFORE}m per event
**Process schedule rule:** Continuous 24/7 (canonical Railway cron: \`* * * * *\`)
**Business entry rule:** \`isDueForRebalance()\` enforces T-70..T-3 gate in code — NOT in cron

## Summary

| State | Count |
|-------|-------|
| BEFORE_WINDOW | ${beforeWindow.length} |
| IN_WINDOW (due now) | ${inWindow.length} |
| EXPIRED (missed) | ${missedRebalanceCount} |
| INVALID_START | ${invalidStart.length} |

**Verdict:** \`${verdict}\`

${gapBlock}

## All Reservations

| Event | Start | DB Status | Due Window Opens | Due Window Closes | Window State |
|-------|-------|-----------|-----------------|-------------------|-------------|
${tableRows || '| (none) | | | | | |'}

## Report

- JSON: \`${jsonPath}\`
`;

  const mdPath = path.join(LOG_DIR, `${timestamp}_rebalance_window_audit.md`);
  fs.writeFileSync(mdPath, md, 'utf8');

  console.log(`\njson: ${jsonPath}`);
  console.log(`md:   ${mdPath}`);
  console.log(`\nVERDICT: ${verdict}`);

  process.exitCode = scheduleGapRisk ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 1000).unref();
}

main().catch(err => {
  console.error(`REBALANCE_WINDOW_AUDIT_FATAL: ${err}`);
  process.exit(1);
});
