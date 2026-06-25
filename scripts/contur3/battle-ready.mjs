#!/usr/bin/env node
/**
 * Contur3 — battle-ready verdict. Runs the canonical funnel log and prints a
 * single battle-readiness verdict line for the next due window. READ-ONLY:
 * it does NOT run reservations or rebalance writes — it reports what the
 * operator must run next. Write-side steps stay explicit and operator-driven.
 *
 * Usage: npm run contur3:battle-ready -- [--allow-no-db]
 */
import {
  parseArgs, collectFunnel, writeReports, printConsoleMarkers,
} from './lib/contur3LiveFunnelMonitor.mjs';

async function main() {
  const opts = parseArgs();
  const j = await collectFunnel(opts);
  const written = writeReports(j, { write: opts.write, json: opts.json, g2: false });
  printConsoleMarkers(j, written);

  const s = j.summary ?? {};
  console.log('\n=== CONTUR3 BATTLE READINESS ===');
  console.log(`machine_verdict:   ${s.machine_verdict}`);
  console.log(`reserved/expected: ${s.reserved_physical_matches}/${s.expected_physical_matches} (target ${s.target_live_slots})`);
  console.log(`fallback_reserved: ${s.fallback_reserved_count}`);
  console.log(`due_now:           ${s.due_now}`);
  console.log(`queued:            ${s.queued}`);
  console.log(`executor_api_vis:  ${s.executor_api_visible}`);
  console.log(`orders:            ${s.orders}`);
  console.log(`hard_anomalies:    ${s.hard_anomaly_count}`);
  const na = (j.next_actions ?? [])[0];
  console.log(`next_action:       ${na ? `[${na.where}] ${na.command}` : '-'}`);
  console.log('ireland_pack:      reports/contur3/ireland_manual_command_pack_latest.md');

  if (j.db_available === false && !opts.allowNoDb) {
    console.error('SUPABASE_ENV_MISSING: battle readiness cannot be certified without DB. Run on Railway /app.');
    process.exit(2);
  }
}

main().catch((err) => { console.error('battle-ready failed:', err); process.exit(1); });
