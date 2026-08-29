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

export const COMMAND_ID = 'premvp.command.evolution_canonicalize.v1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_REPOSITORY = 'POLYPROPICKS/PREMVP';

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

  const runCommand = (script, payload) => {
    try {
      return execFileSync('node', [path.join('scripts', 'control-plane', script), JSON.stringify(payload)], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch (e) {
      process.stderr.write(`[evolution-canonicalize] FAIL — ${script}: ${e.message}\n`);
      process.exit(1);
    }
  };

  const created = runCommand('github-pr-create.mjs', {
    repository,
    source_branch: branch,
    target_branch: 'main',
    title: `chore(evolution): canonicalize validated Evolution evidence lineage`,
    body: `Terminal persistence stage of ${COMMAND_ID}. Admitted: cycles [${verdict.admitted.cycles.join(', ')}], governor results [${verdict.admitted.governor_results.join(', ')}]. Hard-allowlisted to the Evolution evidence artifact surface; schema/semantic validation re-run; accepted:false preserved.`,
  });
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

  const merged = runCommand('github-pr-merge.mjs', { repository, number: prNumber });

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
