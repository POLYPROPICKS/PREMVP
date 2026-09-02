#!/usr/bin/env node
/**
 * evolution-canonicalize.mjs — premvp.command.evolution_canonicalize.v1
 *
 * Terminal persistence stage for the Daily Evolution Review and the Automation Operations
 * Governor. Converts an already validated, evidence-only Evolution/Governor lineage into
 * canonical origin/main with zero intermediate Founder actions.
 *
 * It reuses the existing lifecycle primitives — it never reimplements PR/merge mechanics:
 *   - admission:  scripts/control-plane/lib/evolution-canonicalize.mjs (this command's contract)
 *   - PR create:  scripts/control-plane/github-pr-create.mjs   (premvp.command.github_pr_create.v1)
 *   - PR merge:   scripts/control-plane/github-pr-merge.mjs     (premvp.command.github_pr_merge.v1)
 *
 * The Governor still consumes only canonical origin/main history: this command is what MOVES
 * a validated lineage onto origin/main, it never lets a pending branch or draft PR become
 * evidence authority.
 *
 * Usage:
 *   node scripts/control-plane/evolution-canonicalize.mjs --admit [--base <ref>] [--head <ref>] [--json]
 *   node scripts/control-plane/evolution-canonicalize.mjs --canonicalize --branch <name> [--base <ref>] [--head <ref>] [--repository <owner/repo>] [--json]
 *
 * --admit        classify the lineage and print the admission verdict; no PR, no merge.
 * --canonicalize admit, then (only on a clean admission) create the PR and merge it via the
 *                shared canonical GitHub commands, then verify origin/main ancestry.
 *
 * Exit codes:
 *   0 — admission passed (and, for --canonicalize, the merge landed and was verified)
 *   1 — admission failed (every violation printed) or a downstream lifecycle command failed
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  admitCanonicalizationLineage,
  classifyEvolutionEvidencePath,
  CYCLES_PREFIX,
  PROPOSALS_PREFIX,
} from './lib/evolution-canonicalize.mjs';
import { derivePeriodKey } from './lib/evolution-cycle.mjs';
import {
  readGitHubPrRegistry,
  resolveGitHubPrAdapter,
} from './lib/github-pr-adapter-binding.mjs';

export const COMMAND_ID = 'premvp.command.evolution_canonicalize.v1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_REPOSITORY = 'POLYPROPICKS/PREMVP';

/**
 * Resolve both terminal lifecycle primitives through the active executor.  The cloud binding
 * is intentionally a GitHub MCP dispatch, never a substitution to this process's local gh.
 */
export function resolveCanonicalizationAdapters(executorId, repoRoot = REPO_ROOT) {
  const registry = readGitHubPrRegistry(repoRoot);
  return {
    create: resolveGitHubPrAdapter({ registry, commandId: 'premvp.command.github_pr_create.v1', executorId }),
    merge: resolveGitHubPrAdapter({ registry, commandId: 'premvp.command.github_pr_merge.v1', executorId }),
  };
}

function terminalPayloads({ repository, branch, admitted }) {
  return {
    create: {
      repository,
      source_branch: branch,
      target_branch: 'main',
      title: 'chore(evolution): canonicalize validated Evolution evidence lineage',
      body: `Terminal persistence stage of ${COMMAND_ID}. Admitted: cycles [${admitted.cycles.join(', ')}], governor results [${admitted.governor_results.join(', ')}]. Hard-allowlisted to the Evolution evidence artifact surface; schema/semantic validation re-run; accepted:false preserved.`,
    },
  };
}

/**
 * Create an executor-owned terminal-dispatch plan after admission. The plan never substitutes
 * transports: cloud operations are handed only to the selected executor's registered GitHub
 * MCP capability, while local Codex continues to call its registered gh scripts.
 */
export function createCanonicalizationDispatchPlan({ executorId, repository, branch, admitted, repoRoot = REPO_ROOT }) {
  const adapters = resolveCanonicalizationAdapters(executorId, repoRoot);
  const payloads = terminalPayloads({ repository, branch, admitted });
  const step = (adapter, payload) => {
    if (adapter.transport === 'local_gh_cli' && adapter.script) {
      return { mode: 'LOCAL_SCRIPT', adapter, payload };
    }
    if (adapter.transport === 'github_mcp' && adapter.dispatch === 'registered_platform_capability') {
      return { mode: 'EXECUTOR_NATIVE_PLATFORM_CAPABILITY', adapter, payload };
    }
    throw new Error(`GITHUB_PR_EXECUTOR_NATIVE_DISPATCH_UNAVAILABLE: ${adapter.command_id} on ${executorId} resolves to unsupported ${adapter.transport || 'missing-transport'}/${adapter.operation || 'missing-operation'}`);
  };
  const create = step(adapters.create, payloads.create);
  const merge = step(adapters.merge, { repository, number_from: 'create.number' });
  if (create.mode !== merge.mode) {
    throw new Error(`GITHUB_PR_EXECUTOR_NATIVE_DISPATCH_UNAVAILABLE: create/merge transport mismatch for ${executorId}`);
  }
  return Object.freeze({
    command_id: COMMAND_ID,
    executor_id: executorId,
    create,
    merge,
  });
}

/**
 * Executes a previously admitted plan through an executor-provided native dispatcher. The
 * lifecycle owns ordering and payload construction; the executor owns its platform capability.
 */
export async function executeCanonicalizationDispatchPlan(plan, dispatch) {
  if (typeof dispatch !== 'function') {
    throw new Error('GITHUB_PR_EXECUTOR_NATIVE_DISPATCH_UNAVAILABLE: executor-native dispatch function is required');
  }
  const created = await dispatch(plan.create);
  const prNumber = Number(created?.number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('GITHUB_PR_EXECUTOR_NATIVE_DISPATCH_UNAVAILABLE: create dispatch did not return a PR number');
  }
  const merged = await dispatch({ ...plan.merge, payload: { repository: plan.merge.payload.repository, number: prNumber } });
  return { pr_number: prNumber, merge_output: merged };
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** Reads the canonical Evolution evidence state at `base` for the uniqueness checks. */
export function readCanonicalEvidence(base) {
  const listing = tryGit(['ls-tree', '-r', '--name-only', base, '--', CYCLES_PREFIX, PROPOSALS_PREFIX]) || '';
  const cycleIds = [];
  const cyclePeriods = {};
  const governorResultIds = [];
  for (const line of listing.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const c = classifyEvolutionEvidencePath(line);
    if (!c.ok) continue;
    if (c.family === 'CYCLE') {
      cycleIds.push(c.id);
      const raw = tryGit(['show', `${base}:${line}`]);
      if (raw) {
        try {
          const key = derivePeriodKey(JSON.parse(raw).period_start);
          if (key) cyclePeriods[key] = c.id;
        } catch { /* a malformed base file is not this command's problem to police */ }
      }
    }
    if (c.family === 'GOVERNOR') governorResultIds.push(c.id);
  }
  return { cycleIds, cyclePeriods, governorResultIds };
}

/** Collects the changed-path lineage (name-status + content) between base and head. */
export function readLineage(base, head) {
  const nameStatus = git(['diff', '--name-status', `${base}...${head}`]).split('\n').map((l) => l.trim()).filter(Boolean);
  const changedPaths = [];
  const files = {};
  for (const row of nameStatus) {
    const parts = row.split('\t');
    const status = parts[0];
    const filePath = parts[parts.length - 1];
    changedPaths.push(filePath);
    if (status.startsWith('D')) {
      files[filePath] = null;
    } else {
      files[filePath] = git(['show', `${head}:${filePath}`]);
    }
  }
  return { changedPaths, files };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${COMMAND_ID}\nUsage: --admit | --canonicalize --branch <name> [--base <ref>] [--head <ref>] [--repository <owner/repo>] [--json]\n`);
    process.exit(0);
  }

  const opt = (name, fallback = null) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const asJson = args.includes('--json');
  const doMerge = args.includes('--canonicalize');
  const base = opt('--base', 'origin/main');
  const head = opt('--head', 'HEAD');
  const repository = opt('--repository', DEFAULT_REPOSITORY);
  const branch = opt('--branch');
  const executor = opt('--executor');

  let lineage;
  try {
    lineage = readLineage(base, head);
  } catch (e) {
    process.stderr.write(`[evolution-canonicalize] FAIL — cannot read lineage ${base}...${head}: ${e.message}\n`);
    process.exit(1);
  }

  const canonical = readCanonicalEvidence(base);
  const verdict = admitCanonicalizationLineage({ ...lineage, canonical });

  if (!verdict.ok) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ok: false, command_id: COMMAND_ID, errors: verdict.errors }, null, 2)}\n`);
    } else {
      process.stderr.write(`[evolution-canonicalize] ADMISSION FAILED (${verdict.errors.length} violation(s))\n`);
      for (const e of verdict.errors) process.stderr.write(`  - ${e}\n`);
    }
    process.exit(1);
  }

  if (!doMerge) {
    process.stdout.write(asJson
      ? `${JSON.stringify({ ok: true, command_id: COMMAND_ID, ...verdict.admitted }, null, 2)}\n`
      : `[evolution-canonicalize] ADMITTED — cycles [${verdict.admitted.cycles.join(', ')}], governor results [${verdict.admitted.governor_results.join(', ')}]\n`);
    process.exit(0);
  }

  if (!branch) {
    process.stderr.write('[evolution-canonicalize] FAIL — --canonicalize requires --branch <source branch name>\n');
    process.exit(1);
  }

  if (!executor) {
    process.stderr.write('[evolution-canonicalize] FAIL — --canonicalize requires --executor <registered executor>; no adapter default or executor substitution is permitted\n');
    process.exit(1);
  }

  let plan;
  try {
    plan = createCanonicalizationDispatchPlan({ executorId: executor, repository, branch, admitted: verdict.admitted });
  } catch (e) {
    process.stderr.write(`[evolution-canonicalize] FAIL — ${e.message}\n`);
    process.exit(1);
  }

  if (plan.create.mode === 'EXECUTOR_NATIVE_PLATFORM_CAPABILITY') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command_id: COMMAND_ID,
      terminal_state: 'EXECUTOR_NATIVE_DISPATCH_READY',
      dispatch_plan: plan,
      ...verdict.admitted,
    }, null, 2)}\n`);
    process.exit(0);
  }

  const runCommand = (step) => {
    try {
      return execFileSync('node', [step.adapter.script, JSON.stringify(step.payload)], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch (e) {
      process.stderr.write(`[evolution-canonicalize] FAIL — ${step.adapter.command_id}: ${e.message}\n`);
      process.exit(1);
    }
  };

  let created;
  try {
    created = runCommand(plan.create);
  } catch (e) {
    process.stderr.write(`[evolution-canonicalize] FAIL — ${e.message}\n`);
    process.exit(1);
  }
  let prNumber = null;
  try {
    const parsed = JSON.parse(created);
    prNumber = parsed.number;
  } catch {
    const m = created.match(/\/pull\/(\d+)/);
    if (m) prNumber = Number(m[1]);
  }
  if (!prNumber) {
    process.stderr.write(`[evolution-canonicalize] FAIL — could not resolve a PR number from github-pr-create output:\n${created}\n`);
    process.exit(1);
  }

  let merged;
  try {
    merged = runCommand({ ...plan.merge, payload: { repository, number: prNumber } });
  } catch (e) {
    process.stderr.write(`[evolution-canonicalize] FAIL — ${e.message}\n`);
    process.exit(1);
  }

  tryGit(['fetch', '--prune', 'origin']);
  const isAncestor = tryGit(['merge-base', '--is-ancestor', head, 'origin/main']) !== null;

  const payload = {
    ok: isAncestor,
    command_id: COMMAND_ID,
    repository,
    pr_number: prNumber,
    merge_output: merged,
    origin_main_ancestry_verified: isAncestor,
    ...verdict.admitted,
  };
  process.stdout.write(asJson ? `${JSON.stringify(payload, null, 2)}\n` : `[evolution-canonicalize] ${isAncestor ? 'CANONICALIZED' : 'MERGE UNVERIFIED'} — PR #${prNumber}\n`);
  process.exit(isAncestor ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
