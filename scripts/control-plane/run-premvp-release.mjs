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
import { dryRunPlan, assertMutationAllowed, PipelineError } from './lib/premvp-release-pipeline.mjs';

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

function main() {
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

  // Mutating path: default action, and --resume. Both require ENABLED.
  try {
    assertMutationAllowed(pipelineSpec);
    // Unreachable in Action 2: mutating adapters are not wired until Action 3 activation.
    process.stderr.write('ERROR: mutating execution is not implemented in Action 2\n');
    process.exit(1);
  } catch (e) {
    if (e instanceof PipelineError) {
      emit({ ok: false, code: e.code, message: e.message, resume_id: resumeId || null },
        `[release-pipeline] BLOCKED: ${e.code} — ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
