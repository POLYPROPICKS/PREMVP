#!/usr/bin/env node
/**
 * generate-chatgpt-architect-bundle.mjs
 *
 * Deterministically renders the ChatGPT Architect project bundle from the LIVE canonical
 * control-plane artifacts. There is exactly one direction of generation:
 *
 *   canonical control plane  →  generated bundle / snapshot / Project package
 *
 * A generated Project source may never silently override canonical policy, so every fact
 * in this file is read from a canonical artifact. Wall-clock time is never used.
 *
 * Usage:
 *   node scripts/control-plane/generate-chatgpt-architect-bundle.mjs           # write
 *   node scripts/control-plane/generate-chatgpt-architect-bundle.mjs --check   # verify
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECOVERABLE_CONDITIONS } from './lib/outcome-semantics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const DIR = 'docs/ai-context/control-plane';
export const BUNDLE_REL = `${DIR}/chatgpt-architect/CHATGPT_ARCHITECT_PROJECT_BUNDLE.md`;

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, DIR, rel), 'utf8'));
}

export function renderBundle(root = REPO_ROOT) {
  const policy = readJson(root, 'ARCHITECT_CONTROL_PLANE.yaml');
  const state = readJson(root, 'CURRENT_STATE.yaml');
  const capability = readJson(root, 'CAPABILITY_MATRIX.yaml');
  const routing = readJson(root, 'ROUTING_AND_PIPELINES.yaml');
  const registry = readJson(root, 'AGENT_REGISTRY.yaml');
  const missionSchema = readJson(root, 'MISSION_CONTRACT.schema.json');
  const taxonomy = readJson(root, 'EXECUTION_ESCALATION_TAXONOMY.json');

  const out = [];
  const w = (s = '') => out.push(s);

  w('# NON_AUTHORITATIVE_GENERATED_PROJECT_GUIDE');
  w();
  w('<!-- GENERATED FILE — do not edit by hand. Regenerate: npm run control-plane:architect-bundle -->');
  w();
  w(`State v${state.state_version} · updated ${state.updated_at} · policy ${policy.policy_version}`);
  w();
  w('Canonical authority is `docs/ai-context/control-plane/**`. Live Git and runtime output outrank this guide for every fact. Never invent a command id, SHA, executor, capability verdict or runtime proof.');
  w();

  w('## 1. Mission Contract');
  w();
  w('The fixed 25-section prompt template is RETIRED. Write one compact Mission Contract.');
  w();
  w(`**Always required:** ${['mission', 'business_result', 'repository', 'scope', 'hard_boundaries', 'acceptance'].map((k) => `\`${k}\``).join(' · ')}`);
  w();
  const modules = Object.keys(missionSchema.properties?.modules?.properties || {});
  w(`**Conditional, only when directly relevant:** ${modules.map((m) => `\`${m}\``).join(' · ')}`);
  w();
  w('Registered commands own precheck, worktree, dependency bootstrap, PR, merge, deployment polling, reviewer invocation, state reconciliation and resume. Restating their mechanics as mission prose fails compilation.');
  w();

  w('## 2. Machine-enforced invariants');
  w();
  for (const inv of missionSchema['x-invariants'] || []) w(`- ${inv}`);
  w();

  w('## 3. Outcome semantics');
  w();
  w('| outcome_class | verdict | founder_action |');
  w('|---|---|---|');
  for (const [id, o] of Object.entries(taxonomy.outcome_classes || {})) {
    w(`| \`${id}\` | ${o.verdict} | ${o.founder_action} |`);
  }
  w();
  w(`**Executor-owned, never returned to the Founder:** ${RECOVERABLE_CONDITIONS.map((c) => c.id).join(' · ')}.`);
  w();
  w(`**Never terminal by itself:** ${(taxonomy.never_terminal_reasons || []).join('; ')}.`);
  w();
  w(`**Canonical hard stops:** ${(taxonomy.classes?.HARD_SAFETY_STOP?.identifiers || []).map((i) => `\`${i}\``).join(' · ')}.`);
  w();
  w(`**Operator budget:** start ${taxonomy.operator_action_budget.start} · intermediate ${taxonomy.operator_action_budget.intermediate} · terminal result ${taxonomy.operator_action_budget.terminal_result}.`);
  w();

  w('## 4. Routing');
  w();
  w('| Risk class | Executors | Required reviewers | Fail closed |');
  w('|---|---|---|---|');
  for (const rc of routing.risk_classes) {
    const targets = rc.eligible_execution_targets.length ? rc.eligible_execution_targets.join(', ') : '—';
    const revs = (rc.reviewer_receipt_requirements || []).filter((r) => r.mandatory === true).map((r) => r.agent_id);
    w(`| \`${rc.id}\` | ${targets} | ${revs.length ? revs.join(', ') : '—'} | ${rc.fail_closed ? '**YES**' : 'no'} |`);
  }
  w();
  w('Reviewers are selected by risk class. There is no all-agent policy.');
  w();

  w('## 5. Execution targets');
  w();
  for (const t of capability.execution_targets) {
    const proven = t.capabilities.filter((c) => c.verdict === 'PROVEN').map((c) => c.capability);
    w(`- \`${t.executor_id}\` — PROVEN: ${proven.length ? proven.join(', ') : 'none'}`);
  }
  w();
  w(`Access surfaces are not executors: ${capability.access_surface_policy.surfaces.map((s) => `${s.id}→${s.reaches}`).join(', ')}.`);
  w();

  w('## 6. Registered commands');
  w();
  for (const e of registry.entries.filter((x) => x.type === 'COMMAND' && x.status === 'PROVEN_PRESENT')) {
    w(`- \`${e.canonical_id}\` → ${e.implementation_path} (${e.portability})`);
  }
  w();

  w('## 7. Roadmap');
  w();
  w(`- Phase: ${state.roadmap_phase}`);
  w(`- Current step: ${state.current_value_step.id} — ${state.current_value_step.title} (${state.current_value_step.status})`);
  for (const s of state.next_two_value_steps) w(`- Next: ${s.id} — ${s.title}`);
  w();

  w('## 8. New-chat bootstrap');
  w();
  w('Read the canonical Control Plane, resolve live Git before any runtime claim, select exactly one explicit executor, and compile one Mission Contract. Never ask the Founder to perform an intermediate recovery action.');
  w();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : REPO_ROOT;
  const target = path.join(root, BUNDLE_REL);
  const rendered = renderBundle(root);

  if (args.includes('--check')) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (existing === rendered) {
      process.stdout.write('[control-plane] architect-bundle:check PASS\n');
      process.exit(0);
    }
    process.stderr.write('[control-plane] architect-bundle:check FAIL — committed bundle differs from the deterministic regeneration. Run: npm run control-plane:architect-bundle\n');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered, 'utf8');
  process.stdout.write(`[control-plane] architect bundle written: ${BUNDLE_REL}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
