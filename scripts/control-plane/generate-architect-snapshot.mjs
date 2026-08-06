#!/usr/bin/env node
/**
 * generate-architect-snapshot.mjs
 *
 * Deterministically renders docs/ai-context/control-plane/ARCHITECT_SNAPSHOT.md from the
 * canonical JSON-compatible YAML artifacts.
 *
 * Determinism rule: wall-clock time is NEVER used. Every timestamp in the output comes
 * from CURRENT_STATE.updated_at or from the source artifact versions.
 *
 * Usage:
 *   node scripts/control-plane/generate-architect-snapshot.mjs            # write
 *   node scripts/control-plane/generate-architect-snapshot.mjs --check    # verify committed file
 *   node scripts/control-plane/generate-architect-snapshot.mjs --root=<dir> [--write|--check]
 *
 * Exit codes:
 *   0 — written, or check passed
 *   1 — check failed (committed snapshot differs from regenerated output)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
const DIR = 'docs/ai-context/control-plane';
export const SNAPSHOT_REL = `${DIR}/ARCHITECT_SNAPSHOT.md`;

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, DIR, rel), 'utf8'));
}

function bullets(lines) {
  return lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- (none)';
}

export function renderSnapshot(root = REPO_ROOT) {
  const policy = readJson(root, 'ARCHITECT_CONTROL_PLANE.yaml');
  const state = readJson(root, 'CURRENT_STATE.yaml');
  const capability = readJson(root, 'CAPABILITY_MATRIX.yaml');
  const routing = readJson(root, 'ROUTING_AND_PIPELINES.yaml');
  const registry = readJson(root, 'AGENT_REGISTRY.yaml');

  const out = [];
  const w = (s = '') => out.push(s);

  w('# ARCHITECT_SNAPSHOT.md — Compact Architect Context');
  w();
  w('<!-- GENERATED FILE — do not edit by hand. Regenerate: npm run control-plane:snapshot -->');
  w();
  w(`State v${state.state_version} · updated ${state.updated_at} · policy ${policy.policy_version}`);
  w();

  // --- 1. Source authority --------------------------------------------------------------
  w('## 1. Source authority');
  w();
  w(`**Runtime facts:** ${policy.source_authority.runtime_facts.map((r) => r.source).join(' > ')}`);
  w();
  w(`**Product decisions:** ${policy.source_authority.product_decisions.map((r) => r.source).join(' > ')}`);
  w();
  w('A Founder statement never by itself yields a runtime PASS.');
  w();
  w(`Only current-state authority: \`CURRENT_STATE.yaml\`. \`EVIDENCE_LEDGER.md\` is history and never authoritative for current state.`);
  w();

  // --- 2. Phase and value steps ---------------------------------------------------------
  w('## 2. Phase and value steps');
  w();
  w(`- Phase: **${state.roadmap_phase}**`);
  w(`- Current step: **${state.current_value_step.id} — ${state.current_value_step.title}** (${state.current_value_step.status})`);
  w(`- Next two: ${state.next_two_value_steps.map((s) => `**${s.id}** ${s.title}`).join(' → ')}`);
  w(`- main @ ${state.main.repository}: baseline \`${state.main.origin_main_sha}\` (${state.main.origin_main_sha_semantics}) — freshness mode ${state.main.freshness_check_mode}: baseline must be an ancestor of live origin/main; a live tip ahead of baseline stays FRESH only if every changed path is in the state-bootstrap allowlist (CURRENT_STATE.yaml, ARCHITECT_SNAPSHOT.md, EVIDENCE_LEDGER.md), otherwise STATE_REFRESH_REQUIRED`);
  w(`- Last accepted completion: ${state.last_accepted_completion_id === null ? 'none' : state.last_accepted_completion_id}`);
  w();

  // --- 3. Blockers ----------------------------------------------------------------------
  w('## 3. Blockers');
  w();
  w(bullets(state.open_blockers.map((b) => `\`${b.id}\` ${b.statement} (blocks: ${b.blocking})`)));
  w();

  // --- 4. Execution targets -------------------------------------------------------------
  w('## 4. Execution targets');
  w();
  for (const t of capability.execution_targets) {
    const proven = t.capabilities.filter((c) => c.verdict === 'PROVEN').map((c) => c.capability);
    const gaps = t.capabilities.filter((c) => c.verdict !== 'PROVEN').map((c) => c.capability);
    w(`**\`${t.executor_id}\`** — host_dependency ${t.host_dependency}, terminal_required ${t.founder_terminal_required}, surfaces ${t.access_surfaces.length ? t.access_surfaces.join('/') : 'none'}`);
    w(`- PROVEN: ${proven.length ? proven.join(', ') : 'none'}`);
    w(`- NOT PROVEN: ${gaps.length ? gaps.join(', ') : 'none'}`);
    w();
  }
  w(`Access surfaces are not executors: ${capability.access_surface_policy.surfaces.map((s) => `${s.id}→${s.reaches}`).join(', ')}.`);
  w();

  // --- 5. Routing -----------------------------------------------------------------------
  w('## 5. Routing (minimum agents — never all agents)');
  w();
  w('| Risk class | Executors | Required reviewers | Fail closed |');
  w('|---|---|---|---|');
  for (const rc of routing.risk_classes) {
    const targets = rc.eligible_execution_targets.length ? rc.eligible_execution_targets.join(', ') : '—';
    const revs = (rc.reviewer_receipt_requirements || [])
      .filter((r) => r.mandatory === true).map((r) => r.agent_id);
    w(`| \`${rc.id}\` | ${targets} | ${revs.length ? revs.join(', ') : '—'} | ${rc.fail_closed ? '**YES**' : 'no'} |`);
  }
  w();
  const r5 = routing.risk_classes.find((r) => r.id === 'R5_CROSS_REPO_OR_LIVE_MONEY');
  w(`R5 fails closed: default verdict \`${r5.fail_closed_behavior.default_verdict}\`, no eligible executor, no permitted repository.`);
  w();

  // --- 6. Prompt contract ---------------------------------------------------------------
  w('## 6. Prompt contract');
  w();
  w('Short Founder presentation + one executor block only. Every task invokes `premvp.command.execution_precheck.v1`; no default/substitution. Missing hard-boundary input → `PROMPT_GATE_BLOCKED`.');
  w();

  // --- 7. Reviewers ---------------------------------------------------------------------
  w('## 7. Reviewers and agents');
  w();
  const receiptAgents = registry.entries.filter((e) => e.type === 'AGENT' && e.receipt_required === true && e.status !== 'SUPERSEDED');
  for (const e of receiptAgents) {
    w(`- \`${e.canonical_id}\` — ${e.owner_platform}, ${e.invocation}, receipt REQUIRED, triggers: ${e.triggers.join('; ')}`);
  }
  const others = registry.entries.filter((e) => !(e.type === 'AGENT' && e.receipt_required === true && e.status !== 'SUPERSEDED'));
  const byType = {};
  for (const e of others) byType[e.type] = (byType[e.type] || 0) + 1;
  w(`- Other registered entries (no receipt or deprecated): ${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')} — see AGENT_REGISTRY.yaml.`);
  w();

  // --- 8. Boundary ----------------------------------------------------------------------
  w('## 8. PREMVP / Ireland boundary');
  w();
  w(`- PREMVP: \`${policy.repository_boundaries.premvp.repository}\` via ${policy.repository_boundaries.premvp.execution_targets.join(', ')}`);
  w(`- Ireland: ${policy.repository_boundaries.ireland.status}; access in Phase 1/2: ${policy.repository_boundaries.ireland.access_in_control_plane_phase_1_2}`);
  w('- PREMVP and Ireland implementation prompts cannot be mixed. One prompt, one repository boundary.');
  w();

  // --- 9. Operator ----------------------------------------------------------------------
  w('## 9. Operator');
  w();
  w(`- Interface: **${policy.architect_interface.default}**; Work is ${policy.architect_interface.work_mode}`);
  w(`- Operator mode: **${policy.operator_mode.default}**; action budget ${policy.founder_action_budget.preferred}–${policy.founder_action_budget.maximum_normal} per task`);
  w(`- Never in normal flow: ${policy.mobile_first_policy.normal_flow_must_not_require.join(', ')}`);
  w(`- Escape hatch: \`${policy.mobile_first_policy.break_glass.id}\``);
  w();

  // --- 10. Stop conditions --------------------------------------------------------------
  w('## 10. Stop conditions');
  w();
  w(policy.global_stop_conditions.map((s) => `\`${s.split(' — ')[0]}\``).join(' · '));
  w();
  w('Recoverable root/state/dependency/PR/deployment conditions are executor-owned; EXPECTED_NON_BLOCKING, EXECUTOR_OWNED_RECOVERY and RESUMABLE_WAIT always set founder_action none. Invalid ancestry and semantic boundaries remain hard stops.');
  w();

  // --- 11. Evidence ---------------------------------------------------------------------
  w('## 11. Evidence identifiers');
  w();
  w(`- Proven passes: ${state.proven_passes.map((p) => p.id).join(', ')}`);
  w(`- External checkpoints: ${state.external_accepted_checkpoints.map((c) => c.id).join(', ')}`);
  w(`- Freshness: ${state.evidence_freshness.max_age_days} days from ${state.updated_at}`);
  w(`- Stale when: ${state.stale_when.join('; ')}`);
  w();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : REPO_ROOT;
  const check = args.includes('--check');

  const rendered = renderSnapshot(root);
  const target = path.join(root, SNAPSHOT_REL);

  if (check) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (existing === rendered) {
      process.stdout.write('[control-plane] snapshot:check PASS — committed snapshot matches generated output\n');
      process.exit(0);
    }
    process.stderr.write(
      '[control-plane] snapshot:check FAIL — committed ARCHITECT_SNAPSHOT.md differs from the ' +
      'deterministic regeneration. Run: npm run control-plane:snapshot\n');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered, 'utf8');
  process.stdout.write(`[control-plane] snapshot written: ${SNAPSHOT_REL}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
