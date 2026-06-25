#!/usr/bin/env node
/**
 * Contur3 — 24h preflight gate. Runs the canonical live-funnel log and exits
 * non-zero on any P0 anomaly unless --allow-anomalies. READ-ONLY.
 *
 * Usage: npm run contur3:preflight24h -- [--allow-anomalies] [--allow-no-db]
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
    console.error('SUPABASE_ENV_MISSING: preflight cannot certify readiness without DB. Run on Railway /app.');
    process.exit(2);
  }
  const p0 = (j.anomalies ?? []).filter((a) => a.severity === 'P0');
  if (p0.length > 0 && !opts.allowAnomalies) {
    console.error(`CONTUR3_PREFLIGHT_FAIL p0_anomalies=${p0.length} codes=${p0.map((a) => a.code).join(',')}`);
    process.exit(3);
  }
  console.log('CONTUR3_PREFLIGHT_OK');
}

main().catch((err) => { console.error('preflight24h failed:', err); process.exit(1); });
