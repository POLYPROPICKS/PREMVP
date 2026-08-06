#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { reconcilePlan } from './lib/control-plane-reconcile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const mode = args.includes('--apply-non-state') ? 'apply-non-state' : args.includes('--apply-state') ? 'apply-state' : args.includes('--verify') ? 'verify' : 'plan';
const baselineIndex = args.indexOf('--baseline');
const baseline = baselineIndex === -1 ? null : args[baselineIndex + 1] || null;
if (args.includes('--help')) { console.log('Usage: reconcile-control-plane.mjs [--plan|--apply-non-state|--apply-state --baseline <sha>|--verify] [--evidence <path>] [--json]'); process.exit(0); }
try {
  const resolveCommit = (value) => execFileSync('git', ['rev-parse', '--verify', `${value}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const isAncestor = (sha, head) => {
    try { execFileSync('git', ['merge-base', '--is-ancestor', sha, head || 'HEAD'], { cwd: root, stdio: 'ignore' }); return true; } catch { return false; }
  };
  const plan = reconcilePlan({ mode, baseline, intendedHead: 'HEAD', resolveCommit, isAncestor });
  if (mode === 'verify') {
    for (const f of ['CURRENT_STATE.yaml', 'CAPABILITY_MATRIX.yaml', 'ROUTING_AND_PIPELINES.yaml', 'AGENT_REGISTRY.yaml']) JSON.parse(fs.readFileSync(path.join(root, 'docs/ai-context/control-plane', f), 'utf8'));
  }
  console.log(args.includes('--json') ? JSON.stringify({ ok: true, ...plan }) : `[control-plane] reconcile ${mode}: PASS`);
} catch (error) { console.error(`[control-plane] reconcile: FAIL — ${error.message}`); process.exit(1); }
