# ARCHITECT_SNAPSHOT.md — Compact Architect Context

<!-- GENERATED FILE — do not edit by hand. Regenerate: npm run control-plane:snapshot -->

State v14 · updated 2026-08-07T11:11:09Z · policy 1.2.0

## 1. Source authority

**Runtime facts:** LIVE_RUNTIME_EVIDENCE > CURRENT_STATE_ENTRY > TRACKED_DOCUMENTATION > EXECUTOR_SELF_REPORT > CHAT_MEMORY

**Product decisions:** CURRENT_FOUNDER_DECISION > CONTROL_PLANE_POLICY > LOCKED_PRODUCT_DECISIONS > HISTORICAL_CHECKPOINT > CHAT_MEMORY

A Founder statement never by itself yields a runtime PASS.

Only current-state authority: `CURRENT_STATE.yaml`. `EVIDENCE_LEDGER.md` is history and never authoritative for current state.

## 2. Phase and value steps

- Phase: **CONTUR3_QUEUE_AUTHORITY**
- Current step: **C1 — C1 production runtime proof** (OPEN)
- Next two: **STEP_2_FINAL_IDENTITY** Final Identity fix verification → **STEP_3_FORWARD_FUNNEL** Forward Reservation funnel
- main @ POLYPROPICKS/PREMVP: baseline `a942a0d833982bca5caf01ff05d4e4bfb9151119` (LAST_VERIFIED_ORIGIN_MAIN_BASELINE) — freshness mode BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE: baseline must be an ancestor of live origin/main; a live tip ahead of baseline stays FRESH only if every changed path is in the state-bootstrap allowlist (CURRENT_STATE.yaml, ARCHITECT_SNAPSHOT.md, EVIDENCE_LEDGER.md), otherwise STATE_REFRESH_REQUIRED
- Last accepted completion: CMP-EVOLUTION-CONTROL-PLANE-STAGE-2-20260807

## 3. Blockers

- `BLK-001` Deployment is proven for 1a140a297523c0413c32954ecf7dc63d1d345d3b through /api/build-info. C1 remains OPEN because no natural night-reservations run has started after the proven deployment boundary. The historical CTL18 failure remains unresolved. Close C1 only after a natural run proves Planning -> Reservation -> Final Identity -> immutable Queue. (blocks: C1)
- `BLK-002` Codex reviewer invocation is not deterministic: no required invocation receipt, no deterministic gate, no project-scoped Codex agent package, no tracked CI gate. (blocks: reviewer receipt enforcement outside the Cloud validator)
- `BLK-003` Supabase write access from claude_code_cloud is NOT_PROVEN. (blocks: any Cloud task requiring a database write)
- `BLK-004` Ireland runtime access and Ireland repository remote identity are NOT_PROVEN. (blocks: C2 execution routing)

## 4. Execution targets

**`claude_code_cloud`** — host_dependency false, terminal_required false, surfaces CLOUD_WEB/CLOUD_MOBILE
- PROVEN: REPOSITORY_READ, DEPENDENCY_INSTALL, TYPECHECK, BUILD, DATABASE_READ, PRODUCTION_HTTPS_READ, GIT_PUSH_FEATURE_BRANCH
- NOT PROVEN: DATABASE_WRITE, GITHUB_PR_CREATE, GITHUB_PR_MERGE, IRELAND_RUNTIME_ACCESS, WEATHER_GATE_REVIEW, CONTUR_GATE_REVIEW, DEPLOY

**`local_codex_windows`** — host_dependency true, terminal_required false, surfaces DESKTOP/MOBILE_REMOTE
- PROVEN: REPOSITORY_READ, DEPENDENCY_INSTALL, TYPECHECK, BUILD, LOCAL_TEST_RUN, GIT_PUSH_FEATURE_BRANCH, GITHUB_PR_CREATE, GITHUB_PR_MERGE, WEATHER_GATE_REVIEW, CONTUR_GATE_REVIEW, DETERMINISTIC_REVIEWER_INVOCATION, DATABASE_READ
- NOT PROVEN: DATABASE_WRITE, PRODUCTION_HTTPS_READ, IRELAND_RUNTIME_ACCESS, DEPLOY

**`ireland_local`** — host_dependency true, terminal_required true, surfaces none
- PROVEN: none
- NOT PROVEN: REPOSITORY_READ, RUNTIME_ACCESS, REMOTE_IDENTITY, AGENT_AVAILABILITY, DEPLOY

Access surfaces are not executors: CLOUD_WEB→claude_code_cloud, CLOUD_MOBILE→claude_code_cloud, DESKTOP→local_codex_windows, MOBILE_REMOTE→local_codex_windows.

## 5. Routing (minimum agents — never all agents)

| Risk class | Executors | Required reviewers | Fail closed |
|---|---|---|---|
| `R0_READ_ONLY` | claude_code_cloud, local_codex_windows | — | no |
| `R1_BOUNDED_CODE` | claude_code_cloud, local_codex_windows | — | no |
| `R2_ARCHITECTURE_OR_ROADMAP` | claude_code_cloud, local_codex_windows | — | no |
| `R3_WEATHER_MODEL_CHANGE` | claude_code_cloud, local_codex_windows | premvp.reviewer.weather_gate.v1 | no |
| `R4_CONTUR_PRODUCTION_BOUNDARY` | claude_code_cloud, local_codex_windows | premvp.reviewer.contur_gate.v1 | no |
| `R5_CROSS_REPO_OR_LIVE_MONEY` | — | — | **YES** |

R5 fails closed: default verdict `BLOCKED`, no eligible executor, no permitted repository.

## 6. Prompt contract

Short Founder presentation + one executor block only. Every task invokes `premvp.command.execution_precheck.v1`; no default/substitution. Missing hard-boundary input → `PROMPT_GATE_BLOCKED`.

## 7. Reviewers and agents

- `premvp.reviewer.weather_gate.v1` — portable_project_scoped, EXPLICIT, receipt REQUIRED, triggers: R3_WEATHER_MODEL_CHANGE; Weather model behavior change
- `premvp.reviewer.contur_gate.v1` — portable_project_scoped, EXPLICIT, receipt REQUIRED, triggers: R4_CONTUR_PRODUCTION_BOUNDARY; Contur exact-SHA acceptance; production-boundary acceptance
- Other registered entries (no receipt or deprecated): 2 AGENT, 15 COMMAND, 2 HOOK, 3 SCRIPT, 1 CI_GATE, 6 POLICY — see AGENT_REGISTRY.yaml.

## 8. PREMVP / Ireland boundary

- PREMVP: `POLYPROPICKS/PREMVP` via claude_code_cloud, local_codex_windows
- Ireland: PROTECTED_BOUNDARY_ONLY; access in Phase 1/2: false
- PREMVP and Ireland implementation prompts cannot be mixed. One prompt, one repository boundary.

## 9. Operator

- Interface: **STANDARD_CHAT**; Work is ESCALATION_ONLY
- Operator mode: **MOBILE_REMOTE**; action budget 0–1 per task
- Never in normal flow: WINDOWS_CMD, POWERSHELL, SQL, SSH, SUPABASE_UI_QUERY, CWD_SELECTION, MANUAL_REPOSITORY_SELECTION, SECRET_COPY
- Escape hatch: `BREAK_GLASS_OPERATOR_ACTION`

## 10. Stop conditions

`CONTROL_PLANE_WRONG_REPOSITORY` · `CONTROL_PLANE_SCOPE_EXPANSION_REQUIRED` · `PROMPT_GATE_BLOCKED` · `CAPABILITY_NOT_PROVEN` · `REVIEWER_RECEIPT_MISSING` · `REPOSITORY_BOUNDARY_MIXED` · `SECRETS_REQUIRED`

Recoverable root/state/dependency/PR/deployment conditions are executor-owned; EXPECTED_NON_BLOCKING, EXECUTOR_OWNED_RECOVERY and RESUMABLE_WAIT always set founder_action none. Invalid ancestry and semantic boundaries remain hard stops.

## 11. Evidence identifiers

- Proven passes: CLOUD_REPO_READ, CLOUD_NPM_CI, CLOUD_SUPABASE_SELECT, CLOUD_TYPECHECK, CLOUD_BUILD, CODEX_WEATHER_REVIEWER_PRESENT, CODEX_CONTUR_REVIEWER_PRESENT, CONTROL_PLANE_PHASE_1_2_MERGED, CLOUD_PRODUCTION_BUILD_PROVENANCE_READ, PROMPT_CONTRACT_PR96
- External checkpoints: CHK-C1-20260803, CHK-CLOUD-CAPABILITY, CHK-CODEX-INVENTORY
- Freshness: 7 days from 2026-08-07T11:11:09Z
- Stale when: main.origin_main_sha is NOT an ancestor of live origin/main (STATE_STALE); main.origin_main_sha IS an ancestor of live origin/main, live origin/main is ahead of it, and any path changed between them falls outside stale_state_behavior.state_bootstrap_allowlist in ARCHITECT_CONTROL_PLANE.yaml (STATE_REFRESH_REQUIRED); updated_at is older than evidence_freshness.max_age_days; an accepted completion envelope exists whose completion_id is newer than last_accepted_completion_id; a referenced execution target verdict in CAPABILITY_MATRIX.yaml has passed its expires_when
