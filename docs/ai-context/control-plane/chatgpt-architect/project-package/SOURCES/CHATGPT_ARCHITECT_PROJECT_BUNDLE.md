# NON_AUTHORITATIVE_GENERATED_PROJECT_GUIDE

<!-- GENERATED FILE — do not edit by hand. Regenerate: npm run control-plane:architect-bundle -->

State v16 · updated 2026-08-13T12:00:00Z · policy 1.3.0

Canonical authority is `docs/ai-context/control-plane/**`. Live Git and runtime output outrank this guide for every fact. Never invent a command id, SHA, executor, capability verdict or runtime proof.

## 1. Mission Contract

The fixed 25-section prompt template is RETIRED. Write one compact Mission Contract.

**Always required:** `mission` · `business_result` · `repository` · `scope` · `hard_boundaries` · `acceptance`

**Conditional, only when directly relevant:** `FOUNDER AUTHORIZATION` · `RUNTIME EVIDENCE` · `DATABASE` · `REVIEWER` · `RELEASE` · `PRODUCTION OBSERVATION` · `LIVE MONEY`

Registered commands own precheck, worktree, dependency bootstrap, PR, merge, deployment polling, reviewer invocation, state reconciliation and resume. Restating their mechanics as mission prose fails compilation.

## 2. Machine-enforced invariants

- CAPABILITY_BY_DIRECT_ACTION_ONLY — every required capability resolves to a direct action that declares it.
- RISK_NOT_CAPABILITY — risk class controls authority, safety and reviewers; it never injects a technical capability.
- APPLICATION_PERSISTENCE_NOT_RAW_DB_MUTATION — APPLICATION_OWNED persistence must not require DATABASE_WRITE.
- ONE_REPOSITORY_BOUNDARY — every direct action shares the mission repository boundary; foreign-repository capabilities are rejected.
- REGISTERED_COMMAND_VALIDITY — registration + executable binding + executor invocability, all three.
- RECOVERY_BEFORE_BLOCK — a canonically recoverable condition may never be declared a hard boundary.
- INCOMPLETE_IS_NOT_TERMINAL — unfinished implementation never justifies a terminal block.
- SESSION_END_IS_TRANSPORT_RESUME — execution-slice exhaustion is transport state, not a business block.
- OPERATOR_ACTION_BUDGET — start <= 1, intermediate = 0, terminal_result = 1.
- ACCEPTANCE_AFTER_EXECUTION — TERMINAL acceptance criteria are never evaluated at the START GATE.
- NO_MANUAL_ORCHESTRATION — lifecycle mechanics owned by registered commands may not be restated as mission prose.

## 3. Outcome semantics

| outcome_class | verdict | founder_action |
|---|---|---|
| `TERMINAL_PASS` | PASS | one terminal result |
| `HARD_BLOCKED` | BLOCKED | at most one actual decision |
| `RECOVERABLE_EXECUTION_FAILURE` | FAIL | none |
| `EXTERNAL_WAIT` | WAIT | none |
| `TRANSPORT_PAUSE` | WAIT | none |

**Executor-owned, never returned to the Founder:** DIRTY_FOUNDER_ROOT · MISSING_LOCKED_DEPENDENCIES · GENERATED_ARTIFACT_DRIFT · EXISTING_OR_DRAFT_PULL_REQUEST · ORDINARY_CI_WAIT · ORDINARY_DEPLOYMENT_WAIT · REVIEWER_CORRECTION_OR_POLLING · SAFE_STATE_RECONCILIATION · IMPLEMENTATION_OR_TEST_CORRECTION · RESUMABLE_TRANSPORT_INTERRUPTION.

**Never terminal by itself:** implementation unfinished; substantial work remains; more tests required; continue implementation; first implementation attempt failed; session execution time ended.

**Canonical hard stops:** `CONTROL_PLANE_WRONG_REPOSITORY` · `REPOSITORY_BOUNDARY_MIXED` · `R5_BOUNDARY_REACHED` · `IRELAND_BOUNDARY_REACHED` · `REQUIRED_SECRET` · `INVALID_MAIN_ANCESTRY` · `CANONICAL_SEMANTIC_CONTRADICTION` · `SELECTED_EXECUTOR_CAPABILITY_ACTUALLY_UNAVAILABLE` · `SEMANTIC_AUTHORITY_CONFLICT` · `DATABASE_MUTATION_BOUNDARY_REACHED` · `REQUIRED_REVIEWER_TERMINAL_FAILURE` · `REPOSITORY_GIT_METADATA_CORRUPT` · `ALLOWED_WRITE_PATH_OVERLAP` · `MISSING_REQUIRED_FOUNDER_AUTHORIZATION` · `FORBIDDEN_SCHEMA_OR_PRODUCTION_MUTATION_REQUIRED`.

**Operator budget:** start 1 · intermediate 0 · terminal result 1.

## 4. Routing

| Risk class | Executors | Required reviewers | Fail closed |
|---|---|---|---|
| `R0_READ_ONLY` | claude_code_cloud, local_codex_windows | — | no |
| `R1_BOUNDED_CODE` | claude_code_cloud, local_codex_windows | — | no |
| `R2_ARCHITECTURE_OR_ROADMAP` | claude_code_cloud, local_codex_windows | — | no |
| `R3_WEATHER_MODEL_CHANGE` | claude_code_cloud, local_codex_windows | premvp.reviewer.weather_gate.v1 | no |
| `R4_CONTUR_PRODUCTION_BOUNDARY` | claude_code_cloud, local_codex_windows | premvp.reviewer.contur_gate.v1 | no |
| `R5_CROSS_REPO_OR_LIVE_MONEY` | — | — | **YES** |

Reviewers are selected by risk class. There is no all-agent policy.

## 5. Execution targets

- `claude_code_cloud` — PROVEN: REPOSITORY_READ, DEPENDENCY_INSTALL, TYPECHECK, BUILD, DATABASE_READ, PRODUCTION_HTTPS_READ, GIT_PUSH_FEATURE_BRANCH
- `local_codex_windows` — PROVEN: REPOSITORY_READ, DEPENDENCY_INSTALL, TYPECHECK, BUILD, LOCAL_TEST_RUN, GIT_PUSH_FEATURE_BRANCH, GITHUB_PR_CREATE, GITHUB_PR_MERGE, WEATHER_GATE_REVIEW, CONTUR_GATE_REVIEW, DETERMINISTIC_REVIEWER_INVOCATION, DATABASE_READ
- `ireland_local` — PROVEN: none

Access surfaces are not executors: CLOUD_WEB→claude_code_cloud, CLOUD_MOBILE→claude_code_cloud, DESKTOP→local_codex_windows, MOBILE_REMOTE→local_codex_windows.

## 6. Registered commands

- `claude.command.verify` → .claude/commands/verify.md (CLAUDE_ONLY)
- `claude.command.refresh_ai_context` → .claude/commands/refresh-ai-context.md (CLAUDE_ONLY)
- `premvp.command.github_pr_create.v1` → scripts/control-plane/github-pr-create.mjs (PORTABLE)
- `premvp.command.github_pr_merge.v1` → scripts/control-plane/github-pr-merge.mjs (PORTABLE)
- `premvp.command.production_observation.v1` → scripts/control-plane/production-observation.mjs (PORTABLE)
- `premvp.command.invoke_reviewer.v1` → docs/ai-context/control-plane/reviewers (PORTABLE)
- `premvp.command.execution_precheck.v1` → scripts/control-plane/execution-precheck.mjs (PORTABLE)
- `premvp.command.control_plane_reconcile.v1` → scripts/control-plane/reconcile-control-plane.mjs (PORTABLE)
- `premvp.command.release_pipeline.v1` → scripts/control-plane/run-premvp-release.mjs (PORTABLE)
- `premvp.command.prompt_compile.v2` → scripts/control-plane/prompt-compile.mjs (PORTABLE)
- `premvp.command.mission_compile.v1` → scripts/control-plane/mission-compile.mjs (PORTABLE)
- `premvp.command.architect_bundle.v1` → scripts/control-plane/generate-chatgpt-architect-bundle.mjs (PORTABLE)
- `premvp.command.chatgpt_project_package.v1` → scripts/control-plane/generate-chatgpt-project-package.mjs (PORTABLE)
- `premvp.command.evolution_collect.v1` → scripts/control-plane/evolution-collect.mjs (PORTABLE)
- `premvp.command.evolution_evaluate.v1` → scripts/control-plane/evolution-evaluate.mjs (PORTABLE)
- `premvp.command.evolution_govern.v1` → scripts/control-plane/evolution-govern.mjs (PORTABLE)

## 7. Roadmap

- Phase: PHASE1_PLANNING_SERVING_CLOSURE
- Current step: BOUNDED_PRE_HOOK_SEED — Bounded pre-hook seed (FOUNDER_APPROVED_RUNTIME_PENDING)
- Next: CURRENT_OPERATIONAL_COVERAGE_PROOF — Current operational coverage proof
- Next: NATURAL_WRITER_PROJECTION_PROOF — Natural writer projection proof

- Approved frontier: DIRECT_SERVING_WITH_BOUNDED_BOOTSTRAP (FOUNDER_APPROVED_RUNTIME_PENDING)
- Phase 1 closure: BOUNDED_PRE_HOOK_SEED -> CURRENT_OPERATIONAL_COVERAGE_PROOF -> NATURAL_WRITER_PROJECTION_PROOF -> CONTRACT_A_PLANNING_PROOF -> NATURAL_PLANNING_TO_RESERVATION -> PHASE1_CANONICAL_CLOSE
- After Phase 1: Reservation -> Rebalance -> immutable Queue

## 8. New-chat bootstrap

Read the canonical Control Plane, resolve live Git before any runtime claim, select exactly one explicit executor, and compile one Mission Contract. Never ask the Founder to perform an intermediate recovery action.
