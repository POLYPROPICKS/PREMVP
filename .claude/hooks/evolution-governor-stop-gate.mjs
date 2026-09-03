#!/usr/bin/env node
/**
 * evolution-governor-stop-gate.mjs
 * Claude Code Stop hook — terminal-persistence enforcement for the Daily Evolution Review
 * and the Automation Operations Governor.
 *
 * Business rule (see docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml):
 *
 *   validated artifact
 *     -> mandatory canonical persistence attempt
 *     -> verified terminal outcome
 *     -> only THEN may the Claude Code session stop.
 *
 * The LLM must not be able to decide that canonicalization is undesirable, unnecessary or
 * optional. This hook is enforcement / orchestration ONLY. It never creates a PR, never
 * merges, never re-implements admission, ancestry or GitHub logic. It delegates every
 * validation decision to the already-registered command:
 *
 *   premvp.command.evolution_canonicalize.v1  ->  scripts/control-plane/evolution-canonicalize.mjs
 *
 * ...invoked in its read-only `--admit --json` mode. When a validated Evolution/Governor
 * lineage has not yet reached canonical origin/main, the hook blocks Stop and prints the
 * exact registered terminal-persistence command the session must run:
 *
 *   npm run control-plane:evolution:canonicalize -- --canonicalize --branch <branch> --executor <selected-executor>
 *
 * Five cases (mirrors the Mission SCOPE):
 *   1. no Evolution/Governor artifact produced this session          -> exit 0 (no action)
 *   2. artifact produced but admission validation failed             -> exit 0, report the causal
 *                                                                       failure; do NOT canonicalize
 *   3. validated artifact exists, terminal persistence NOT complete  -> exit 2, drive the registered
 *                                                                       canonicalization lifecycle
 *   4. canonical persistence reached its registered terminal proof   -> exit 0 (allow Stop)
 *   5. genuine hard failure from the registered canonicalizer        -> exit 2, fail closed with the
 *                                                                       existing causal error; invent
 *                                                                       no other persistence path
 *
 * Exit codes: 0 — allow Stop; 2 — block Stop (stderr is returned to the agent).
 *
 * Usage (Claude Code Stop hook): node .claude/hooks/evolution-governor-stop-gate.mjs <transcript_path>
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  classifyEvolutionEvidencePath,
  CYCLES_PREFIX,
  PROPOSALS_PREFIX,
} from '../../scripts/control-plane/lib/evolution-canonicalize.mjs';

export const HOOK_ID = 'claude.hook.evolution_governor_terminal_persistence_gate';
export const CANONICALIZE_SCRIPT = 'scripts/control-plane/evolution-canonicalize.mjs';
export const CANONICALIZE_COMMAND =
  'npm run control-plane:evolution:canonicalize -- --canonicalize --branch <branch> --executor <selected-executor>';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Is this repo-relative path a Daily Evolution Review / Governor evidence artifact? */
export function isEvolutionEvidencePath(p) {
  if (typeof p !== 'string') return false;
  if (!p.startsWith(CYCLES_PREFIX) && !p.startsWith(PROPOSALS_PREFIX)) return false;
  const c = classifyEvolutionEvidencePath(p);
  return c.ok && ['CYCLE', 'CYCLE_REPORT', 'GOVERNOR', 'GOVERNOR_REPORT'].includes(c.family);
}

/** Parse `git status --porcelain` output into a flat list of working-tree paths. */
export function parsePorcelainPaths(porcelain) {
  const out = [];
  for (const line of String(porcelain || '').split('\n')) {
    if (!line.trim()) continue;
    let rest = line.slice(3);
    // rename / copy entries: "R  old -> new"
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) rest = rest.slice(arrow + 4);
    out.push(rest.replace(/^"(.*)"$/, '$1').trim());
  }
  return out;
}

/**
 * Classify what this session did with Evolution/Governor evidence, using git state only.
 *
 * @param {(args: string[]) => string} runGit  git runner, cwd already bound to the repo.
 * @returns {{ dirty: string[], committed: string[], base: string, branch: string }}
 */
export function collectEvidenceState(runGit) {
  const safe = (args, fallback = '') => {
    try { return runGit(args); } catch { return fallback; }
  };

  const branch = safe(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'HEAD';

  // Prefer origin/main as the canonical baseline; fall back so the hook still runs offline.
  let base = 'origin/main';
  if (!safe(['rev-parse', '--verify', '--quiet', 'origin/main']).trim()) {
    base = safe(['rev-parse', '--verify', '--quiet', 'main']).trim() ? 'main' : '';
  }

  const dirty = parsePorcelainPaths(safe(['status', '--porcelain'])).filter(isEvolutionEvidencePath);

  let committed = [];
  if (base) {
    committed = safe(['diff', '--name-only', `${base}...HEAD`])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter(isEvolutionEvidencePath)
      .filter((p) => !dirty.includes(p));
  }

  return { dirty: [...new Set(dirty)], committed: [...new Set(committed)], base, branch };
}

const ALLOW = (reason, message = '') => ({ decision: 'ALLOW', code: 0, reason, message });
const BLOCK = (reason, message) => ({ decision: 'BLOCK', code: 2, reason, message });

/**
 * Pure decision function. `runGit` and `runAdmit` are injected so this is fully testable
 * without a real repository or a real canonicalizer process.
 *
 * @param {object} args
 * @param {(a: string[]) => string} args.runGit
 * @param {(a: { base: string }) => { status: number|null, stdout: string, stderr: string, error?: Error }} args.runAdmit
 *        Runs `evolution-canonicalize.mjs --admit --json --base <base> --head HEAD` and returns its result.
 */
export function evaluateStopGate({ runGit, runAdmit }) {
  const { dirty, committed, base, branch } = collectEvidenceState(runGit);

  // --- case 1 / case 4: nothing this session -----------------------------------------
  // No uncommitted evidence and no evidence on HEAD that is missing from origin/main.
  // A lineage already merged to origin/main leaves `base...HEAD` empty -> Stop is allowed,
  // and no duplicate canonicalization is initiated for an already-terminal lineage.
  if (dirty.length === 0 && committed.length === 0) {
    return ALLOW('CASE_1_OR_4_NO_PENDING_EVOLUTION_PERSISTENCE');
  }

  // --- case 3 (uncommitted): artifact produced but not yet on a lineage branch --------
  if (dirty.length > 0) {
    return BLOCK(
      'CASE_3_EVIDENCE_UNCOMMITTED',
      [
        '[evolution-governor-stop-gate] TERMINAL PERSISTENCE INCOMPLETE',
        '',
        'This session produced Daily Evolution Review / Automation Operations Governor evidence',
        'that is not yet committed to a lineage branch, so canonical persistence cannot run:',
        ...dirty.map((p) => `  - ${p}`),
        '',
        'Commit the validated evidence-only lineage, then run the registered terminal-persistence',
        'lifecycle. The session may not stop until the lineage is canonical on origin/main:',
        '',
        `  ${CANONICALIZE_COMMAND.replace('<branch>', branch)}`,
        '',
        'Canonicalization is mandatory — it is not optional, undesirable or unnecessary.',
      ].join('\n'),
    );
  }

  // --- committed evidence not on origin/main: delegate the verdict to the canonicalizer
  let admit;
  try {
    admit = runAdmit({ base: base || 'origin/main' });
  } catch (error) {
    admit = { status: null, stdout: '', stderr: String(error && error.message || error), error };
  }

  const stdout = String(admit.stdout || '');
  const stderr = String(admit.stderr || '');
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* non-JSON handled below */ }

  // --- case 2: admission failed -> do NOT canonicalize, permit terminal-failure report
  if (admit.status === 1 && parsed && parsed.ok === false) {
    return ALLOW(
      'CASE_2_ADMISSION_FAILED',
      [
        '[evolution-governor-stop-gate] Evolution/Governor evidence produced this session did NOT',
        'pass the registered canonicalization admission contract. Per the existing contract this',
        'lineage is NOT canonicalized; the terminal failure is reported and Stop is permitted.',
        '',
        'Causal admission violations (from premvp.command.evolution_canonicalize.v1 --admit):',
        ...(Array.isArray(parsed.errors) ? parsed.errors.map((e) => `  - ${e}`) : [`  ${stderr || '(no detail)'}`]),
      ].join('\n'),
    );
  }

  // --- case 3: validated, but not yet canonical -> block and drive the lifecycle ------
  if (admit.status === 0 && parsed && parsed.ok === true) {
    const admitted = [
      ...(parsed.cycles || []).map((id) => `cycle ${id}`),
      ...(parsed.governor_results || []).map((id) => `governor result ${id}`),
    ];
    return BLOCK(
      'CASE_3_VALIDATED_NOT_CANONICAL',
      [
        '[evolution-governor-stop-gate] TERMINAL PERSISTENCE INCOMPLETE',
        '',
        'This session produced a VALIDATED Evolution/Governor lineage that has not reached',
        'canonical origin/main:',
        ...(admitted.length ? admitted.map((a) => `  - ${a}`) : committed.map((p) => `  - ${p}`)),
        '',
        'The registered terminal-persistence lifecycle must complete before the session stops.',
        'Run it now (it re-runs admission and canonicalizes via the shared GitHub PR commands):',
        '',
        `  ${CANONICALIZE_COMMAND.replace('<branch>', branch)}`,
        '',
        'Canonicalization is mandatory — it is not optional, undesirable or unnecessary.',
      ].join('\n'),
    );
  }

  // --- case 5: genuine hard failure -> fail closed with the existing causal error -----
  return BLOCK(
    'CASE_5_CANONICALIZER_HARD_FAILURE',
    [
      '[evolution-governor-stop-gate] The registered canonicalizer failed while checking whether',
      'this session\'s Evolution/Governor evidence can be persisted. Failing closed — Stop is',
      'blocked and no alternative persistence path is invented.',
      '',
      `  command : node ${CANONICALIZE_SCRIPT} --admit --json --base ${base || 'origin/main'} --head HEAD`,
      `  exit    : ${admit.status === null ? '(spawn failed)' : admit.status}`,
      '  stderr  :',
      ...(stderr ? stderr.split('\n').map((l) => `    ${l}`) : ['    (empty)']),
      ...(stdout ? ['  stdout  :', ...stdout.split('\n').map((l) => `    ${l}`)] : []),
    ].join('\n'),
  );
}

// --------------------------------------------------------------------------------------
// CLI wrapper
// --------------------------------------------------------------------------------------

function realGit(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function realAdmit({ base }) {
  const scriptArgs = [CANONICALIZE_SCRIPT, '--admit', '--json', '--base', base, '--head', 'HEAD'];
  try {
    const stdout = execFileSync('node', scriptArgs, { cwd: REPO_ROOT, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      status: typeof e.status === 'number' ? e.status : null,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : String(e.message || e),
      error: e,
    };
  }
}

function main() {
  const verdict = evaluateStopGate({ runGit: realGit, runAdmit: realAdmit });
  if (verdict.decision === 'ALLOW') {
    if (verdict.message) process.stdout.write(`${verdict.message}\n`);
    process.exit(0);
  }
  process.stderr.write(`${verdict.message}\n`);
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
