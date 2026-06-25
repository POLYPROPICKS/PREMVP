#!/usr/bin/env node
/**
 * Contur3 — G2 rollup log (last 24h / yesterday / day-before, Minsk). READ-ONLY.
 * Writes reports/contur3/live_funnel_g2_latest.md (+ timestamped) plus the
 * canonical funnel log.
 *
 * Usage: npm run contur3:g2-log -- [--g2-days=2] [--allow-no-db]
 */
import {
  parseArgs, collectG2, writeReports, printConsoleMarkers,
} from './lib/contur3LiveFunnelMonitor.mjs';

async function main() {
  const opts = parseArgs();
  const j = await collectG2(opts);
  const written = writeReports(j, { write: opts.write, json: opts.json, g2: true });
  printConsoleMarkers(j, written);
  if (j.db_available === false && !opts.allowNoDb) {
    console.error('SUPABASE_ENV_MISSING: G2 skeleton written, but no DB proof. Run on Railway /app.');
    process.exit(2);
  }
}

main().catch((err) => { console.error('g2-log failed:', err); process.exit(1); });
