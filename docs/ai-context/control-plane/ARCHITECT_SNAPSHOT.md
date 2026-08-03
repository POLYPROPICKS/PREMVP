# ARCHITECT_SNAPSHOT.md — Compact Architect Context

<!-- GENERATED FILE — do not edit by hand. Regenerate: npm run control-plane:snapshot -->

State v1 · updated 2026-08-03T00:00:00Z · policy 1.0.0

## 1. Source authority

**Runtime facts:** LIVE_RUNTIME_EVIDENCE > CURRENT_STATE_ENTRY > TRACKED_DOCUMENTATION > EXECUTOR_SELF_REPORT > CHAT_MEMORY

**Product decisions:** CURRENT_FOUNDER_DECISION > CONTROL_PLANE_POLICY > LOCKED_PRODUCT_DECISIONS > HISTORICAL_CHECKPOINT > CHAT_MEMORY

A Founder statement never by itself yields a runtime PASS.

Only current-state authority: `CURRENT_STATE.yaml`. `EVIDENCE_LEDGER.md` is history and never authoritative for current state.

## 2. Phase and value steps

- Phase: **CONTUR3_QUEUE_AUTHORITY**
- Current step: **C1 — Queue authority cutoff** (OPEN)
- Next two: **C2** Ireland execution reads only the immutable Queue → **SETTLEMENT_PNL** Settlement / PnL and production vertical proof
- main @ POLYPROPICKS/PREMVP: `6e593a5d0e66e50941f130f7792f67e487dbb347`
- Last accepted completion: none

## 3. Blockers

- `BLK-001` C1 CTL18 assertion failure is unresolved. (blocks: C1)
- `BLK-002` Codex reviewer invocation is not deterministic: no required invocation receipt, no deterministic gate, no project-scoped Codex agent package, no tracked CI gate. (blocks: reviewer receipt enforcement outside the Cloud validator)
- `BLK-003` Supabase write access from claude_code_cloud is NOT_PROVEN. (blocks: any Cloud task requiring a database write)
- `BLK-004` Ireland runtime access and Ireland repository remote identity are NOT_PROVEN. (blocks: C2 execution routing)

## 4. Execution targets

**`claude_code_cloud`** — host_dependency false, terminal_required false, surfaces CLOUD_WEB/CLOUD_MOBILE
- PROVEN: REPOSITORY_READ, DEPENDENCY_INSTALL, TYPECHECK, BUILD, DATABASE_READ, PRODUCTION_HTTPS_READ, GIT_PUSH_FEATURE_BRANCH
- NOT PROVEN: DATABASE_WRITE, IRELAND_RUNTIME_ACCESS, WEATHER_GATE_REVIEW, CONTUR_GATE_REVIEW, DEPLOY

**`local_codex_windows`** — host_dependency true, terminal_required false, surfaces DESKTOP/MOBILE_REMOTE
- PROVEN: REPOSITORY_READ, LOCAL_TEST_RUN, WEATHER_GATE_REVIEW, CONTUR_GATE_REVIEW
- NOT PROVEN: DETERMINISTIC_REVIEWER_INVOCATION, DATABASE_READ, DATABASE_WRITE, IRELAND_RUNTIME_ACCESS, DEPLOY

**`ireland_local`** — host_dependency true, terminal_required true, surfaces none
- PROVEN: none
- NOT PROVEN: REPOSITORY_READ, RUNTIME_ACCESS, REMOTE_IDENTITY, AGENT_AVAILABILITY, DEPLOY

Access surfaces are not executors: CLOUD_WEB→claude_code_cloud, CLOUD_MOBILE→claude_code_cloud, DESKTOP→local_codex_windows, MOBILE_REMOTE→local_codex_windows.

## 5. Routing (minimum agents — never all agents)

| Risk class | Executors | Required reviewers | Fail closed |
|---|---|---|---|
| `R0_READ_ONLY` | claude_code_cloud, local_codex_windows | — | no |
| `R1_BOUNDED_CODE` | claude_code_cloud | — | no |
| `R2_ARCHITECTURE_OR_ROADMAP` | claude_code_cloud | — | no |
| `R3_WEATHER_MODEL_CHANGE` | local_codex_windows | codex.agent.weather_gate_reviewer.v0 | no |
| `R4_CONTUR_PRODUCTION_BOUNDARY` | local_codex_windows | codex.agent.contur_gate_reviewer | no |
| `R5_CROSS_REPO_OR_LIVE_MONEY` | — | — | **YES** |

R5 fails closed: default verdict `BLOCKED`, no eligible executor, no permitted repository.

## 6. Prompt contract

Every executor prompt is one copyable block containing all mandatory sections of `PROMPT__PROTOCOL.md` §2. Do not summarise or drop sections. Missing, guessed or contradictory input → `PROMPT_GATE_BLOCKED`.

## 7. Reviewers and agents

- `codex.agent.weather_gate_reviewer.v0` — local_codex_windows, EXPLICIT, receipt REQUIRED, triggers: R3_WEATHER_MODEL_CHANGE; Weather model behavior change
- `codex.agent.contur_gate_reviewer` — local_codex_windows, EXPLICIT, receipt REQUIRED, triggers: R4_CONTUR_PRODUCTION_BOUNDARY; Contur exact-SHA acceptance; production-boundary acceptance
- Other registered entries (no receipt): 3 COMMAND, 2 HOOK, 3 SCRIPT, 1 CI_GATE, 6 POLICY — see AGENT_REGISTRY.yaml.

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

`CONTROL_PLANE_WRONG_REPOSITORY` · `CONTROL_PLANE_DIRTY_WORKTREE` · `CONTROL_PLANE_SCOPE_EXPANSION_REQUIRED` · `PROMPT_GATE_BLOCKED` · `STATE_STALE` · `CAPABILITY_NOT_PROVEN` · `REVIEWER_RECEIPT_MISSING` · `REPOSITORY_BOUNDARY_MIXED` · `SECRETS_REQUIRED`

Stale state: **FAIL_CLOSED** — return PROMPT_GATE_BLOCKED and request a bounded read-only refresh.

## 11. Evidence identifiers

- Proven passes: CLOUD_REPO_READ, CLOUD_NPM_CI, CLOUD_SUPABASE_SELECT, CLOUD_TYPECHECK, CLOUD_BUILD, CODEX_WEATHER_REVIEWER_PRESENT, CODEX_CONTUR_REVIEWER_PRESENT
- External checkpoints: CHK-C1-20260803, CHK-CLOUD-CAPABILITY, CHK-CODEX-INVENTORY
- Freshness: 7 days from 2026-08-03T00:00:00Z
- Stale when: live origin/main SHA differs from main.origin_main_sha; updated_at is older than evidence_freshness.max_age_days; an accepted completion envelope exists whose completion_id is newer than last_accepted_completion_id; a referenced execution target verdict in CAPABILITY_MATRIX.yaml has passed its expires_when
