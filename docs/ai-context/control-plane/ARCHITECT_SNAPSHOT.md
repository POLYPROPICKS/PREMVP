# ARCHITECT_SNAPSHOT.md — Compact Architect Context

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate: npm run control-plane:snapshot -->
<!-- Verify:     npm run control-plane:snapshot:check -->

**State version:** 1  
**State updated_at:** 2026-08-03T00:00:00Z  
**Policy version:** 1.0.0  
**Source artifact versions:** policy 1.0 · state 1.0 · capability 1.0 · routing 1.0 · registry 1.0

## 1. Source authority

**Runtime and source facts (highest first):**

1. LIVE_RUNTIME_EVIDENCE
2. CURRENT_STATE_ENTRY
3. TRACKED_DOCUMENTATION
4. EXECUTOR_SELF_REPORT
5. CHAT_MEMORY

> A Founder statement does not by itself prove a runtime PASS. Founder statements enter as FOUNDER_ACCEPTED_EXTERNAL_* evidence classes and never as PROVEN_IN_RUNTIME.

**Product, roadmap and authority decisions (highest first):**

1. CURRENT_FOUNDER_DECISION
2. CONTROL_PLANE_POLICY
3. LOCKED_PRODUCT_DECISIONS
4. HISTORICAL_CHECKPOINT
5. CHAT_MEMORY

- Only current-state authority: `docs/ai-context/control-plane/CURRENT_STATE.yaml`
- `docs/ai-context/control-plane/EVIDENCE_LEDGER.md` is historical and never authoritative for current state.

## 2. Current phase and value steps

- **Roadmap phase:** CONTUR3_QUEUE_AUTHORITY
- **Current value step:** C1 — Queue authority cutoff (OPEN)
  - value target: persisted Planning Reservation -> typed Contract A Final Identity -> exact-token order book -> guards -> immutable Queue
- **Next two value steps:**
  1. C2 — Ireland execution reads only the immutable Queue (NEXT)
  2. SETTLEMENT_PNL — Settlement / PnL and production vertical proof (PLANNED)
- **main @ POLYPROPICKS/PREMVP:** `6e593a5d0e66e50941f130f7792f67e487dbb347` (PROVEN_IN_RUNTIME)
- **Last accepted completion id:** none

## 3. Current blockers

- `BLK-001` (local_codex_windows) — C1 CTL18 assertion failure is unresolved. → blocks: C1
- `BLK-002` (local_codex_windows) — Codex reviewer invocation is not deterministic: no required invocation receipt, no deterministic gate, no project-scoped Codex agent package, no tracked CI gate. → blocks: reviewer receipt enforcement outside the Cloud validator
- `BLK-003` (claude_code_cloud) — Supabase write access from claude_code_cloud is NOT_PROVEN. → blocks: any Cloud task requiring a database write
- `BLK-004` (ireland_local) — Ireland runtime access and Ireland repository remote identity are NOT_PROVEN. → blocks: C2 execution routing

**Proven failures:**

- `C1_CTL18_ASSERTION_FAILURE` (FOUNDER_ACCEPTED_EXTERNAL_CHECKPOINT) — CTL18 assertion failure in the controlled-live intent test path

## 4. Execution targets and proven capabilities

### `claude_code_cloud`

- runtime: `claude_code_cloud`
- repository scope: `POLYPROPICKS/PREMVP`
- host_dependency: `false`
- access surfaces: `CLOUD_WEB`, `CLOUD_MOBILE`
- founder_terminal_required: `false`
- PROVEN: REPOSITORY_READ, DEPENDENCY_INSTALL, TYPECHECK, BUILD, DATABASE_READ, PRODUCTION_HTTPS_READ, GIT_PUSH_FEATURE_BRANCH
- NOT PROVEN / NOT AVAILABLE: DATABASE_WRITE (NOT_PROVEN), IRELAND_RUNTIME_ACCESS (NOT_AVAILABLE), WEATHER_GATE_REVIEW (NOT_AVAILABLE), CONTUR_GATE_REVIEW (NOT_AVAILABLE), DEPLOY (NOT_AVAILABLE)

### `local_codex_windows`

- runtime: `local_codex_windows`
- repository scope: `POLYPROPICKS/PREMVP`
- host_dependency: `true`
- access surfaces: `DESKTOP`, `MOBILE_REMOTE`
- founder_terminal_required: `false`
- PROVEN: REPOSITORY_READ, LOCAL_TEST_RUN, WEATHER_GATE_REVIEW, CONTUR_GATE_REVIEW
- NOT PROVEN / NOT AVAILABLE: DETERMINISTIC_REVIEWER_INVOCATION (NOT_PROVEN), DATABASE_READ (NOT_PROVEN), DATABASE_WRITE (NOT_PROVEN), IRELAND_RUNTIME_ACCESS (NOT_AVAILABLE), DEPLOY (NOT_AVAILABLE)

### `ireland_local`

- runtime: `ireland_local`
- repository scope: `UNPROVEN_REMOTE_IDENTITY`
- host_dependency: `true`
- access surfaces: (none)
- founder_terminal_required: `true`
- PROVEN: (none)
- NOT PROVEN / NOT AVAILABLE: REPOSITORY_READ (NOT_PROVEN), RUNTIME_ACCESS (NOT_PROVEN), REMOTE_IDENTITY (NOT_PROVEN), AGENT_AVAILABILITY (NOT_AVAILABLE), DEPLOY (NOT_AVAILABLE)

**Access surfaces are not executors:**

- `CLOUD_WEB` → reaches `claude_code_cloud`
- `CLOUD_MOBILE` → reaches `claude_code_cloud`
- `DESKTOP` → reaches `local_codex_windows`
- `MOBILE_REMOTE` → reaches `local_codex_windows` via Codex Remote

## 5. Routing summary

> Invoke only the agents required by the classified risk class. There is NO all-agent policy. Invoking an unnecessary reviewer is a routing defect and is recorded as token overhead in shadow metrics.

| Risk class | Eligible executors | Required agents | Fail closed | Founder actions | Mobile |
|---|---|---|---|---|---|
| `R0_READ_ONLY` | claude_code_cloud, local_codex_windows | — | no | 0 | yes |
| `R1_BOUNDED_CODE` | claude_code_cloud, local_codex_windows | claude.hook.validate_proof_package | no | 1 | yes |
| `R2_ARCHITECTURE_OR_ROADMAP` | claude_code_cloud, local_codex_windows | claude.hook.validate_proof_package, premvp.policy.agent_constitution, premvp.policy.task_routing | no | 1 | yes |
| `R3_ML_CHANGE` | local_codex_windows | codex.agent.weather_gate_reviewer.v0 | no | 1 | yes |
| `R4_LIVE_RUNTIME` | local_codex_windows | codex.agent.contur_gate_reviewer | no | 1 | yes |
| `R5_CROSS_REPO_OR_LIVE_MONEY` | — | — | YES | 0 | yes |

- **R5 fail-closed:** default verdict `BLOCKED`. R5 has no eligible execution target and no permitted repository. It always returns BLOCKED unless a separate Founder authorization exists AND every required capability holds verdict PROVEN in CAPABILITY_MATRIX.yaml. Ireland is NOT eligible for implementation while its capabilities are NOT_PROVEN.

## 6. Mandatory prompt sections

Every executor prompt must contain all 25 sections of `PROMPT__PROTOCOL.md`:

`MODEL` · `MODEL LEVEL` · `SESSION MODE` · `SESSION REASON` · `EXECUTION ENVIRONMENT` · `REPOSITORY / WORKTREE / CWD` · `BRANCH / TARGET REF / TARGET SHA` · `TOKEN / READ BUDGET` · `VALUE TARGET` · `CURRENT ROADMAP PHASE` · `NEXT TWO VALUE STEPS` · `OPERATOR MODE` · `TASK CLASS` · `RISK CLASS` · `REQUIRED CAPABILITIES` · `REQUIRED AGENTS / REVIEWERS` · `PRECHECK` · `EXECUTION SCOPE` · `ALLOWED FILES` · `FORBIDDEN FILES` · `WRITE POLICY` · `STOP CONDITIONS` · `EVIDENCE REQUIRED` · `COMPLETION ENVELOPE` · `FOUNDER ACTION`

Missing, guessed or contradictory input → `PROMPT_GATE_BLOCKED`.

## 7. Agent and reviewer availability

| Canonical id | Type | Platform | Status | Invocation | Receipt |
|---|---|---|---|---|---|
| `codex.agent.weather_gate_reviewer.v0` | AGENT | local_codex_windows | PROVEN_PRESENT | EXPLICIT | REQUIRED |
| `codex.agent.contur_gate_reviewer` | AGENT | local_codex_windows | PROVEN_PRESENT | EXPLICIT | REQUIRED |
| `claude.command.verify` | COMMAND | claude_code_cloud | PROVEN_PRESENT | EXPLICIT | — |
| `claude.command.refresh_ai_context` | COMMAND | claude_code_cloud | PROVEN_PRESENT | EXPLICIT | — |
| `claude.command.daily_ops_report` | COMMAND | claude_code_cloud | PLANNED | EXPLICIT | — |
| `claude.hook.validate_proof_package` | HOOK | claude_code_cloud | PROVEN_PRESENT | AUTOMATIC | — |
| `claude.hook.session_start_dependency_guard` | HOOK | claude_code_cloud | PROVEN_PRESENT | AUTOMATIC | — |
| `premvp.script.validate_control_plane` | SCRIPT | any_node_runtime | PROVEN_PRESENT | EXPLICIT | — |
| `premvp.script.generate_architect_snapshot` | SCRIPT | any_node_runtime | PROVEN_PRESENT | EXPLICIT | — |
| `premvp.script.validate_completion_envelope` | SCRIPT | any_node_runtime | PROVEN_PRESENT | EXPLICIT | — |
| `premvp.ci_gate.reviewer_receipt_enforcement` | CI_GATE | unassigned | PLANNED | NONE | — |
| `premvp.policy.agent_constitution` | POLICY | repository | PROVEN_PRESENT | AUTOMATIC | — |
| `premvp.policy.task_routing` | POLICY | repository | PROVEN_PRESENT | AUTOMATIC | — |
| `premvp.policy.execution_protocol` | POLICY | repository | PROVEN_PRESENT | AUTOMATIC | — |
| `premvp.policy.verification_gates` | POLICY | repository | PROVEN_PRESENT | AUTOMATIC | — |
| `premvp.spec.code_auditor` | POLICY | repository | REFERENCED_ONLY | MODEL_DECIDED | — |
| `premvp.spec.compliance_monitor` | POLICY | repository | REFERENCED_ONLY | MODEL_DECIDED | — |

## 8. PREMVP / Ireland boundary

- PREMVP repository: `POLYPROPICKS/PREMVP` — executors: claude_code_cloud, local_codex_windows
- Ireland: `PROTECTED_BOUNDARY_ONLY` — remote identity `UNPROVEN_REMOTE_IDENTITY`, access in Phase 1/2: `false`
- PREMVP and Ireland implementation prompts CANNOT be mixed. One executor prompt targets exactly one repository boundary. A prompt that would touch both must be split, or PROMPT_GATE_BLOCKED.
- Cross-repository implementation: `FORBIDDEN_WITHOUT_SEPARATE_AUTHORIZATION`

## 9. Operator policy

- Architect interface: **STANDARD_CHAT** (Work: ESCALATION_ONLY)
- Project: **PolyProPicks — Architect Control Plane**, memory **PROJECT_ONLY**
- Operator mode default: **MOBILE_REMOTE**
- Founder action budget: preferred 0, maximum 1 (one clear tap OR one copy/paste action)
- Normal flow must never require: `WINDOWS_CMD`, `POWERSHELL`, `SQL`, `SSH`, `SUPABASE_UI_QUERY`, `CWD_SELECTION`, `MANUAL_REPOSITORY_SELECTION`, `SECRET_COPY`
- Escape hatch: `BREAK_GLASS_OPERATOR_ACTION` — It has been explicitly proven that no registered executor in CAPABILITY_MATRIX.yaml can perform the action.

## 10. Global stop conditions

- CONTROL_PLANE_WRONG_REPOSITORY — checkout is not the repository named in the prompt
- CONTROL_PLANE_DIRTY_WORKTREE — unexpected dirty state
- CONTROL_PLANE_SCOPE_EXPANSION_REQUIRED — a file outside ALLOWED FILES must change
- PROMPT_GATE_BLOCKED — required prompt section, capability, evidence or routing is missing or contradictory
- STATE_STALE — CURRENT_STATE.yaml exceeds its freshness window and cannot be re-proven
- CAPABILITY_NOT_PROVEN — routing requires a capability whose verdict is not PROVEN
- REVIEWER_RECEIPT_MISSING — a mandatory reviewer produced no valid receipt
- REPOSITORY_BOUNDARY_MIXED — a single prompt targets both PREMVP and Ireland
- SECRETS_REQUIRED — env/secret values would have to be read or printed

**Stale state behavior:** `FAIL_CLOSED` — When CURRENT_STATE.yaml is stale, missing, or its origin_main_sha does not match live origin/main, the architect MUST return PROMPT_GATE_BLOCKED and request a bounded read-only refresh task. It must NOT guess, extrapolate, or fall back to chat memory or legacy state documents.

## 11. Latest evidence identifiers

- `CLOUD_REPO_READ` — claude_code_cloud — FOUNDER_ACCEPTED_EXTERNAL_AUDIT — EVIDENCE_LEDGER#EV-0002
- `CLOUD_NPM_CI` — claude_code_cloud — FOUNDER_ACCEPTED_EXTERNAL_AUDIT — EVIDENCE_LEDGER#EV-0002
- `CLOUD_SUPABASE_SELECT` — claude_code_cloud — FOUNDER_ACCEPTED_EXTERNAL_AUDIT — EVIDENCE_LEDGER#EV-0002
- `CLOUD_TYPECHECK` — claude_code_cloud — FOUNDER_ACCEPTED_EXTERNAL_AUDIT — EVIDENCE_LEDGER#EV-0002
- `CLOUD_BUILD` — claude_code_cloud — FOUNDER_ACCEPTED_EXTERNAL_AUDIT — EVIDENCE_LEDGER#EV-0002
- `CODEX_WEATHER_REVIEWER_PRESENT` — local_codex_windows — FOUNDER_ACCEPTED_EXTERNAL_AUDIT — EVIDENCE_LEDGER#EV-0003
- `CODEX_CONTUR_REVIEWER_PRESENT` — local_codex_windows — FOUNDER_ACCEPTED_EXTERNAL_AUDIT — EVIDENCE_LEDGER#EV-0003
- `CHK-C1-20260803` — FOUNDER_ACCEPTED_EXTERNAL_CHECKPOINT
- `CHK-CLOUD-CAPABILITY` — FOUNDER_ACCEPTED_EXTERNAL_AUDIT
- `CHK-CODEX-INVENTORY` — FOUNDER_ACCEPTED_EXTERNAL_AUDIT

**Evidence freshness window:** 7 days from `2026-08-03T00:00:00Z`.

**Stale when:**

- live origin/main SHA differs from main.origin_main_sha
- updated_at is older than evidence_freshness.max_age_days
- an accepted completion envelope exists whose completion_id is newer than last_accepted_completion_id
- a referenced execution target verdict in CAPABILITY_MATRIX.yaml has passed its expires_when
