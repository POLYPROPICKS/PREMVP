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
  w('<!-- GENERATED FILE — do not edit by hand. -->');
  w('<!-- Regenerate: npm run control-plane:snapshot -->');
  w('<!-- Verify:     npm run control-plane:snapshot:check -->');
  w();
  w(`**State version:** ${state.state_version}  `);
  w(`**State updated_at:** ${state.updated_at}  `);
  w(`**Policy version:** ${policy.policy_version}  `);
  w(`**Source artifact versions:** policy ${policy.schema_version} · state ${state.schema_version} · capability ${capability.schema_version} · routing ${routing.schema_version} · registry ${registry.schema_version}`);
  w();

  // --- Source authority ---------------------------------------------------------------
  w('## 1. Source authority');
  w();
  w('**Runtime and source facts (highest first):**');
  w();
  w(policy.source_authority.runtime_facts.map((r) => `${r.rank}. ${r.source}`).join('\n'));
  w();
  w(`> ${policy.source_authority.runtime_facts_rule}`);
  w();
  w('**Product, roadmap and authority decisions (highest first):**');
  w();
  w(policy.source_authority.product_decisions.map((r) => `${r.rank}. ${r.source}`).join('\n'));
  w();
  w(`- Only current-state authority: \`${policy.canonical_artifacts.single_current_state_authority.artifact}\``);
  w(`- \`${policy.canonical_artifacts.evidence_ledger_authority.artifact}\` is historical and never authoritative for current state.`);
  w();

  // --- Phase and value steps ------------------------------------------------------------
  w('## 2. Current phase and value steps');
  w();
  w(`- **Roadmap phase:** ${state.roadmap_phase}`);
  w(`- **Current value step:** ${state.current_value_step.id} — ${state.current_value_step.title} (${state.current_value_step.status})`);
  w(`  - value target: ${state.current_value_step.value_target}`);
  w('- **Next two value steps:**');
  state.next_two_value_steps.forEach((s, i) => {
    w(`  ${i + 1}. ${s.id} — ${s.title} (${s.status})`);
  });
  w(`- **main @ ${state.main.repository}:** \`${state.main.origin_main_sha}\` (${state.main.proof.evidence_class})`);
  w(`- **Last accepted completion id:** ${state.last_accepted_completion_id === null ? 'none' : state.last_accepted_completion_id}`);
  w();

  // --- Blockers -------------------------------------------------------------------------
  w('## 3. Current blockers');
  w();
  w(bullets(state.open_blockers.map((b) => `\`${b.id}\` (${b.owner_executor}) — ${b.statement} → blocks: ${b.blocking}`)));
  w();
  w('**Proven failures:**');
  w();
  w(bullets(state.proven_failures.map((f) => `\`${f.id}\` (${f.evidence_class}) — ${f.statement}`)));
  w();

  // --- Execution targets ----------------------------------------------------------------
  w('## 4. Execution targets and proven capabilities');
  w();
  for (const t of capability.execution_targets) {
    w(`### \`${t.executor_id}\``);
    w();
    w(`- runtime: \`${t.runtime}\``);
    w(`- repository scope: ${t.repository_scope.map((r) => `\`${r}\``).join(', ')}`);
    w(`- host_dependency: \`${t.host_dependency}\``);
    w(`- access surfaces: ${t.access_surfaces.length ? t.access_surfaces.map((s) => `\`${s}\``).join(', ') : '(none)'}`);
    w(`- founder_terminal_required: \`${t.founder_terminal_required}\``);
    const proven = t.capabilities.filter((c) => c.verdict === 'PROVEN').map((c) => c.capability);
    const notProven = t.capabilities.filter((c) => c.verdict !== 'PROVEN').map((c) => `${c.capability} (${c.verdict})`);
    w(`- PROVEN: ${proven.length ? proven.join(', ') : '(none)'}`);
    w(`- NOT PROVEN / NOT AVAILABLE: ${notProven.length ? notProven.join(', ') : '(none)'}`);
    w();
  }
  w('**Access surfaces are not executors:**');
  w();
  w(bullets(capability.access_surface_policy.surfaces.map(
    (s) => `\`${s.id}\` → reaches \`${s.reaches}\`${s.via ? ` via ${s.via}` : ''}`)));
  w();

  // --- Routing summary ------------------------------------------------------------------
  w('## 5. Routing summary');
  w();
  w(`> ${routing.minimum_agent_policy.rule}`);
  w();
  w('| Risk class | Eligible executors | Required agents | Fail closed | Founder actions | Mobile |');
  w('|---|---|---|---|---|---|');
  for (const rc of routing.risk_classes) {
    const targets = rc.eligible_execution_targets.length ? rc.eligible_execution_targets.join(', ') : '—';
    const agents = rc.required_agents.length ? rc.required_agents.join(', ') : '—';
    w(`| \`${rc.id}\` | ${targets} | ${agents} | ${rc.fail_closed ? 'YES' : 'no'} | ${rc.founder_action_budget} | ${rc.mobile_compatible ? 'yes' : 'no'} |`);
  }
  w();
  const r5 = routing.risk_classes.find((r) => r.id === 'R5_CROSS_REPO_OR_LIVE_MONEY');
  w(`- **R5 fail-closed:** default verdict \`${r5.fail_closed_behavior.default_verdict}\`. ${r5.fail_closed_behavior.rule}`);
  w();

  // --- Mandatory prompt sections --------------------------------------------------------
  w('## 6. Mandatory prompt sections');
  w();
  w('Every executor prompt must contain all 25 sections of `PROMPT__PROTOCOL.md`:');
  w();
  w('`MODEL` · `MODEL LEVEL` · `SESSION MODE` · `SESSION REASON` · `EXECUTION ENVIRONMENT` · `REPOSITORY / WORKTREE / CWD` · `BRANCH / TARGET REF / TARGET SHA` · `TOKEN / READ BUDGET` · `VALUE TARGET` · `CURRENT ROADMAP PHASE` · `NEXT TWO VALUE STEPS` · `OPERATOR MODE` · `TASK CLASS` · `RISK CLASS` · `REQUIRED CAPABILITIES` · `REQUIRED AGENTS / REVIEWERS` · `PRECHECK` · `EXECUTION SCOPE` · `ALLOWED FILES` · `FORBIDDEN FILES` · `WRITE POLICY` · `STOP CONDITIONS` · `EVIDENCE REQUIRED` · `COMPLETION ENVELOPE` · `FOUNDER ACTION`');
  w();
  w('Missing, guessed or contradictory input → `PROMPT_GATE_BLOCKED`.');
  w();

  // --- Agents ---------------------------------------------------------------------------
  w('## 7. Agent and reviewer availability');
  w();
  w('| Canonical id | Type | Platform | Status | Invocation | Receipt |');
  w('|---|---|---|---|---|---|');
  for (const e of registry.entries) {
    w(`| \`${e.canonical_id}\` | ${e.type} | ${e.owner_platform} | ${e.status} | ${e.invocation} | ${e.receipt_required ? 'REQUIRED' : '—'} |`);
  }
  w();

  // --- Boundary -------------------------------------------------------------------------
  w('## 8. PREMVP / Ireland boundary');
  w();
  w(`- PREMVP repository: \`${policy.repository_boundaries.premvp.repository}\` — executors: ${policy.repository_boundaries.premvp.execution_targets.join(', ')}`);
  w(`- Ireland: \`${policy.repository_boundaries.ireland.status}\` — remote identity \`${policy.repository_boundaries.ireland.repository}\`, access in Phase 1/2: \`${policy.repository_boundaries.ireland.access_in_control_plane_phase_1_2}\``);
  w(`- ${policy.repository_boundaries.mixing_rule}`);
  w(`- Cross-repository implementation: \`${policy.repository_boundaries.cross_repository_implementation}\``);
  w();

  // --- Operator -------------------------------------------------------------------------
  w('## 9. Operator policy');
  w();
  w(`- Architect interface: **${policy.architect_interface.default}** (Work: ${policy.architect_interface.work_mode})`);
  w(`- Project: **${policy.architect_interface.project_name}**, memory **${policy.architect_interface.memory_mode}**`);
  w(`- Operator mode default: **${policy.operator_mode.default}**`);
  w(`- Founder action budget: preferred ${policy.founder_action_budget.preferred}, maximum ${policy.founder_action_budget.maximum_normal} (${policy.founder_action_budget.unit})`);
  w('- Normal flow must never require: ' + policy.mobile_first_policy.normal_flow_must_not_require.map((x) => `\`${x}\``).join(', '));
  w(`- Escape hatch: \`${policy.mobile_first_policy.break_glass.id}\` — ${policy.mobile_first_policy.break_glass.allowed_when}`);
  w();

  // --- Stop conditions ------------------------------------------------------------------
  w('## 10. Global stop conditions');
  w();
  w(bullets(policy.global_stop_conditions));
  w();
  w(`**Stale state behavior:** \`${policy.stale_state_behavior.mode}\` — ${policy.stale_state_behavior.rule}`);
  w();

  // --- Evidence identifiers -------------------------------------------------------------
  w('## 11. Latest evidence identifiers');
  w();
  const evidenceIds = [
    ...state.proven_passes.map((p) => `\`${p.id}\` — ${p.executor} — ${p.evidence_class}${p.evidence_ref ? ` — ${p.evidence_ref}` : ''}`),
    ...state.external_accepted_checkpoints.map((c) => `\`${c.id}\` — ${c.evidence_class}`),
  ];
  w(bullets(evidenceIds));
  w();
  w(`**Evidence freshness window:** ${state.evidence_freshness.max_age_days} days from \`${state.updated_at}\`.`);
  w();
  w('**Stale when:**');
  w();
  w(bullets(state.stale_when));
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
