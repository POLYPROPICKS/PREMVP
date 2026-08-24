/**
 * premvp-release-pipeline.mjs
 *
 * Core engine for premvp.release_pipeline.v1 — the resumable, idempotent PREMVP release
 * orchestration state machine described in
 * docs/ai-context/control-plane/pipelines/PREMVP_RELEASE_PIPELINE_V1.yaml.
 *
 * This module is transport-free: every GitHub, Git, deployment, reviewer and checkpoint
 * operation is received through an injected adapter object so the state machine can be
 * exercised deterministically in tests with fake adapters, and so the real CLI (run-premvp-
 * release.mjs) is the only place that wires in live transports.
 *
 * Live evidence always outranks the optional local checkpoint — see reconstructRun().
 */

import { validateReleaseRunManifest, isAuthorizedBoundedR5Manifest, RECONCILE_COMMAND_ID } from '../validate-premvp-release-run.mjs';

export const STATE_ORDER = [
  'LOAD_CANONICAL',
  'LIVE_PRECHECK',
  'RESOLVE_RUN',
  'VALIDATE_CHANGESET',
  'RUN_TESTS',
  'RESOLVE_REVIEWER',
  'INVOKE_REVIEWER',
  'PUSH_BRANCH',
  'RESOLVE_OR_CREATE_PR',
  'VERIFY_PR_INTEGRITY',
  'MERGE_PR',
  'VERIFY_MAIN_ANCESTRY',
  'POLL_AUTOMATIC_DEPLOYMENT',
  'RECONCILE_CONTROL_PLANE',
  'FINAL_EXACT_SHA_REVIEW',
  'COMPLETE',
];

export class PipelineError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export class R5FailClosedError extends PipelineError {
  constructor(message) {
    super('R5_FAIL_CLOSED', message || 'R5_CROSS_REPO_OR_LIVE_MONEY always fails closed');
  }
}

/** ---- Reviewer routing: strictly derived from live ROUTING_AND_PIPELINES.yaml. ---- */
export function resolveReviewerRequirement(routingDoc, riskClass, manifest = null) {
  if (riskClass === 'R5_CROSS_REPO_OR_LIVE_MONEY') {
    if (!isAuthorizedBoundedR5Manifest(manifest)) throw new R5FailClosedError();
    const r5 = (routingDoc.risk_classes || []).find((r) => r.id === riskClass);
    const route = (r5?.authorized_bounded_routes || []).find(
      (candidate) => candidate.id === manifest.r5_authorization.route_id &&
        candidate.authorization_ref === manifest.r5_authorization.authorization_ref &&
        candidate.executor === manifest.executor &&
        candidate.repository === manifest.repository &&
        candidate.release_allowed === true,
    );
    if (!route) throw new R5FailClosedError('R5 authorization is not represented by live routing');
    return { required: true, agentId: route.required_reviewer, independenceGroup: 'contur_gate' };
  }
  const riskEntry = (routingDoc.risk_classes || []).find((r) => r.id === riskClass);
  if (!riskEntry) {
    throw new PipelineError('UNKNOWN_RISK_CLASS', `No routing entry for risk class ${riskClass}`);
  }
  const mandatory = (riskEntry.reviewer_receipt_requirements || []).filter((r) => r.mandatory === true);
  if (mandatory.length === 0) {
    return { required: false, agentId: null };
  }
  // Exactly one mandatory reviewer is expected per current risk classes (R3/R4).
  return { required: true, agentId: mandatory[0].agent_id, independenceGroup: mandatory[0].independence_group };
}

/** A manifest field can never suppress or add a reviewer — routing is the only source. */
export function assertManifestCannotOverrideReviewer(manifest) {
  if (manifest.required_reviewer_override) {
    throw new PipelineError(
      'PIPELINE_REVIEWER_ROUTING_UNSAFE',
      'Manifest attempted to set required_reviewer_override; reviewer requirement is derived from live routing only',
    );
  }
}

/** ---- Changeset validation. ---- */
export function checkChangeset(changedFiles, allowedFiles, forbiddenFiles) {
  const violations = [];
  const allowedSet = new Set(allowedFiles);
  for (const f of changedFiles) {
    if (!allowedSet.has(f)) violations.push(`NOT_IN_ALLOWED_FILES: ${f}`);
  }
  for (const f of changedFiles) {
    for (const forbidden of forbiddenFiles || []) {
      if (f === forbidden || f.startsWith(forbidden.endsWith('/') ? forbidden : `${forbidden}/`)) {
        violations.push(`FORBIDDEN_FILE_TOUCHED: ${f}`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/** ---- Mutating-mode gate. The pipeline spec is the single source of the enable switch. ---- */
export function assertMutationAllowed(pipelineSpec) {
  if (pipelineSpec.enabled !== true || pipelineSpec.status !== 'ENABLED') {
    throw new PipelineError(
      'PIPELINE_MUTATING_MODE_NOT_DISABLED',
      `Mutating execution is refused: pipeline status is ${pipelineSpec.status} (enabled=${pipelineSpec.enabled}). ` +
      `Activation requires ${pipelineSpec.disabled_until_command || RECONCILE_COMMAND_ID}.`,
    );
  }
}

/**
 * Live reconstruction. Never trusts the local checkpoint over live evidence — the checkpoint
 * is consulted last and only to fill in operator-facing metadata, never phase completion.
 *
 * adapters:
 *   git:      { branchHeadSha(branch) -> string|null, isAncestor(sha, ref) -> boolean }
 *   github:   { findPullRequest({repo, head, base}) -> PR|null }
 *   deploy:   { getProductionSha(url) -> string|null }
 *   reviewer: { findReceipt({agentId, reviewedSha}) -> receipt|null }
 *   checkpoint (optional): { load(releaseRunId) -> object|null }
 */
export async function reconstructRun(manifest, routingDoc, adapters) {
  const evidence = { source: 'LIVE' };
  let phaseCompletedThrough = 'RESOLVE_RUN';

  const headSha = await adapters.git.branchHeadSha(manifest.feature_branch);
  evidence.branch = { exists: Boolean(headSha), headSha: headSha || null };
  if (!headSha) {
    if (adapters.checkpoint) {
      evidence.checkpoint = await adapters.checkpoint.load(manifest.release_run_id);
      evidence.checkpoint_authoritative = false;
    }
    return { phaseCompletedThrough, evidence };
  }
  phaseCompletedThrough = 'PUSH_BRANCH';

  const pr = await adapters.github.findPullRequest({
    repo: manifest.repository,
    head: manifest.feature_branch,
    base: manifest.base_ref,
  });
  evidence.pull_request = pr || null;
  if (!pr) return { phaseCompletedThrough, evidence };
  phaseCompletedThrough = 'RESOLVE_OR_CREATE_PR';

  if (pr.headSha === headSha) {
    phaseCompletedThrough = 'VERIFY_PR_INTEGRITY';
  }

  if (pr.merged) {
    phaseCompletedThrough = 'MERGE_PR';
    const isAncestor = await adapters.git.isAncestor(pr.mergeCommitSha, 'origin/main');
    evidence.main_ancestry = isAncestor;
    if (isAncestor) {
      phaseCompletedThrough = 'VERIFY_MAIN_ANCESTRY';

      const productionSha = await adapters.deploy.getProductionSha(manifest.production_build_info_url);
      evidence.production_sha = productionSha || null;
      if (productionSha === pr.mergeCommitSha) {
        phaseCompletedThrough = 'POLL_AUTOMATIC_DEPLOYMENT';
      }
    }
  }

  const reviewerReq = resolveReviewerRequirement(routingDoc, manifest.risk_class, manifest);
  evidence.reviewer_requirement = reviewerReq;
  if (reviewerReq.required) {
    const receipt = await adapters.reviewer.findReceipt({
      agentId: reviewerReq.agentId,
      reviewedSha: headSha,
    });
    evidence.reviewer_receipt = receipt || null;
  }

  return { phaseCompletedThrough, evidence };
}

/** ---- Idempotent PR resolution. ---- */
export async function resolveOrCreatePr(adapters, { repository, head, base, title, body, expectedHeadSha }) {
  const existing = await adapters.github.findPullRequest({ repo: repository, head, base });
  // A merged PR on the same reusable branch cannot represent a newly pushed commit.
  // Reuse it only when it already carries the exact result SHA; otherwise create the
  // next PR for the branch rather than failing integrity before that safe operation.
  if (existing && (!existing.merged || !expectedHeadSha || existing.headSha === expectedHeadSha)) {
    return { pr: existing, created: false };
  }
  const created = await adapters.github.createPullRequest({ repo: repository, head, base, title, body });
  return { pr: created, created: true };
}

/** ---- Idempotent merge: never merges an already-merged PR. ---- */
export async function mergePrIdempotent(adapters, pr) {
  if (pr.merged) return { pr, merged: false, alreadyMerged: true };
  const result = await adapters.github.mergePullRequest({
    repo: pr.repo,
    number: pr.number,
    expectedHeadSha: pr.headSha,
  });
  return { pr: { ...pr, merged: true, mergeCommitSha: result.mergeCommitSha }, merged: true, alreadyMerged: false };
}

/** ---- Deployment poll with bounded timeout; returns WAIT (never rollback) on timeout. ---- */
export async function pollAutomaticDeployment(adapters, { url, targetSha, timeoutSeconds, pollIntervalMs = 1000, now = () => Date.now(), sleep }) {
  const deadline = now() + timeoutSeconds * 1000;
  // Check-first: a matching SHA already deployed skips polling entirely.
  let sha = await adapters.deploy.getProductionSha(url);
  if (sha === targetSha) return { status: 'DEPLOYED', sha };

  while (now() < deadline) {
    if (sleep) await sleep(pollIntervalMs);
    sha = await adapters.deploy.getProductionSha(url);
    if (sha === targetSha) return { status: 'DEPLOYED', sha };
    if (!sleep) break; // Deterministic single-pass mode for tests that assert WAIT immediately.
  }
  return { status: 'WAIT', sha };
}

/** ---- Idempotent reviewer resolution: reuse receipt, poll pending, invoke exactly once. ---- */
export async function resolveReviewerReceipt(adapters, { agentId, reviewedSha }) {
  const existing = await adapters.reviewer.findReceipt({ agentId, reviewedSha });
  if (existing) {
    if (existing.reviewed_sha && existing.reviewed_sha !== reviewedSha) {
      throw new PipelineError('REVIEWER_RECEIPT_MISMATCH', `Receipt reviewed_sha ${existing.reviewed_sha} != ${reviewedSha}`);
    }
    if (existing.status === 'PENDING') {
      return { receipt: existing, status: 'PENDING', invoked: false };
    }
    return { receipt: existing, status: 'REUSED', invoked: false };
  }
  const invoked = await adapters.reviewer.invoke({ agentId, reviewedSha });
  return { receipt: invoked, status: invoked.status === 'PENDING' ? 'PENDING' : 'INVOKED', invoked: true };
}

/**
 * Top-level dry-run: validates the manifest, resolves reviewer requirement from live routing,
 * and returns the planned state sequence. Performs zero repository or GitHub mutation and
 * calls no mutating adapter method.
 */
export function dryRunPlan(manifest, routingDoc, pipelineSpec) {
  const manifestResult = validateReleaseRunManifest(manifest);
  if (!manifestResult.ok) {
    return { ok: false, errors: manifestResult.errors, plan: null };
  }
  assertManifestCannotOverrideReviewer(manifest);
  const reviewer = resolveReviewerRequirement(routingDoc, manifest.risk_class, manifest);
  return {
    ok: true,
    errors: [],
    plan: {
      release_run_id: manifest.release_run_id,
      pipeline_status: pipelineSpec.status,
      mutating_mode_enabled: pipelineSpec.enabled === true,
      states: STATE_ORDER,
      reviewer_requirement: reviewer,
      activation_dependency: pipelineSpec.disabled_until_command,
    },
  };
}

/** Two active runs must not share a release_run_id across different repository/base/task identity. */
export function assertRunIdentityConsistent(manifest, checkpoint) {
  if (!checkpoint) return;
  const mismatched = ['repository', 'base_ref', 'task_id'].filter((k) => checkpoint[k] && checkpoint[k] !== manifest[k]);
  if (mismatched.length > 0) {
    throw new PipelineError(
      'PIPELINE_RUN_IDENTITY_MISMATCH',
      `release_run_id ${manifest.release_run_id} checkpoint disagrees on: ${mismatched.join(', ')}`,
    );
  }
}

/** A PASS verdict is refused whenever any invariant below is violated. */
export function assertPassInvariants({ testsPassed, reviewerRequired, requiredReceiptPresent, receiptShaMatches, blockers, worktreeClean }) {
  const violations = [];
  if (!testsPassed) violations.push('a required test/command failed');
  if (reviewerRequired && !requiredReceiptPresent) violations.push('a required reviewer receipt is absent');
  if (reviewerRequired && requiredReceiptPresent && !receiptShaMatches) violations.push('reviewer receipt reviewed_sha differs from result_sha');
  if (Array.isArray(blockers) && blockers.length > 0) violations.push('blockers is non-empty');
  if (!worktreeClean) violations.push('final worktree is unexpectedly dirty');
  return { canPass: violations.length === 0, violations };
}

export function statusReport(reconstructed, manifest, pipelineSpec) {
  return {
    release_run_id: manifest.release_run_id,
    pipeline_status: pipelineSpec.status,
    mutating_mode_enabled: pipelineSpec.enabled === true,
    phase_completed_through: reconstructed.phaseCompletedThrough,
    next_state: STATE_ORDER[STATE_ORDER.indexOf(reconstructed.phaseCompletedThrough) + 1] || 'COMPLETE',
    evidence: reconstructed.evidence,
  };
}

/**
 * Execute the registered PREMVP release lifecycle through injected transports.
 * The real CLI binds these transports to the selected local executor; tests use
 * fakes. This keeps the ordering, exact-SHA review gate and idempotency rules
 * in one place rather than leaving the enabled command as a non-executable
 * specification.
 */
export async function executeReleaseRun(manifest, routingDoc, pipelineSpec, adapters) {
  const manifestResult = validateReleaseRunManifest(manifest);
  if (!manifestResult.ok) throw new PipelineError('PIPELINE_SCHEMA_INVALID', manifestResult.errors.join('; '));
  assertMutationAllowed(pipelineSpec);
  assertManifestCannotOverrideReviewer(manifest);

  const resultSha = await adapters.git.currentHead();
  const changedFiles = await adapters.git.changedFiles(manifest.base_ref, resultSha);
  const changeset = checkChangeset(changedFiles, manifest.allowed_files, manifest.forbidden_files);
  if (!changeset.ok) throw new PipelineError('PIPELINE_SCOPE_EXPANSION_REQUIRED', changeset.violations.join('; '));

  for (const command of [...manifest.test_commands, ...manifest.typecheck_commands, ...manifest.build_commands]) {
    await adapters.commands.run(command);
  }

  const reviewer = resolveReviewerRequirement(routingDoc, manifest.risk_class, manifest);
  let receipt = null;
  if (reviewer.required) {
    receipt = await adapters.reviewer.findReceipt({ agentId: reviewer.agentId, reviewedSha: resultSha, manifest });
    if (!receipt) throw new PipelineError('REVIEWER_RECEIPT_MISSING', `Missing ${reviewer.agentId} receipt for ${resultSha}`);
    if (receipt.reviewed_sha !== resultSha || receipt.verdict !== 'PASS') {
      throw new PipelineError('REVIEWER_RECEIPT_MISMATCH', `Invalid reviewer receipt for ${resultSha}`);
    }
  }

  await adapters.git.push(manifest.feature_branch, resultSha);
  const { pr, created } = await resolveOrCreatePr(adapters, {
    repository: manifest.repository,
    head: manifest.feature_branch,
    base: manifest.target_ref,
    title: manifest.pr_title || manifest.task_id,
    body: manifest.pr_body || '',
    expectedHeadSha: resultSha,
  });
  if (pr.headSha && pr.headSha !== resultSha) {
    throw new PipelineError('PR_INTEGRITY_FAILED', `PR head ${pr.headSha} != ${resultSha}`);
  }
  const merge = await mergePrIdempotent(adapters, pr);
  const mergedPr = merge.pr;
  if (!mergedPr.mergeCommitSha) throw new PipelineError('PR_MERGE_FAILED', 'No merge commit SHA returned');
  const ancestor = await adapters.git.isAncestor(mergedPr.mergeCommitSha, 'origin/main');
  if (!ancestor) throw new PipelineError('PR_MERGE_FAILED', `${mergedPr.mergeCommitSha} is not an ancestor of origin/main`);
  const deployment = await pollAutomaticDeployment(adapters, {
    url: manifest.production_build_info_url,
    targetSha: mergedPr.mergeCommitSha,
    timeoutSeconds: manifest.deployment_timeout_seconds,
    sleep: adapters.sleep,
  });
  await adapters.reconcile.verify({ manifest, resultSha, mergeSha: mergedPr.mergeCommitSha, deployment });
  return {
    status: deployment.status === 'DEPLOYED' ? 'PASS' : 'WAIT',
    result_sha: resultSha,
    reviewer_receipt: receipt,
    pr: mergedPr,
    pr_created: created,
    merged: merge.merged,
    deployment,
    changed_files: changedFiles,
  };
}
