#!/usr/bin/env node
/**
 * Contur3 / Blue_model — ops report email runner.
 * Spawns founder-email-dispatcher.ts --mode=morning and saves a result log.
 * This is a monitoring rail — NOT an execution gate.
 * Exit 0 = email pipeline succeeded. Exit 1 = any failure.
 *
 * Pipeline sequence (deterministic, filesystem-first):
 *   1. resolve:signals:live-priority  — refreshes generated_signal_pairs
 *   2. resolve:signals:cron           — resolves expired signals
 *   3. verify:resolver-pipeline       — validates resolver state
 *   4. morning:model-report           — fetches DB, writes CSV/MD/XLSX artifacts, then sends email
 *
 * Required Railway env vars (NO executor secret needed — pipeline is CLI-only):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — DB access for signal/report scripts
 *   RESEND_API_KEY                           — Resend email transport
 *   EMAIL_FROM                               — verified sender address
 *   MORNING_MODEL_EMAIL_TO or FOUNDER_EMAIL_TO  — optional; defaults to alexgrushin@gmail.com
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'EMAIL_FROM',
];

function getMissingEnv() {
  return REQUIRED_ENV.filter((k) => !process.env[k]);
}

function redactSecrets(text) {
  if (!text) return text;
  return text.replace(/([A-Za-z0-9_\-]{32,})/g, (m) => {
    if (/^[A-Z_]+$/.test(m)) return m;
    return m.slice(0, 6) + '***REDACTED***';
  });
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

async function main() {
  const missingEnv = getMissingEnv();

  const timestamp = nowIso();
  const logPath = path.join(LOG_DIR, `${timestamp}_ops_report_email.json`);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (missingEnv.length > 0) {
    const verdict = 'OPS_EMAIL_CODE_VALIDATED_RUNTIME_ENV_PENDING';
    console.error(verdict);
    console.error(`missing_env_names: ${missingEnv.join(', ')}`);
    console.error('Set these in Railway → ops-report-email-cron → Variables before running.');

    const report = {
      timestamp,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      pipeline: 'tsx scripts/founder-email-dispatcher.ts --mode=morning',
      exit_code: 1,
      ok: false,
      phase: 'preflight_failed',
      verdict,
      missing_env_names: missingEnv,
      error: `Missing required env vars: ${missingEnv.join(', ')}`,
      note: 'Monitoring rail only — not an execution gate.',
      diagnostic_report_path: logPath,
    };

    fs.writeFileSync(logPath, JSON.stringify(report, null, 2));
    console.error(`diagnostic_report_path: ${logPath}`);
    process.exit(1);
  }

  console.log('OPS_REPORT_EMAIL_STARTING');
  console.log('pipeline: tsx scripts/founder-email-dispatcher.ts --mode=morning');
  const started_at = new Date().toISOString();

  const result = spawnSync(
    'tsx',
    ['scripts/founder-email-dispatcher.ts', '--mode=morning'],
    { cwd: process.cwd(), encoding: 'utf8', shell: false },
  );

  const finished_at = new Date().toISOString();
  const exitCode = result.status ?? 1;
  const ok = exitCode === 0;

  // Print captured output so Railway logs show it
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const report = {
    timestamp,
    started_at,
    finished_at,
    pipeline: 'tsx scripts/founder-email-dispatcher.ts --mode=morning',
    exit_code: exitCode,
    ok,
    phase: ok ? 'complete' : 'pipeline_failed',
    verdict: ok ? 'OPS_REPORT_EMAIL_OK' : 'OPS_REPORT_EMAIL_FAIL',
    missing_env_names: [],
    stdout: redactSecrets(result.stdout ?? '').slice(0, 6000),
    stderr: redactSecrets(result.stderr ?? '').slice(0, 6000),
    error: result.error ? String(result.error) : null,
    note: 'Monitoring rail only — not an execution gate. If email fails inspect this JSON report.',
    diagnostic_report_path: logPath,
  };

  fs.writeFileSync(logPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`exit_code:              ${exitCode}`);
  console.log(`diagnostic_report_path: ${logPath}`);
  console.log('');

  if (ok) {
    console.log('OPS_REPORT_EMAIL_OK');
  } else {
    console.error(`OPS_REPORT_EMAIL_FAIL (exit_code=${exitCode})`);
  }

  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 500).unref();
}

main();
