import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONTROL = 'docs/ai-context/control-plane';
const STATE_FILES = ['CURRENT_STATE.yaml', 'EVIDENCE_LEDGER.md', 'ARCHITECT_SNAPSHOT.md'];
const SHA_RE = /^[0-9a-f]{40}$/i;

function requireFullSha(value, code) {
  if (!SHA_RE.test(value || '')) throw new Error(`${code}: expected one full commit SHA`);
  return value.toLowerCase();
}

/**
 * Produce the narrowly permitted factual CURRENT_STATE delta for a change that has
 * already been accepted by a merge to origin/main.  This deliberately has no product,
 * runtime, capability, roadmap, or acceptance inputs: those remain outside the writer.
 */
export function buildFactualStateDelta({ state, completion, mergeSha, observedAt, isAncestor }) {
  if (!state || typeof state !== 'object') throw new Error('RECONCILE_STATE_REQUIRED');
  if (!completion || typeof completion !== 'object') throw new Error('RECONCILE_COMPLETION_REQUIRED');
  if (completion.repository !== 'POLYPROPICKS/PREMVP') throw new Error('RECONCILE_WRONG_REPOSITORY');
  if (completion.verdict !== 'PASS' || completion.outcome_class !== 'TERMINAL_PASS') {
    throw new Error('RECONCILE_COMPLETION_NOT_TERMINAL_PASS');
  }
  const resultSha = requireFullSha(completion.result_sha, 'RECONCILE_RESULT_SHA_INVALID');
  const acceptedMergeSha = requireFullSha(mergeSha, 'RECONCILE_MERGE_SHA_INVALID');
  if (typeof isAncestor !== 'function' || !isAncestor(resultSha, acceptedMergeSha)) {
    throw new Error('RECONCILE_IMPLEMENTATION_NOT_IN_ACCEPTED_MERGE');
  }
  if (typeof isAncestor !== 'function' || !isAncestor(acceptedMergeSha, 'origin/main')) {
    throw new Error('RECONCILE_MERGE_NOT_ACCEPTED_ON_MAIN');
  }
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
    throw new Error('RECONCILE_OBSERVED_AT_INVALID');
  }
  const existing = Array.isArray(state.accepted_completions) ? state.accepted_completions : [];
  const alreadyRecorded = existing.some((item) => item && item.id === completion.completion_id);
  if (alreadyRecorded) {
    return { changed: false, state, accepted_completion_id: completion.completion_id };
  }
  const next = structuredClone(state);
  const completionFact = {
    id: completion.completion_id,
    evidence_class: 'PROVEN_IN_RUNTIME',
    statement: `Accepted PREMVP completion ${completion.completion_id} reconciled from its terminal PASS envelope and exact merge ancestry.`,
    implementation_sha: resultSha,
    merge_commit: acceptedMergeSha,
    evidence_ref: `COMPLETION_ENVELOPE#${completion.completion_id}`,
  };
  next.state_version = Number(next.state_version || 0) + 1;
  next.updated_at = observedAt;
  next.main = {
    ...next.main,
    origin_main_sha: acceptedMergeSha,
    origin_main_sha_semantics: 'LAST_VERIFIED_ORIGIN_MAIN_BASELINE',
    freshness_check_mode: 'BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE',
    proof: {
      evidence_class: 'PROVEN_IN_RUNTIME',
      commands: [
        `git merge-base --is-ancestor ${acceptedMergeSha} origin/main`,
        `git merge-base --is-ancestor ${resultSha} ${acceptedMergeSha}`,
      ],
      observed_at: observedAt,
      note: 'Automatic factual reconciliation. This records only an already-accepted PREMVP merge and terminal completion lineage; it does not accept product, runtime, capability, roadmap, business, or PnL claims.',
    },
  };
  next.accepted_completions = [...existing, completionFact];
  next.last_accepted_completion_id = completion.completion_id;
  next.evidence_freshness = { ...next.evidence_freshness, origin_main_sha_checked_at: observedAt };
  return { changed: true, state: next, accepted_completion_id: completion.completion_id };
}

export function normalizeBaseline({ baseline, intendedHead, resolveCommit, isAncestor }) {
  if (typeof baseline !== 'string' || baseline.trim().length === 0) {
    throw new Error('RECONCILE_BASELINE_REQUIRED: --apply-state requires a baseline');
  }
  if (typeof resolveCommit !== 'function' || typeof isAncestor !== 'function') {
    throw new Error('RECONCILE_BASELINE_RESOLUTION_REQUIRED: live Git resolution adapters are required');
  }
  const resolved = resolveCommit(baseline.trim());
  if (!/^[0-9a-f]{40}$/i.test(resolved || '')) {
    throw new Error('RECONCILE_BASELINE_UNRESOLVED: baseline must resolve to one full commit SHA');
  }
  if (!isAncestor(resolved, intendedHead)) {
    throw new Error('RECONCILE_BASELINE_NOT_ANCESTOR: resolved baseline is not an ancestor of intended head');
  }
  return resolved.toLowerCase();
}

export function reconcilePlan({ mode, baseline = null, intendedHead = null, resolveCommit = null, isAncestor = null }) {
  if (!['plan', 'apply-non-state', 'apply-state', 'verify'].includes(mode)) {
    throw new Error(`RECONCILE_INVALID_MODE: ${mode}`);
  }
  let baselineResolvedSha = null;
  if (mode === 'apply-state') {
    baselineResolvedSha = normalizeBaseline({ baseline, intendedHead, resolveCommit, isAncestor });
  }
  return { command_id: 'premvp.command.control_plane_reconcile.v1', mode, baseline_input: baseline, baseline_resolved_sha: baselineResolvedSha,
    state_files: STATE_FILES.map((f) => `${CONTROL}/${f}`), atomic: true,
    authority: ['live Git/runtime evidence', 'CURRENT_STATE.yaml', 'CAPABILITY_MATRIX.yaml', 'ROUTING_AND_PIPELINES.yaml', 'AGENT_REGISTRY.yaml', 'PROMPT__PROTOCOL.md'] };
}

export function stageAtomically(root, writes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-reconcile-'));
  try {
    for (const [relative, content] of Object.entries(writes)) {
      const candidate = path.join(dir, relative);
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, content, 'utf8');
      JSON.parse(content);
    }
    for (const [relative] of Object.entries(writes)) {
      fs.renameSync(path.join(dir, relative), path.join(root, relative));
    }
    return { ok: true, phase: 'REPLACED_ATOMICALLY' };
  } catch (error) {
    return { ok: false, phase: 'STAGING_VALIDATION', error: error.message };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
