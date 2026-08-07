#!/usr/bin/env node
/**
 * run-premvp-release.mjs
 *
 * CLI for premvp.command.release_pipeline.v1 (premvp.release_pipeline.v1).
 *
 * The canonical pipeline specification is
 * docs/ai-context/control-plane/pipelines/PREMVP_RELEASE_PIPELINE_V1.yaml. While its
 * status is EXPERIMENTAL_DISABLED, only --dry-run, --status and manifest validation are
 * permitted; mutating execution (the default action with no flag) refuses to run — see
 * assertMutationAllowed() in lib/premvp-release-pipeline.mjs.
 *
 * Usage:
 *   node scripts/control-plane/run-premvp-release.mjs --manifest <path> --dry-run [--json]
 *   node scripts/control-plane/run-premvp-release.mjs --manifest <path> --status [--json]
 *   node scripts/control-plane/run-premvp-release.mjs --manifest <path> --resume <release_run_id> [--json]
 *   node scripts/control-plane/run-premvp-release.mjs --help
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateReleaseRunManifest } from './validate-premvp-release-run.mjs';
import { dryRunPlan, executeReleaseRun, PipelineError } from './lib/premvp-release-pipeline.mjs';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PIPELINE_SPEC_PATH = path.join(
  REPO_ROOT, 'docs/ai-context/control-plane/pipelines/PREMVP_RELEASE_PIPELINE_V1.yaml',
);
const ROUTING_PATH = path.join(REPO_ROOT, 'docs/ai-context/control-plane/ROUTING_AND_PIPELINES.yaml');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function printHelp() {
  process.stdout.write(`premvp.command.release_pipeline.v1
Usage:
  --manifest <path>       Path to a PREMVP_RELEASE_RUN manifest (required for all modes below)
  --dry-run               Validate the manifest and print the planned state sequence. No mutation.
  --status                Reconstruct and print live phase-completion status. No mutation.
  --resume <release_run_id>  Resume a run by id (requires mutating mode to be ENABLED)
  --json                  Emit machine-readable JSON instead of text
  --help                  Print this message

Mutating execution (no flag) is refused while the canonical pipeline status is
EXPERIMENTAL_DISABLED. See docs/ai-context/control-plane/pipelines/PREMVP_RELEASE_PIPELINE_V1.yaml.
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const asJson = args.includes('--json');
  const manifestIdx = args.indexOf('--manifest');
  const manifestPath = manifestIdx !== -1 ? args[manifestIdx + 1] : null;
  const isDryRun = args.includes('--dry-run');
  const isStatus = args.includes('--status');
  const resumeIdx = args.indexOf('--resume');
  const resumeId = resumeIdx !== -1 ? args[resumeIdx + 1] : null;

  if (!manifestPath) {
    process.stderr.write('ERROR: --manifest <path> is required\n');
    process.exit(1);
  }

  const manifest = loadJson(path.resolve(manifestPath));
  const pipelineSpec = loadJson(PIPELINE_SPEC_PATH);
  const routingDoc = loadJson(ROUTING_PATH);

  const emit = (obj, text) => {
    if (asJson) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    else process.stdout.write(text + '\n');
  };

  if (isDryRun) {
    const result = dryRunPlan(manifest, routingDoc, pipelineSpec);
    emit(result, result.ok
      ? `[release-pipeline] dry-run: PLAN OK (pipeline_status=${pipelineSpec.status}, mutating_enabled=${pipelineSpec.enabled})`
      : `[release-pipeline] dry-run: MANIFEST INVALID\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(result.ok ? 0 : 1);
    return;
  }

  if (isStatus) {
    // Status reconstruction is read-only and permitted while disabled. Without live adapters
    // wired (Action 2 scope), it reports manifest validity and pipeline activation state only.
    const manifestResult = validateReleaseRunManifest(manifest);
    emit(
      { release_run_id: manifest.release_run_id, manifest_valid: manifestResult.ok, errors: manifestResult.errors, pipeline_status: pipelineSpec.status, mutating_mode_enabled: pipelineSpec.enabled === true },
      `[release-pipeline] status: manifest_valid=${manifestResult.ok} pipeline_status=${pipelineSpec.status}`,
    );
    process.exit(manifestResult.ok ? 0 : 1);
    return;
  }

  // Mutating path: default action, and --resume. Both use only the registered
  // GitHub commands, exact-SHA reviewer receipt and automatic deployment poll.
  try {
    const run = (file, args, options = {}) => execFileSync(file, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: options.inherit ? 'inherit' : 'pipe',
    });
    const ghJson = (args) => JSON.parse(run('gh', args));
    const reviewerReceipt = manifest.reviewer_receipt || null;
    const adapters = {
      git: {
        currentHead: async () => run('git', ['rev-parse', 'HEAD']).trim(),
        changedFiles: async (base, sha) => run('git', ['diff', '--name-only', `${base}...${sha}`]).split(/\r?\n/).filter(Boolean),
        push: async (branch, sha) => { run('git', ['push', 'origin', `${sha}:refs/heads/${branch}`], { inherit: true }); },
        isAncestor: async (sha, ref) => { try { run('git', ['fetch', 'origin'], { inherit: true }); run('git', ['merge-base', '--is-ancestor', sha, ref]); return true; } catch { return false; } },
      },
      commands: { run: async (command) => { run(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command], { inherit: true }); } },
      reviewer: { findReceipt: async ({ agentId, reviewedSha }) => reviewerReceipt && reviewerReceipt.agent_id === agentId && reviewerReceipt.reviewed_sha === reviewedSha ? reviewerReceipt : null },
      github: {
        findPullRequest: async ({ repo, head, base }) => {
          const rows = ghJson(['pr', 'list', '--repo', repo, '--head', head, '--base', base, '--state', 'all', '--json', 'number,headRefOid,mergeCommit,state,url']);
          const row = rows[0];
          return row ? { number: row.number, repo, headSha: row.headRefOid, merged: row.state === 'MERGED', mergeCommitSha: row.mergeCommit?.oid || null, url: row.url } : null;
        },
        createPullRequest: async ({ repo, head, base, title, body }) => {
          run('node', ['scripts/control-plane/github-pr-create.mjs', JSON.stringify({ repository: repo, source_branch: head, target_branch: base, title, body })], { inherit: true });
          const rows = ghJson(['pr', 'list', '--repo', repo, '--head', head, '--base', base, '--state', 'open', '--json', 'number,headRefOid,url']);
          if (!rows[0]) throw new PipelineError('PR_CREATE_FAILED', 'Registered PR create command returned no open PR');
          return { number: rows[0].number, repo, headSha: rows[0].headRefOid, merged: false, mergeCommitSha: null, url: rows[0].url };
        },
        mergePullRequest: async ({ repo, number }) => {
          run('node', ['scripts/control-plane/github-pr-merge.mjs', JSON.stringify({ repository: repo, number })], { inherit: true });
          const row = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', 'mergeCommit,state']);
          if (row.state !== 'MERGED' || !row.mergeCommit?.oid) throw new PipelineError('PR_MERGE_FAILED', `PR #${number} did not merge`);
          return { mergeCommitSha: row.mergeCommit.oid };
        },
      },
      deploy: { getProductionSha: async (url) => { const response = await fetch(url); if (!response.ok) throw new PipelineError('DEPLOYMENT_READ_FAILED', `HTTP ${response.status}`); const payload = await response.json(); return typeof payload.commit_sha === 'string' ? payload.commit_sha : null; } },
      reconcile: { verify: async () => { run('node', ['scripts/control-plane/reconcile-control-plane.mjs', '--verify'], { inherit: true }); } },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    const result = await executeReleaseRun(manifest, routingDoc, pipelineSpec, adapters);
    emit(result, `[release-pipeline] ${result.status}: ${result.pr.url || `PR #${result.pr.number}`}`);
    process.exit(result.status === 'PASS' ? 0 : 2);
  } catch (e) {
    if (e instanceof PipelineError) {
      emit({ ok: false, code: e.code, message: e.message, resume_id: resumeId || null },
        `[release-pipeline] BLOCKED: ${e.code} — ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main().catch((error) => {
  const code = error instanceof PipelineError ? error.code : 'RELEASE_PIPELINE_FAILED';
  process.stderr.write(`[release-pipeline] BLOCKED: ${code} — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
