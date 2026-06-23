#!/usr/bin/env node
/**
 * Contur3 / Blue_model — ops report email runner.
 * Spawns founder-email-dispatcher.ts --mode=morning and saves a result log.
 * This is a monitoring rail — NOT an execution gate.
 * Exit 0 = email pipeline succeeded. Exit 1 = any failure.
 *
 * Canonical CLI: tsx scripts/founder-email-dispatcher.ts --mode=morning
 * No HTTP endpoint exists for this pipeline; it runs as a Railway cron via CLI.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

const REQUIRED_EMAIL_ENV = ['RESEND_API_KEY', 'EMAIL_FROM'];
const REQUIRED_RUNNER_ENV = ['EXECUTOR_CANDIDATES_SECRET', 'EXECUTOR_SECRET', 'PPP_SECRET'];

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

function getMissingEmailEnv() {
  return REQUIRED_EMAIL_ENV.filter((k) => !process.env[k]);
}

function redactSecrets(text) {
  if (!text) return text;
  // Redact anything that looks like an API key or token (long alphanumeric strings)
  return text.replace(/([A-Za-z0-9_-]{32,})/g, (m) => {
    // Keep short env var names intact; redact long values
    if (/^[A-Z_]+$/.test(m)) return m;
    return m.slice(0, 6) + '***REDACTED***';
  });
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

async function main() {
  getSecret(); // fast-fail if no runner secret

  const missingEmailEnv = getMissingEmailEnv();

  const timestamp = nowIso();
  const logPath = path.join(LOG_DIR, `${timestamp}_ops_report_email.json`);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (missingEmailEnv.length > 0) {
    console.error(`OPS_EMAIL_CODE_VALIDATED_RUNTIME_ENV_PENDING`);
    console.error(`missing_env_names: ${missingEmailEnv.join(', ')}`);
    console.error('Set these in Railway → service → Variables before running ops email cron.');

    const report = {
      timestamp,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      pipeline: 'tsx scripts/founder-email-dispatcher.ts --mode=morning',
      exit_code: 1,
      ok: false,
      verdict: 'OPS_EMAIL_CODE_VALIDATED_RUNTIME_ENV_PENDING',
      missing_env_names: missingEmailEnv,
      error: `Missing required env vars: ${missingEmailEnv.join(', ')}`,
      note: 'Monitoring rail only — not an execution gate.',
      diagnostic_report_path: logPath,
    };

    fs.writeFileSync(logPath, JSON.stringify(report, null, 2));
    console.log(`diagnostic_report_path: ${logPath}`);
    process.exit(1);
  }

  console.log('Running ops-report-email pipeline: tsx scripts/founder-email-dispatcher.ts --mode=morning');
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
    verdict: ok ? 'OPS_REPORT_EMAIL_OK' : 'OPS_REPORT_EMAIL_FAIL',
    missing_env_names: [],
    stdout: redactSecrets(result.stdout ?? '').slice(0, 4000),
    stderr: redactSecrets(result.stderr ?? '').slice(0, 4000),
    error: result.error ? String(result.error) : null,
    note: 'Monitoring rail only — not an execution gate. If email fails use filesystem reports and npm run contur3:blue-status.',
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
