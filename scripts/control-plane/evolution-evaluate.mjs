#!/usr/bin/env node
/**
 * evolution-evaluate.mjs — premvp.command.evolution_evaluate.v1
 *
 * Validates one Daily Evolution Review cycle against the Stage 1 contracts and renders the
 * plain-Russian Founder report from it.
 *
 * It does not write the judgement — a reviewer produces the cycle. This command decides
 * whether that judgement is admissible: axes separate, metrics diagnostic, claims evidenced,
 * PnL never inferred, exactly two Founder practices, two or three experiments.
 *
 * Usage:
 *   node scripts/control-plane/evolution-evaluate.mjs --cycle <cycle.json> [--write] [--json]
 *   node scripts/control-plane/evolution-evaluate.mjs --cycle <cycle.json> --report-out <file.md>
 *
 * --write persists the validated cycle and its report under
 * docs/ai-context/control-plane/evolution/cycles/. Without it, nothing is written.
 *
 * Exit codes:
 *   0 — cycle and rendered report satisfy every Stage 1 contract
 *   1 — one or more violations (each printed explicitly)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateEvolutionCycle,
  renderFounderReport,
  validateFounderReport,
} from './lib/evolution-cycle.mjs';

export const COMMAND_ID = 'premvp.command.evolution_evaluate.v1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const CYCLES_DIR = 'docs/ai-context/control-plane/evolution/cycles';

/**
 * Validates a cycle and, only if it is admissible, renders and re-validates its report.
 * Rendering a report for a rejected cycle would hand the Founder a readable summary of an
 * inadmissible judgement — so it never happens.
 */
export function evaluateEvolutionCycle(cycle) {
  const cycleResult = validateEvolutionCycle(cycle);
  if (!cycleResult.ok) {
    return { ok: false, errors: cycleResult.errors, report: null };
  }
  const report = renderFounderReport(cycle);
  const reportResult = validateFounderReport(report);
  if (!reportResult.ok) {
    return { ok: false, errors: reportResult.errors, report };
  }
  return { ok: true, errors: [], report };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${COMMAND_ID}\nUsage: --cycle <cycle.json> [--write] [--report-out <file.md>] [--json]\n`);
    process.exit(0);
  }
  const cycleIdx = args.indexOf('--cycle');
  if (cycleIdx < 0 || !args[cycleIdx + 1]) {
    process.stderr.write('evolution-evaluate requires --cycle <cycle.json>\n');
    process.exit(1);
  }

  const cycle = JSON.parse(fs.readFileSync(args[cycleIdx + 1], 'utf8'));
  const { ok, errors, report } = evaluateEvolutionCycle(cycle);

  if (!ok) {
    process.stderr.write(`[evolution-evaluate] FAIL (${errors.length} violation(s))\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  const reportOutIdx = args.indexOf('--report-out');
  if (reportOutIdx >= 0 && args[reportOutIdx + 1]) {
    const target = path.resolve(args[reportOutIdx + 1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, report, 'utf8');
  }

  if (args.includes('--write')) {
    const dir = path.join(REPO_ROOT, CYCLES_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${cycle.cycle_id}.json`), `${JSON.stringify(cycle, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, `${cycle.cycle_id}.report.md`), report, 'utf8');
  }

  process.stdout.write(args.includes('--json')
    ? `${JSON.stringify({ ok, command_id: COMMAND_ID, cycle_id: cycle.cycle_id, axis_a: cycle.axis_a.verdict, axis_b: cycle.axis_b.verdict }, null, 2)}\n`
    : `[evolution-evaluate] PASS — Axis A ${cycle.axis_a.verdict}, Axis B ${cycle.axis_b.verdict}\n`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
