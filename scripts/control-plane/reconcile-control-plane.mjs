#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { reconcilePlan, buildFactualStateDelta } from './lib/control-plane-reconcile.mjs';
import { validateCompletionEnvelope } from './validate-completion-envelope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const mode = args.includes('--apply-non-state') ? 'apply-non-state' : args.includes('--apply-state') ? 'apply-state' : args.includes('--verify') ? 'verify' : 'plan';
const baselineIndex = args.indexOf('--baseline');
const baseline = baselineIndex === -1 ? null : args[baselineIndex + 1] || null;
const evidenceIndex = args.indexOf('--evidence');
const evidencePath = evidenceIndex === -1 ? null : args[evidenceIndex + 1] || null;
const mergeIndex = args.indexOf('--merge-sha');
const mergeSha = mergeIndex === -1 ? null : args[mergeIndex + 1] || null;
const resultIndex = args.indexOf('--result-sha');
const expectedResultSha = resultIndex === -1 ? null : args[resultIndex + 1] || null;
if (args.includes('--help')) { console.log('Usage: reconcile-control-plane.mjs [--plan|--apply-non-state|--apply-state --baseline <sha>|--verify] [--evidence <path>] [--json]'); process.exit(0); }
try {
  const resolveCommit = (value) => execFileSync('git', ['rev-parse', '--verify', `${value}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const isAncestor = (sha, head) => {
    try { execFileSync('git', ['merge-base', '--is-ancestor', sha, head || 'HEAD'], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; }
  };
  const statePath = path.join(root, 'docs/ai-context/control-plane/CURRENT_STATE.yaml');
  const stateForPlan = mode === 'apply-state' ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const effectiveBaseline = mode === 'apply-state' ? (baseline || stateForPlan?.main?.origin_main_sha) : baseline;
  const plan = reconcilePlan({ mode, baseline: effectiveBaseline, intendedHead: 'HEAD', resolveCommit, isAncestor });
  let reconciliation = null;
  if (mode === 'apply-state') {
    if (!evidencePath || !mergeSha) throw new Error('RECONCILE_EVIDENCE_AND_MERGE_REQUIRED');
    const completion = JSON.parse(fs.readFileSync(path.resolve(root, evidencePath), 'utf8'));
    const validation = validateCompletionEnvelope(completion);
    if (!validation.ok) throw new Error(`RECONCILE_COMPLETION_ENVELOPE_INVALID: ${validation.errors.join('; ')}`);
    if (expectedResultSha && resolveCommit(expectedResultSha).toLowerCase() !== String(completion.result_sha).toLowerCase()) {
      throw new Error('RECONCILE_COMPLETION_RESULT_SHA_MISMATCH');
    }
    const state = stateForPlan;
    reconciliation = buildFactualStateDelta({
      state,
      completion,
      mergeSha: resolveCommit(mergeSha),
      observedAt: new Date().toISOString(),
      isAncestor,
    });
    if (reconciliation.changed) {
      fs.writeFileSync(statePath, `${JSON.stringify(reconciliation.state, null, 2)}\n`, 'utf8');
      execFileSync('npm.cmd', ['run', 'control-plane:snapshot'], { cwd: root, stdio: 'inherit' });
      execFileSync('npm.cmd', ['run', 'control-plane:architect-bundle'], { cwd: root, stdio: 'inherit' });
      execFileSync('npm.cmd', ['run', 'control-plane:project-package'], { cwd: root, stdio: 'inherit' });
    }
  }
  if (mode === 'verify') {
    for (const f of ['CURRENT_STATE.yaml', 'CAPABILITY_MATRIX.yaml', 'ROUTING_AND_PIPELINES.yaml', 'AGENT_REGISTRY.yaml']) JSON.parse(fs.readFileSync(path.join(root, 'docs/ai-context/control-plane', f), 'utf8'));
  }
  console.log(args.includes('--json') ? JSON.stringify({ ok: true, ...plan, reconciliation }) : `[control-plane] reconcile ${mode}: PASS`);
} catch (error) { console.error(`[control-plane] reconcile: FAIL — ${error.message}`); process.exit(1); }
