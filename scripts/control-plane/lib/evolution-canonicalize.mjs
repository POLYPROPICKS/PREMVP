/**
 * evolution-canonicalize.mjs
 *
 * Deterministic, dependency-free admission contract for the PolyProPicks Evolution-artifact
 * canonicalization lifecycle (premvp.command.evolution_canonicalize.v1).
 *
 * Contract source: docs/ai-context/control-plane/evolution/EVOLUTION_POLICY.yaml
 *                  docs/ai-context/control-plane/evolution/SCHEDULE_MANIFEST.yaml
 * Reuses:          scripts/control-plane/lib/evolution-cycle.mjs
 *                  scripts/control-plane/lib/evolution-governor.mjs
 *
 * This is the terminal persistence stage for the Daily Evolution Review and the Automation
 * Operations Governor. It converts an already validated, evidence-only Evolution/Governor
 * lineage into canonical origin/main without a Founder merge/review action.
 *
 * It is NOT a second state or evidence authority: it re-runs the existing Stage 1 / Stage 2
 * validators, hard-allowlists the exact Evolution evidence artifact surface, and fails closed
 * on anything else. It never decides what a cycle or Governor result means — that stays with
 * the Daily Evolution Review reviewer and the Automation Roadmap Governor reviewer.
 *
 * Fail-closed rules (each an explicit, phone-readable violation):
 *   1. any changed path outside the Evolution evidence allowlist            -> UNEXPECTED_CHANGED_PATH
 *   2. a malformed/invalid cycle or Governor result                         -> MALFORMED_ARTIFACT
 *   3. a rendered report that does not match its deterministic regeneration -> ARTIFACT_REPORT_MISMATCH
 *   4. a cycle/result canonicalized without its mandatory rendered report   -> MISSING_RENDERED_REPORT
 *   5. accepted:true, or any strategic authority field, anywhere            -> SELF_ACCEPTED_STRATEGIC_STATE
 *   6. a competing lineage for one evaluation period                        -> DUPLICATE_CANONICAL_CYCLE_FOR_PERIOD / COMPETING_LINEAGE_IN_BATCH
 *   7. more than one new cycle or new Governor result in one run            -> MULTIPLE_NEW_CYCLES_IN_BATCH / MULTIPLE_NEW_GOVERNOR_RESULTS_IN_BATCH
 *   8. a deletion of canonical Evolution evidence                           -> EVIDENCE_DELETION_NOT_ADMISSIBLE
 */

import {
  validateEvolutionCycle,
  renderFounderReport,
  derivePeriodKey,
} from './evolution-cycle.mjs';

import {
  validateGovernorResult,
  renderGovernorFounderReport,
  STRATEGIC_FIELD_KEYS,
} from './evolution-governor.mjs';

export const COMMAND_ID = 'premvp.command.evolution_canonicalize.v1';

export const CYCLES_PREFIX = 'docs/ai-context/control-plane/evolution/cycles/';
export const PROPOSALS_PREFIX = 'docs/ai-context/control-plane/evolution/roadmap-proposals/';
export const INPUT_BUNDLES_PREFIX = 'docs/ai-context/control-plane/evolution/input-bundles/';
export const DIAGRAMS_PREFIX = 'docs/ai-context/control-plane/evolution/diagrams/';

/**
 * The exact Evolution evidence artifact surface canonicalization may touch. Anything not
 * matched here is rejected — schemas, policies, prompts, SCHEDULE_MANIFEST, corrections,
 * CURRENT_STATE, AGENT_REGISTRY and every path outside evolution/ included.
 */
export const EVOLUTION_EVIDENCE_ALLOWLIST = Object.freeze([
  `${CYCLES_PREFIX}<cycle_id>.json`,
  `${CYCLES_PREFIX}<cycle_id>.report.md`,
  `${PROPOSALS_PREFIX}<result_id>.json`,
  `${PROPOSALS_PREFIX}<result_id>.report.md`,
  `${INPUT_BUNDLES_PREFIX}<bundle_id>.json`,
  `${DIAGRAMS_PREFIX}<diagram file>`,
]);

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Classifies one repo-relative changed path against the allowlist.
 * Returns { ok: true, family, id? } or { ok: false }.
 */
export function classifyEvolutionEvidencePath(p) {
  if (typeof p !== 'string' || p.length === 0) return { ok: false };

  const table = [
    { prefix: CYCLES_PREFIX, jsonFamily: 'CYCLE', reportFamily: 'CYCLE_REPORT' },
    { prefix: PROPOSALS_PREFIX, jsonFamily: 'GOVERNOR', reportFamily: 'GOVERNOR_REPORT' },
  ];
  for (const { prefix, jsonFamily, reportFamily } of table) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest.length === 0 || rest.includes('/') || rest === 'README.md') return { ok: false };
    if (rest.endsWith('.report.md')) return { ok: true, family: reportFamily, id: rest.slice(0, -'.report.md'.length) };
    if (rest.endsWith('.json')) return { ok: true, family: jsonFamily, id: rest.slice(0, -'.json'.length) };
    return { ok: false };
  }

  if (p.startsWith(INPUT_BUNDLES_PREFIX)) {
    const rest = p.slice(INPUT_BUNDLES_PREFIX.length);
    if (rest.length === 0 || rest.includes('/') || rest === 'README.md' || !rest.endsWith('.json')) return { ok: false };
    return { ok: true, family: 'INPUT_BUNDLE', id: rest.slice(0, -'.json'.length) };
  }

  if (p.startsWith(DIAGRAMS_PREFIX)) {
    const rest = p.slice(DIAGRAMS_PREFIX.length);
    if (rest.length === 0 || rest === 'README.md') return { ok: false };
    return { ok: true, family: 'DIAGRAM', id: rest };
  }

  return { ok: false };
}

/**
 * Deep-scans a persisted artifact object for the two things canonicalization must never let
 * through regardless of what the Stage 1 / Stage 2 validators already caught: a strategic
 * authority field anywhere in the tree, or a proposal representing itself as accepted.
 */
function scanStrategicAndAcceptance(node, label, push, seen = new Set()) {
  if (!isObject(node) || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (STRATEGIC_FIELD_KEYS.includes(key)) {
      push(`SELF_ACCEPTED_STRATEGIC_STATE: ${label} carries strategic authority field "${key}" — canonicalization never lets Evolution evidence mutate strategic authority; that stays behind a separate Promotion Gate`);
    }
    if (key === 'accepted' && value !== false) {
      push(`SELF_ACCEPTED_STRATEGIC_STATE: ${label} represents an unaccepted proposal as accepted (accepted:${JSON.stringify(value)}) — canonical policy requires accepted:false; a proposal requiring external acceptance is never canonicalized as accepted`);
    }
    if (isObject(value)) scanStrategicAndAcceptance(value, `${label}.${key}`, push, seen);
    else if (Array.isArray(value)) {
      value.forEach((item, i) => scanStrategicAndAcceptance(item, `${label}.${key}[${i}]`, push, seen));
    }
  }
}

/**
 * Decides whether a changed-path lineage is an admissible, evidence-only Evolution/Governor
 * canonicalization.
 *
 * @param {object} args
 * @param {string[]} args.changedPaths  repo-relative paths that differ between the lineage
 *                                      branch and origin/main.
 * @param {Record<string,(string|null)>} args.files  changedPath -> new file content on the
 *                                      branch; null marks a deletion.
 * @param {object} [args.canonical]     what is already on origin/main:
 *                                      { cycleIds: string[], cyclePeriods: {periodKey:cycleId},
 *                                        governorResultIds: string[] }. Optional — intra-lineage
 *                                      checks still run without it.
 * @returns {{ ok: boolean, errors: string[], admitted: object|null }}
 */
export function admitCanonicalizationLineage({ changedPaths = [], files = {}, canonical = {} } = {}) {
  const errors = [];
  const push = (m) => errors.push(m);

  const canonicalCycleIds = new Set(canonical.cycleIds || []);
  const canonicalCyclePeriods = new Map(Object.entries(canonical.cyclePeriods || {}));
  const canonicalGovernorIds = new Set(canonical.governorResultIds || []);

  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return {
      ok: false,
      errors: ['EMPTY_LINEAGE: canonicalization requires at least one changed Evolution evidence path'],
      admitted: null,
    };
  }

  // --- 1. hard allowlist ---------------------------------------------------------------
  const classified = [];
  for (const p of changedPaths) {
    const c = classifyEvolutionEvidencePath(p);
    if (!c.ok) {
      push(`UNEXPECTED_CHANGED_PATH: ${p} is outside the Evolution evidence artifact allowlist — canonicalization is hard-allowlisted to cycles/, roadmap-proposals/, input-bundles/ and diagrams/ evidence files only`);
      continue;
    }
    if (files[p] === null || files[p] === undefined) {
      if (files[p] === null) {
        push(`EVIDENCE_DELETION_NOT_ADMISSIBLE: ${p} is deleted in this lineage — canonicalization only adds or regenerates Evolution evidence, it never removes canonical evidence`);
      } else {
        push(`MISSING_LINEAGE_CONTENT: ${p} has no content supplied for admission`);
      }
      continue;
    }
    classified.push({ path: p, ...c });
  }
  if (errors.length) return { ok: false, errors, admitted: null };

  const reportPaths = new Set(classified.filter((c) => c.family.endsWith('_REPORT')).map((c) => c.path));
  const cyclesById = new Map();
  const governorsById = new Map();

  // --- 2. schema/semantic validation (mandatory before canonicalization) --------------
  for (const item of classified) {
    if (item.family !== 'CYCLE' && item.family !== 'GOVERNOR' && item.family !== 'INPUT_BUNDLE') continue;
    let parsed;
    try {
      parsed = JSON.parse(files[item.path]);
    } catch (e) {
      push(`MALFORMED_ARTIFACT: ${item.path} is not valid JSON (${e.message})`);
      continue;
    }

    if (item.family === 'INPUT_BUNDLE') {
      if (!isObject(parsed)) push(`MALFORMED_ARTIFACT: ${item.path} must be a JSON object`);
      scanStrategicAndAcceptance(parsed, item.path, push);
      continue;
    }

    if (item.family === 'CYCLE') {
      if (parsed.cycle_id !== item.id) {
        push(`ARTIFACT_FILENAME_MISMATCH: ${item.path} must be named <cycle_id>.json (cycle_id is ${JSON.stringify(parsed.cycle_id)})`);
      }
      const v = validateEvolutionCycle(parsed);
      if (!v.ok) v.errors.forEach((e) => push(`MALFORMED_ARTIFACT: ${item.path}: ${e}`));
      else cyclesById.set(item.id, parsed);
      scanStrategicAndAcceptance(parsed, item.path, push);
    }

    if (item.family === 'GOVERNOR') {
      if (parsed.result_id !== item.id) {
        push(`ARTIFACT_FILENAME_MISMATCH: ${item.path} must be named <result_id>.json (result_id is ${JSON.stringify(parsed.result_id)})`);
      }
      const v = validateGovernorResult(parsed);
      if (!v.ok) v.errors.forEach((e) => push(`MALFORMED_ARTIFACT: ${item.path}: ${e}`));
      else governorsById.set(item.id, parsed);
      scanStrategicAndAcceptance(parsed, item.path, push);
    }
  }

  // --- 3. rendered reports are regenerated, never hand-authored -----------------------
  for (const item of classified) {
    if (item.family === 'CYCLE_REPORT') {
      const cycle = cyclesById.get(item.id);
      if (!cycle) {
        push(`ORPHAN_REPORT: ${item.path} has no admissible ${item.id}.json cycle in the same lineage`);
        continue;
      }
      if (files[item.path] !== renderFounderReport(cycle)) {
        push(`ARTIFACT_REPORT_MISMATCH: ${item.path} does not match the deterministic render of its cycle — the Founder report is regenerated by the validator, never hand-edited`);
      }
    }
    if (item.family === 'GOVERNOR_REPORT') {
      const result = governorsById.get(item.id);
      if (!result) {
        push(`ORPHAN_REPORT: ${item.path} has no admissible ${item.id}.json Governor result in the same lineage`);
        continue;
      }
      if (files[item.path] !== renderGovernorFounderReport(result)) {
        push(`ARTIFACT_REPORT_MISMATCH: ${item.path} does not match the deterministic render of its Governor result — the Founder report is regenerated by the validator, never hand-edited`);
      }
    }
  }

  // --- 4. schema + rendered report are mandatory together ----------------------------
  for (const id of cyclesById.keys()) {
    if (!reportPaths.has(`${CYCLES_PREFIX}${id}.report.md`)) {
      push(`MISSING_RENDERED_REPORT: ${CYCLES_PREFIX}${id}.json is canonicalized without its ${id}.report.md — schema validation and the rendered report are mandatory together`);
    }
  }
  for (const id of governorsById.keys()) {
    if (!reportPaths.has(`${PROPOSALS_PREFIX}${id}.report.md`)) {
      push(`MISSING_RENDERED_REPORT: ${PROPOSALS_PREFIX}${id}.json is canonicalized without its ${id}.report.md — schema validation and the rendered report are mandatory together`);
    }
  }

  // --- 5. one-period / one-lineage + uniqueness --------------------------------------
  const periodToId = new Map();
  for (const [id, cycle] of cyclesById) {
    const periodKey = derivePeriodKey(cycle.period_start);
    if (periodKey === null) {
      push(`MALFORMED_ARTIFACT: ${CYCLES_PREFIX}${id}.json has no resolvable evaluation period`);
      continue;
    }
    if (periodToId.has(periodKey) && periodToId.get(periodKey) !== id) {
      push(`COMPETING_LINEAGE_IN_BATCH: evaluation period ${periodKey} is claimed by both ${periodToId.get(periodKey)} and ${id} in one canonicalization`);
    } else {
      periodToId.set(periodKey, id);
    }
    const canonicalOwner = canonicalCyclePeriods.get(periodKey);
    if (canonicalOwner && canonicalOwner !== id) {
      push(`DUPLICATE_CANONICAL_CYCLE_FOR_PERIOD: evaluation period ${periodKey} already belongs to canonical cycle ${canonicalOwner} — ${id} would be a competing lineage`);
    }
  }

  const newCycleIds = [...cyclesById.keys()].filter((id) => !canonicalCycleIds.has(id));
  if (newCycleIds.length > 1) {
    push(`MULTIPLE_NEW_CYCLES_IN_BATCH: canonicalization admits at most one new Evolution cycle per run (found ${newCycleIds.join(', ')})`);
  }
  const newGovernorIds = [...governorsById.keys()].filter((id) => !canonicalGovernorIds.has(id));
  if (newGovernorIds.length > 1) {
    push(`MULTIPLE_NEW_GOVERNOR_RESULTS_IN_BATCH: canonicalization admits at most one new Governor result per run (found ${newGovernorIds.join(', ')})`);
  }

  // A lineage that changed nothing admissible (only orphan reports were rejected above,
  // or only input bundles / diagrams with no cycle or result) is still fine for input
  // bundles + diagrams, but a report-only or empty admission is not.
  const admissibleArtifacts =
    cyclesById.size + governorsById.size +
    classified.filter((c) => c.family === 'INPUT_BUNDLE' || c.family === 'DIAGRAM').length;
  if (errors.length === 0 && admissibleArtifacts === 0) {
    push('NO_ADMISSIBLE_ARTIFACT: the lineage contains no admissible Evolution evidence artifact to canonicalize');
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    admitted: ok
      ? {
          command_id: COMMAND_ID,
          cycles: [...cyclesById.keys()],
          governor_results: [...governorsById.keys()],
          input_bundles: classified.filter((c) => c.family === 'INPUT_BUNDLE').map((c) => c.path),
          diagrams: classified.filter((c) => c.family === 'DIAGRAM').map((c) => c.path),
          new_cycles: newCycleIds,
          new_governor_results: newGovernorIds,
        }
      : null,
  };
}
