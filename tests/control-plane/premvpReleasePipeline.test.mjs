/**
 * premvpReleasePipeline.test.mjs
 *
 * Bounded tests for premvp.command.release_pipeline.v1 — manifest validation, disabled-mode
 * gating, live reconstruction/resume, and idempotency of PR/merge/deploy/reviewer phases.
 * Uses node:test and fake in-memory adapters. No real GitHub mutation, no production contact.
 *
 * Run: node --test tests/control-plane/premvpReleasePipeline.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateReleaseRunManifest, RECONCILE_COMMAND_ID, R5_AUTHORIZED_ROUTE_ID, R5_AUTHORIZATION_REF } from '../../scripts/control-plane/validate-premvp-release-run.mjs';
import {
  STATE_ORDER,
  PipelineError,
  R5FailClosedError,
  resolveReviewerRequirement,
  assertManifestCannotOverrideReviewer,
  checkChangeset,
  assertMutationAllowed,
  reconstructRun,
  resolveOrCreatePr,
  mergePrIdempotent,
  pollAutomaticDeployment,
  resolveReviewerReceipt,
  dryRunPlan,
  statusReport,
  assertRunIdentityConsistent,
  assertPassInvariants,
  executeReleaseRun,
} from '../../scripts/control-plane/lib/premvp-release-pipeline.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const routingDoc = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, 'docs/ai-context/control-plane/ROUTING_AND_PIPELINES.yaml'), 'utf8'));
const pipelineSpec = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, 'docs/ai-context/control-plane/pipelines/PREMVP_RELEASE_PIPELINE_V1.yaml'), 'utf8'));
const releaseRunSchema = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, 'docs/ai-context/control-plane/pipelines/PREMVP_RELEASE_RUN.schema.json'), 'utf8'));

function baseManifest(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...releaseRunSchema.example_valid_r2_run, ...overrides }));
}

// ---- 1. Manifest schema accepts a valid R2 PREMVP run. -----------------------------------
test('1. manifest schema accepts a valid R2 PREMVP run', () => {
  const result = validateReleaseRunManifest(baseManifest());
  assert.equal(result.ok, true, result.errors.join('\n'));
});

// ---- 2. Rejects a second repository. ------------------------------------------------------
test('2. manifest rejects a second repository', () => {
  const result = validateReleaseRunManifest(baseManifest({ repository: 'POLYPROPICKS/IRELAND' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /SINGLE_REPOSITORY/);
});

// ---- 3. Rejects Ireland. -------------------------------------------------------------------
test('3. manifest rejects Ireland', () => {
  const result = validateReleaseRunManifest(baseManifest({ task_id: 'ireland-touching-task' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /NO_IRELAND/);
});

// ---- 4. Generic R5 remains fail-closed. ------------------------------------------------------
test('4. generic R5 manifest remains fail-closed', () => {
  const result = validateReleaseRunManifest(baseManifest({ risk_class: 'R5_CROSS_REPO_OR_LIVE_MONEY' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /R5_FAIL_CLOSED/);
});

test('4b. exact Founder-authorized future Queue R5 route requires the Contur reviewer', () => {
  const manifest = baseManifest({
    risk_class: 'R5_CROSS_REPO_OR_LIVE_MONEY',
    task_id: 'R5_FUTURE_QUEUE_STAKE_20260824',
    r5_authorization: { route_id: R5_AUTHORIZED_ROUTE_ID, authorization_ref: R5_AUTHORIZATION_REF, direct_action_scope: 'FUTURE_QUEUE_STAKE_CONFIGURATION', max_stake_usd: 2.5, historical_queue_mutation: false, raw_database_mutation: false, direct_venue_action: false },
  });
  const result = validateReleaseRunManifest(manifest);
  assert.equal(result.ok, true, result.errors.join('\n'));
  const reviewer = resolveReviewerRequirement(routingDoc, manifest.risk_class, manifest);
  assert.deepEqual(reviewer, { required: true, agentId: 'premvp.reviewer.contur_gate.v1', independenceGroup: 'contur_gate' });
});

// ---- 5. Rejects intermediate operator actions > 0. ------------------------------------------
test('5. manifest rejects intermediate operator actions greater than zero', () => {
  const result = validateReleaseRunManifest(baseManifest({
    operator_intervention_budget: { launch: 1, intermediate: 1, result_transfer: 1 },
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /ZERO_INTERMEDIATE_OPERATOR_ACTIONS/);
});

// ---- 6. Rejects direct main push. -----------------------------------------------------------
test('6. manifest rejects direct main push', () => {
  const result = validateReleaseRunManifest(baseManifest({ feature_branch: 'main' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /NO_DIRECT_MAIN_PUSH/);
});

// ---- 7. Rejects manual deployment. -----------------------------------------------------------
test('7. manifest rejects manual deployment', () => {
  const result = validateReleaseRunManifest(baseManifest({ deploy_command: 'railway up' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /NO_MANUAL_DEPLOYMENT/);
});

// ---- 8. Rejects secrets. ----------------------------------------------------------------------
test('8. manifest rejects secrets or secret-file fields', () => {
  const result = validateReleaseRunManifest(baseManifest({ note: 'API_KEY: "sk-abcdefghijklmnopqrst"' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /NO_SECRETS/);
});

// ---- 9. Pipeline is enabled only with the reconciliation command. ------------------------------
test('9. pipeline is enabled for mutating execution after Action 3 reconciliation', () => {
  assert.equal(pipelineSpec.status, 'ENABLED');
  assert.equal(pipelineSpec.enabled, true);
  assert.doesNotThrow(() => assertMutationAllowed(pipelineSpec));
});

// ---- 10. Dry-run is permitted while disabled. ---------------------------------------------------
test('10. dry-run remains permitted while enabled', () => {
  const result = dryRunPlan(baseManifest(), routingDoc, pipelineSpec);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.plan.pipeline_status, 'ENABLED');
  assert.equal(result.plan.mutating_mode_enabled, true);
  assert.deepEqual(result.plan.states, STATE_ORDER);
});

// ---- 11. Status reconstruction is permitted while disabled. -------------------------------------
test('11. status reconstruction is permitted while enabled', async () => {
  const adapters = fakeAdapters({});
  const reconstructed = await reconstructRun(baseManifest(), routingDoc, adapters);
  const report = statusReport(reconstructed, baseManifest(), pipelineSpec);
  assert.equal(report.pipeline_status, 'ENABLED');
  assert.equal(report.phase_completed_through, 'RESOLVE_RUN');
});

// ---- Fake adapter factory -----------------------------------------------------------------
function fakeAdapters({ branchHeadSha = null, pr = null, mainAncestor = true, productionSha = null, receipt = null, calls = {} } = {}) {
  const callLog = { createPullRequest: 0, mergePullRequest: 0, reviewerInvoke: 0, deployReads: 0 };
  return {
    _callLog: callLog,
    git: {
      branchHeadSha: async () => branchHeadSha,
      isAncestor: async () => mainAncestor,
    },
    github: {
      findPullRequest: async () => pr,
      createPullRequest: async (params) => {
        callLog.createPullRequest += 1;
        return { number: 42, repo: params.repo, headSha: branchHeadSha, baseSha: 'base-sha', merged: false, files: [] };
      },
      mergePullRequest: async () => {
        callLog.mergePullRequest += 1;
        return { mergeCommitSha: 'merged-sha-0001' };
      },
    },
    deploy: {
      getProductionSha: async () => { callLog.deployReads += 1; return productionSha; },
    },
    reviewer: {
      findReceipt: async () => receipt,
      invoke: async () => { callLog.reviewerInvoke += 1; return { status: 'PENDING', agent_id: 'x', reviewed_sha: 'y' }; },
    },
    checkpoint: {
      load: async () => null,
    },
  };
}

// ---- 12/13. Exact existing branch reused; mismatched identity blocks. -----------------------
test('12. exact existing branch is reused (reconstruction reaches PUSH_BRANCH)', async () => {
  const adapters = fakeAdapters({ branchHeadSha: 'abc123' });
  const reconstructed = await reconstructRun(baseManifest(), routingDoc, adapters);
  assert.equal(reconstructed.phaseCompletedThrough, 'PUSH_BRANCH');
});

test('13. mismatched branch/run identity blocks resume', () => {
  const manifest = baseManifest();
  assert.throws(() => assertRunIdentityConsistent(manifest, { repository: 'POLYPROPICKS/OTHER' }),
    (e) => e instanceof PipelineError && e.code === 'PIPELINE_RUN_IDENTITY_MISMATCH');
  assert.doesNotThrow(() => assertRunIdentityConsistent(manifest, { repository: manifest.repository }));
});

// ---- 14/15. Existing PR reused; duplicate PR creation prevented. -----------------------------
test('14. exact existing PR is reused / 15. duplicate PR creation is prevented', async () => {
  const adapters = fakeAdapters({ pr: { number: 7, repo: 'POLYPROPICKS/PREMVP', headSha: 'abc', merged: false } });
  const { pr, created } = await resolveOrCreatePr(adapters, {
    repository: 'POLYPROPICKS/PREMVP', head: 'feature', base: 'main', title: 't', body: 'b',
  });
  assert.equal(created, false);
  assert.equal(pr.number, 7);
  assert.equal(adapters._callLog.createPullRequest, 0);
});

test('15b. a merged PR with an older branch head creates the next PR', async () => {
  const adapters = fakeAdapters({ pr: { number: 7, repo: 'POLYPROPICKS/PREMVP', headSha: 'old', merged: true, mergeCommitSha: 'm1' } });
  const { created } = await resolveOrCreatePr(adapters, {
    repository: 'POLYPROPICKS/PREMVP', head: 'feature', base: 'main', title: 't', body: 'b', expectedHeadSha: 'new',
  });
  assert.equal(created, true);
  assert.equal(adapters._callLog.createPullRequest, 1);
});

// ---- 16/17/29. Merged PR skips merge; ancestry skips repeated integration. -------------------
test('16. merged PR skips merge / 29. irreversible action not repeated', async () => {
  const adapters = fakeAdapters({});
  const mergedPr = { number: 7, repo: 'POLYPROPICKS/PREMVP', headSha: 'abc', merged: true, mergeCommitSha: 'm1' };
  const { merged, alreadyMerged } = await mergePrIdempotent(adapters, mergedPr);
  assert.equal(merged, false);
  assert.equal(alreadyMerged, true);
  assert.equal(adapters._callLog.mergePullRequest, 0);
});

test('17. main ancestry reconstruction reaches VERIFY_MAIN_ANCESTRY without re-merging', async () => {
  const adapters = fakeAdapters({
    branchHeadSha: 'abc',
    pr: { number: 7, repo: 'POLYPROPICKS/PREMVP', headSha: 'abc', merged: true, mergeCommitSha: 'm1' },
    mainAncestor: true,
    productionSha: 'not-yet-m1',
  });
  const reconstructed = await reconstructRun(baseManifest(), routingDoc, adapters);
  assert.equal(reconstructed.phaseCompletedThrough, 'VERIFY_MAIN_ANCESTRY');
});

// ---- 18. Deployed matching SHA skips poll. ----------------------------------------------------
test('18. deployment matching SHA skips poll', async () => {
  const adapters = fakeAdapters({ productionSha: 'target-sha' });
  const result = await pollAutomaticDeployment(adapters, { url: 'https://x/api/build-info', targetSha: 'target-sha', timeoutSeconds: 600 });
  assert.equal(result.status, 'DEPLOYED');
  assert.equal(adapters._callLog.deployReads, 1);
});

// ---- 19. Deployment timeout returns WAIT. ------------------------------------------------------
test('19. deployment timeout returns WAIT', async () => {
  const adapters = fakeAdapters({ productionSha: 'old-sha' });
  const result = await pollAutomaticDeployment(adapters, { url: 'https://x/api/build-info', targetSha: 'target-sha', timeoutSeconds: 1 });
  assert.equal(result.status, 'WAIT');
});

// ---- 20. WAIT resumes from deployment phase. ---------------------------------------------------
test('20. WAIT resumes from POLL_AUTOMATIC_DEPLOYMENT (next state after VERIFY_MAIN_ANCESTRY)', async () => {
  const adapters = fakeAdapters({
    branchHeadSha: 'abc',
    pr: { number: 7, repo: 'POLYPROPICKS/PREMVP', headSha: 'abc', merged: true, mergeCommitSha: 'm1' },
    mainAncestor: true,
    productionSha: 'still-old',
  });
  const reconstructed = await reconstructRun(baseManifest(), routingDoc, adapters);
  const report = statusReport(reconstructed, baseManifest(), pipelineSpec);
  assert.equal(report.phase_completed_through, 'VERIFY_MAIN_ANCESTRY');
  assert.equal(report.next_state, 'POLL_AUTOMATIC_DEPLOYMENT');
});

// ---- 21/22/23. Reviewer receipt reuse / pending not duplicated / SHA mismatch blocks. ---------
test('21. matching reviewer receipt is reused', async () => {
  const adapters = fakeAdapters({ receipt: { status: 'APPROVED', agent_id: 'premvp.reviewer.contur_gate.v1', reviewed_sha: 'sha1' } });
  const { status, invoked } = await resolveReviewerReceipt(adapters, { agentId: 'premvp.reviewer.contur_gate.v1', reviewedSha: 'sha1' });
  assert.equal(status, 'REUSED');
  assert.equal(invoked, false);
  assert.equal(adapters._callLog.reviewerInvoke, 0);
});

test('22. pending reviewer invocation is not duplicated', async () => {
  const adapters = fakeAdapters({ receipt: { status: 'PENDING', agent_id: 'premvp.reviewer.contur_gate.v1', reviewed_sha: 'sha1' } });
  const { status, invoked } = await resolveReviewerReceipt(adapters, { agentId: 'premvp.reviewer.contur_gate.v1', reviewedSha: 'sha1' });
  assert.equal(status, 'PENDING');
  assert.equal(invoked, false);
  assert.equal(adapters._callLog.reviewerInvoke, 0);
});

test('23. receipt SHA mismatch blocks', async () => {
  const adapters = fakeAdapters({ receipt: { status: 'APPROVED', agent_id: 'x', reviewed_sha: 'sha-old' } });
  await assert.rejects(
    () => resolveReviewerReceipt(adapters, { agentId: 'x', reviewedSha: 'sha-new' }),
    (e) => e instanceof PipelineError && e.code === 'REVIEWER_RECEIPT_MISMATCH',
  );
});

// ---- 24/25/26. Reviewer routing safety. ---------------------------------------------------------
test('24. required R4 reviewer cannot be suppressed by manifest', () => {
  const req = resolveReviewerRequirement(routingDoc, 'R4_CONTUR_PRODUCTION_BOUNDARY');
  assert.equal(req.required, true);
  assert.equal(req.agentId, 'premvp.reviewer.contur_gate.v1');
  // Manifest carries no override field at all — resolution must proceed from routing alone.
  assert.doesNotThrow(() => assertManifestCannotOverrideReviewer({ required_reviewer_override: null }));
});

test('24b. manifest attempting to override the reviewer is rejected', () => {
  assert.throws(
    () => assertManifestCannotOverrideReviewer({ required_reviewer_override: 'none' }),
    (e) => e instanceof PipelineError && e.code === 'PIPELINE_REVIEWER_ROUTING_UNSAFE',
  );
});

test('25. R2 does not invoke a reviewer', () => {
  const req = resolveReviewerRequirement(routingDoc, 'R2_ARCHITECTURE_OR_ROADMAP');
  assert.equal(req.required, false);
  assert.equal(req.agentId, null);
});

test('26. R5 fails closed', () => {
  assert.throws(() => resolveReviewerRequirement(routingDoc, 'R5_CROSS_REPO_OR_LIVE_MONEY'),
    (e) => e instanceof R5FailClosedError);
  const dry = dryRunPlan(baseManifest({ risk_class: 'R5_CROSS_REPO_OR_LIVE_MONEY' }), routingDoc, pipelineSpec);
  assert.equal(dry.ok, false);
  assert.match(dry.errors.join('\n'), /R5_FAIL_CLOSED/);
});

// ---- 27. Local checkpoint loses to contradictory live evidence. ---------------------------------
test('27. local checkpoint loses to contradictory live evidence', async () => {
  const adapters = fakeAdapters({ branchHeadSha: 'live-head-sha' });
  adapters.checkpoint.load = async () => ({ phaseCompletedThrough: 'COMPLETE', headSha: 'stale-checkpoint-sha' });
  const reconstructed = await reconstructRun(baseManifest(), routingDoc, adapters);
  // Live branch evidence (present, PR absent) drives the result, not the checkpoint's stale COMPLETE claim.
  assert.equal(reconstructed.phaseCompletedThrough, 'PUSH_BRANCH');
  assert.equal(reconstructed.evidence.branch.headSha, 'live-head-sha');
});

// ---- 28. Transport interruption resumes from live Git/PR state. ---------------------------------
test('28. transport interruption resumes from live Git/PR state', async () => {
  const adapters = fakeAdapters({ branchHeadSha: null });
  const reconstructed = await reconstructRun(baseManifest(), routingDoc, adapters);
  assert.equal(reconstructed.phaseCompletedThrough, 'RESOLVE_RUN');
  assert.equal(reconstructed.evidence.branch.exists, false);
});

// ---- 30. Reconciliation adapter enables mutating activation. -----------------------------------
test('30. reconciliation adapter is required and enabled', () => {
  assert.equal(pipelineSpec.control_plane_reconcile_adapter_interface.status_in_action_2, 'IMPLEMENTED_ACTION_3');
  assert.equal(pipelineSpec.disabled_until_command, null);
  assert.doesNotThrow(() => assertMutationAllowed(pipelineSpec));
});

// ---- 31. Completion PASS invariants are enforced. ------------------------------------------------
test('31. completion PASS invariants are enforced', () => {
  const failing = assertPassInvariants({
    testsPassed: true, reviewerRequired: true, requiredReceiptPresent: false,
    receiptShaMatches: false, blockers: [], worktreeClean: true,
  });
  assert.equal(failing.canPass, false);
  assert.match(failing.violations.join('\n'), /reviewer receipt is absent/);

  const passing = assertPassInvariants({
    testsPassed: true, reviewerRequired: false, requiredReceiptPresent: false,
    receiptShaMatches: false, blockers: [], worktreeClean: true,
  });
  assert.equal(passing.canPass, true);
});

// ---- 32. No database/Ireland/live-money action is reachable. -------------------------------------
test('32. no database/Ireland/live-money action is reachable', () => {
  assert.equal(pipelineSpec.hard_prohibitions.database_mutation_by_generic_pipeline, true);
  assert.equal(pipelineSpec.hard_prohibitions.ireland, true);
  assert.equal(pipelineSpec.hard_prohibitions.live_money, true);

  const result = validateReleaseRunManifest(baseManifest({ build_commands: ['tsx scripts/db-migrate.ts'] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /NO_DATABASE_MUTATION_V1/);

  const libSource = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts/control-plane/lib/premvp-release-pipeline.mjs'), 'utf8');
  assert.ok(!/supabase|DATABASE_URL|railway (up|deploy)/i.test(libSource),
    'engine must not reference a database write transport or a manual deploy command');
});

// ---- Changeset validation (VALIDATE_CHANGESET state). ---------------------------------------------
test('changeset validation rejects files outside allowed_files and forbidden paths', () => {
  const result = checkChangeset(
    ['docs/ai-context/control-plane/pipelines/EXAMPLE.md', 'package-lock.json'],
    ['docs/ai-context/control-plane/pipelines/EXAMPLE.md'],
    ['package-lock.json'],
  );
  assert.equal(result.ok, false);
  assert.match(result.violations.join('\n'), /NOT_IN_ALLOWED_FILES|FORBIDDEN_FILE_TOUCHED/);
});

test('changeset validation passes for an exact allowed-file match', () => {
  const result = checkChangeset(
    ['docs/ai-context/control-plane/pipelines/EXAMPLE.md'],
    ['docs/ai-context/control-plane/pipelines/EXAMPLE.md'],
    [],
  );
  assert.equal(result.ok, true);
});

test('enabled lifecycle executes registered phases with an exact reviewer receipt', async () => {
  const manifest = baseManifest({
    risk_class: 'R4_CONTUR_PRODUCTION_BOUNDARY',
    allowed_files: ['scripts/control-plane/run-premvp-release.mjs'],
    test_commands: ['test'], typecheck_commands: [], build_commands: [],
    feature_branch: 'codex/test-release', target_ref: 'main',
  });
  const calls = [];
  const adapters = {
    git: {
      currentHead: async () => 'exact-sha', changedFiles: async () => ['scripts/control-plane/run-premvp-release.mjs'],
      push: async () => calls.push('push'), isAncestor: async () => true,
    },
    commands: { run: async () => calls.push('test') },
    reviewer: { findReceipt: async () => ({ agent_id: 'premvp.reviewer.contur_gate.v1', reviewed_sha: 'exact-sha', verdict: 'PASS' }) },
    github: {
      findPullRequest: async () => null,
      createPullRequest: async () => ({ number: 1, repo: 'POLYPROPICKS/PREMVP', headSha: 'exact-sha', merged: false, mergeCommitSha: null, url: 'x' }),
      mergePullRequest: async () => ({ mergeCommitSha: 'merge-sha' }),
    },
    deploy: { getProductionSha: async () => 'merge-sha' },
    reconcile: { verify: async () => calls.push('reconcile') },
  };
  const result = await executeReleaseRun(manifest, routingDoc, pipelineSpec, adapters);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls, ['test', 'push', 'reconcile']);
});
