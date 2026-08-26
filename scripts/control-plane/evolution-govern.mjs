#!/usr/bin/env node
/**
 * evolution-govern.mjs — premvp.command.evolution_govern.v1
 *
 * Validates one Automation Roadmap Governor result against the Stage 2 contracts and
 * renders the plain-Russian Founder report from it.
 *
 * It does not write the judgement — a reviewer produces the GOVERNOR_RESULT from persisted
 * Evolution cycles. This command decides whether that judgement is admissible: eligibility
 * is evidence-driven, a roadmap delta is present only when justified and eligible, the
 * delta never accepts itself and never touches strategic authority, and factual auto-updates
 * stay separated from strategic fields.
 *
 * Usage:
 *   node scripts/control-plane/evolution-govern.mjs --prepare [--json]
 *   node scripts/control-plane/evolution-govern.mjs --result <result.json> [--write] [--json]
 *   node scripts/control-plane/evolution-govern.mjs --result <result.json> --report-out <file.md>
 *
 * --write persists the validated result and its report under
 * docs/ai-context/control-plane/evolution/roadmap-proposals/. Without it, nothing is written.
 *
 * Exit codes:
 *   0 — result and rendered report satisfy every Stage 2 contract
 *   1 — one or more violations (each printed explicitly)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateGovernorResult,
  renderGovernorFounderReport,
  validateGovernorReport,
  discoverCanonicalEvolutionCycles,
  discoverPersistedGovernorResults,
  prepareGovernorEvidence,
} from './lib/evolution-governor.mjs';

export const COMMAND_ID = 'premvp.command.evolution_govern.v1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const CYCLES_DIR = 'docs/ai-context/control-plane/evolution/cycles';
export const ROADMAP_PROPOSALS_DIR = 'docs/ai-context/control-plane/evolution/roadmap-proposals';

/** Discovers and validates the only persisted evidence authorities used by this command. */
export function prepareCanonicalGovernorEvidence(repoRoot = REPO_ROOT) {
  const cycleDiscovery = discoverCanonicalEvolutionCycles(path.join(repoRoot, CYCLES_DIR));
  const resultDiscovery = discoverPersistedGovernorResults(path.join(repoRoot, ROADMAP_PROPOSALS_DIR));
  const errors = [...cycleDiscovery.errors, ...resultDiscovery.errors];
  if (cycleDiscovery.ok && resultDiscovery.ok) {
    const canonicalCycleIds = new Set(cycleDiscovery.cycles.map((cycle) => cycle.cycle_id));
    for (const result of resultDiscovery.results) {
      for (const cycleId of result.eligibility.based_on_cycles) {
        if (!canonicalCycleIds.has(cycleId)) {
          errors.push(`${result.result_id}: persisted Governor history cites missing canonical Cycle ${cycleId}`);
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, evidence: null };
  return {
    ok: true,
    errors: [],
    evidence: prepareGovernorEvidence({
      cycles: cycleDiscovery.cycles,
      priorGovernorResults: resultDiscovery.results,
    }),
  };
}

/**
 * Validates a Governor result and, only if it is admissible, renders and re-validates its
 * report. Rendering a report for an inadmissible result would hand the Founder a readable
 * summary of a judgement the contract already rejected — so it never happens.
 */
export function evaluateGovernorResult(result, { preparedEvidence = null } = {}) {
  const resultCheck = validateGovernorResult(result, { preparedEvidence });
  if (!resultCheck.ok) {
    return { ok: false, errors: resultCheck.errors, report: null };
  }
  const report = renderGovernorFounderReport(result);
  const reportCheck = validateGovernorReport(report);
  if (!reportCheck.ok) {
    return { ok: false, errors: reportCheck.errors, report };
  }
  return { ok: true, errors: [], report };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${COMMAND_ID}\nUsage: --prepare [--json] | --result <result.json> [--write] [--report-out <file.md>] [--json]\n`);
    process.exit(0);
  }

  const preparation = prepareCanonicalGovernorEvidence();
  if (!preparation.ok) {
    process.stderr.write(`[evolution-govern] FAIL (${preparation.errors.length} canonical history violation(s))\n`);
    for (const error of preparation.errors) process.stderr.write(`  - ${error}\n`);
    process.exit(1);
  }

  if (args.includes('--prepare')) {
    const payload = { ok: true, command_id: COMMAND_ID, ...preparation.evidence };
    process.stdout.write(args.includes('--json')
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `[evolution-govern] PREPARED — ${payload.history.canonical_cycle_count} canonical cycle(s), disposition ${payload.terminal_disposition ?? 'REASONING_REQUIRED'}\n`);
    process.exit(0);
  }

  const resultIdx = args.indexOf('--result');
  if (resultIdx < 0 || !args[resultIdx + 1]) {
    process.stderr.write('evolution-govern requires --prepare or --result <result.json>\n');
    process.exit(1);
  }

  const result = JSON.parse(fs.readFileSync(args[resultIdx + 1], 'utf8'));
  const { ok, errors, report } = evaluateGovernorResult(result, { preparedEvidence: preparation.evidence });

  if (!ok) {
    process.stderr.write(`[evolution-govern] FAIL (${errors.length} violation(s))\n`);
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
    const dir = path.join(REPO_ROOT, ROADMAP_PROPOSALS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${result.result_id}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, `${result.result_id}.report.md`), report, 'utf8');
  }

  process.stdout.write(args.includes('--json')
    ? `${JSON.stringify({ ok, command_id: COMMAND_ID, result_id: result.result_id, eligible: result.eligibility.eligible, terminal_disposition: result.terminal_disposition, has_roadmap_delta: result.roadmap_delta !== null }, null, 2)}\n`
    : `[evolution-govern] PASS — ${result.terminal_disposition}, roadmap_delta ${result.roadmap_delta !== null ? 'present' : 'none'}\n`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
