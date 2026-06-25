#!/usr/bin/env node
/**
 * Contur3 — canonical live-funnel log (READ-ONLY).
 *
 * One command, one canonical log. Generates:
 *   reports/contur3/live_funnel_latest.md / .json
 *   reports/contur3/live_funnel_<timestamp>.md / .json
 *   reports/contur3/live_funnel_events.ndjson (append-only)
 *
 * SELECT only. Never writes DB, never queues, never places orders.
 *
 * Usage: npm run contur3:live-funnel-log -- [--lookback-hours=24] [--next-hours=12]
 *        [--g2-days=2] [--write|--dry-run] [--allow-no-db]
 */
import {
  parseArgs, collectFunnel, writeReports, printConsoleMarkers,
} from './lib/contur3LiveFunnelMonitor.mjs';

async function main() {
  const opts = parseArgs();
  const j = await collectFunnel(opts);
  const written = writeReports(j, { write: opts.write, json: opts.json, g2: false });
  printConsoleMarkers(j, written);

  if (j.db_available === false && !opts.allowNoDb) {
    console.error('SUPABASE_ENV_MISSING: canonical log skeleton written, but no DB proof. Run on Railway /app.');
    process.exit(2);
  }
}

main().catch((err) => { console.error('live-funnel-log failed:', err); process.exit(1); });
