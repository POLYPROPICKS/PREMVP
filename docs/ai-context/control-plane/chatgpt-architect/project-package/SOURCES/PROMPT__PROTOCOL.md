# PROMPT__PROTOCOL.md — Canonical Mission Contract

<!-- ACTIVATION POINT: Before compiling ANY executor mission -->
<!-- OWNER: Architect Control Plane -->
<!-- AUTHORITY: canonical. Supersedes any untracked prompt-protocol file. -->

## 0. Authority

This file is the **one canonical executor task contract** for PolyProPicks.

- It is referenced by `ARCHITECT_CONTROL_PLANE.yaml → canonical_artifacts.prompt_protocol`.
- Its machine form is `MISSION_CONTRACT.schema.json`, compiled and semantically validated by
  `premvp.command.mission_compile.v1`.
- A file named `docs/ai-context/PROMPT__PROTOCOL.md` exists only in an **untracked Local
  Windows worktree**. It is **not** present in tracked `origin/main`, its authority is
  unresolved, and it **MUST NOT** be cited as authority by any agent.
- `PROMPT_COMPLETION_PROTOCOL.md` is absent. The completion contract is
  `COMPLETION_ENVELOPE.schema.json`.

### 0a. The retired model

The former fixed **25-section** executor prompt template is **RETIRED**. No rule in this
control plane requires "all 25 sections populated", and no artifact may reintroduce an
equivalent fixed-template enforcement. Missions are compact and contextual; generic HOW
belongs to registered commands and to the executor runtime, never to Architect prose.

## 1. Output shape

An architect output may contain a short Founder presentation followed by **exactly one
copyable Mission Contract block**. There are no alternative blocks and no text after it.

If the architect cannot produce a complete, non-contradictory mission, it MUST return
`PROMPT_GATE_BLOCKED` instead (§6).

## 2. Mission core — always required

| # | Section | Rule |
|---|---|---|
| 1 | `MISSION` | WHAT changes, in one or two sentences. Never a procedure. |
| 2 | `BUSINESS RESULT` | WHY — the value delivered once terminal acceptance holds. |
| 3 | `REPOSITORY` | Exactly one repository boundary: PREMVP **or** Ireland. |
| 4 | `SCOPE` | Allowed paths, and what is explicitly out of scope. |
| 5 | `HARD BOUNDARIES` | Genuine boundaries only. Recoverable conditions are forbidden here. |
| 6 | `ACCEPTANCE` | Criteria, each tagged `START_GATE` or `TERMINAL`. |

## 2a. Conditional modules — only when directly relevant

`FOUNDER AUTHORIZATION` · `RUNTIME EVIDENCE` · `DATABASE` · `REVIEWER` · `RELEASE` ·
`PRODUCTION OBSERVATION` · `LIVE MONEY`

An omitted module is the normal case. Emitting an inapplicable module is a contract defect.

## 2b. What the Architect must NOT write

The Architect never restates mechanics that a registered command already owns:

- worktree procedure, fetch mechanics, dirty-root handling;
- dependency installation procedure;
- PR creation, merge mechanics, CI polling;
- reviewer polling, deployment polling;
- state reconciliation mechanics, resume mechanics;
- long generic `STOP CONDITIONS` lists.

Duplicating any of these fails compilation as `MISSION_MANUAL_ORCHESTRATION_DUPLICATION`.

Executor, model and session choices may be **displayed** to the Founder as routing
metadata. They are not mandatory mission sections.

## 3. Machine-enforced invariants

`premvp.command.mission_compile.v1` fails compilation on any of these:

| Invariant | Rule |
|---|---|
| `CAPABILITY_BY_DIRECT_ACTION_ONLY` | Every required capability names a `direct_action_ref` that declares it. A downstream consequence in another system creates **no** capability requirement — PREMVP producing a Queue that Ireland later consumes does **not** require `IRELAND_RUNTIME_ACCESS`. |
| `RISK_NOT_CAPABILITY` | Risk class controls authority, safety and reviewer requirement only. It never injects a technical capability; `R5` does not mean "require everything". |
| `APPLICATION_PERSISTENCE_NOT_RAW_DB_MUTATION` | Application-owned persistence is the application writing through its own code path. It must not require `DATABASE_WRITE`. |
| `ONE_REPOSITORY_BOUNDARY` | One mission, one boundary. A foreign-repository capability fails. |
| `REGISTERED_COMMAND_VALIDITY` | Registration **and** executable binding **and** executor invocability. An invented command id fails. |
| `RECOVERY_BEFORE_BLOCK` | A canonically recoverable condition may never be declared a hard boundary. |
| `INCOMPLETE_IS_NOT_TERMINAL` | Unfinished implementation never justifies a terminal block. |
| `SESSION_END_IS_TRANSPORT_RESUME` | Execution-slice exhaustion is transport state, not a business or authority block. |
| `OPERATOR_ACTION_BUDGET` | start ≤ 1, intermediate = 0, terminal result = 1. |
| `ACCEPTANCE_AFTER_EXECUTION` | `TERMINAL` criteria are measured after execution. "Not yet implemented" at task start never fails the start gate. |

Capabilities that are legitimately unknown at compile time are written
`RESOLVE_AT_RUNTIME` — never guessed.

## 3a. Executor-owned recovery

The following are **always** executor-owned and never returned to the Founder:

dirty Founder root · missing locked dependencies · generated artifact drift · existing or
draft PR · ordinary CI wait · ordinary deployment wait · reviewer correction and polling ·
safe state reconciliation · implementation and test correction · resumable transport or
session interruption.

The canonical classification lives in `EXECUTION_ESCALATION_TAXONOMY.json`. Read-only tasks
use `origin/main` or an isolated surface; write tasks use a dedicated clean worktree. The
Founder root is never cleaned, reset or used as unknown task input.

## 3b. Authorization versus evidence

`CAPABILITY_MATRIX.yaml` records `authorized` (policy permission) and `verdict` (live
runtime evidence) as two independent facts:

- Authorization alone never produces a runtime `PASS`.
- `NOT_PROVEN` means untested, not forbidden. A capability that is authorized with verdict
  `NOT_PROVEN` is proven by one bounded, safe, evidence-producing probe inside the same
  task (same-run capability bootstrap) — no separate Founder confirmation, no executor
  switch. A failed or unsafe probe fails closed with the exact blocker named.
- `NOT_AVAILABLE` genuinely blocks routing, as does `authorized: false`.

The named `FOUNDER_AUTHORIZED_CAPABILITY_BOOTSTRAP` exception never authorizes direct main
push, force push, branch-protection bypass, secret exposure, database write, manual
deployment, Ireland access, live money, or R5 work.

## 4. Hard prohibitions

1. **No guessed values.** A SHA, path, permission, capability verdict, command id or
   evidence claim that has not been resolved live or read from a canonical artifact may not
   appear.
2. **No mixed repository boundary.** Violation → `PROMPT_GATE_BLOCKED` with reason
   `REPOSITORY_BOUNDARY_MIXED`.
3. **No Founder-facing shell or database work in the normal flow.** No Windows CMD, no
   PowerShell, no SQL, no SSH, no Supabase UI query. Permitted only inside an explicitly
   labelled `BREAK_GLASS_OPERATOR_ACTION` that first proves no registered executor can
   perform the action.
4. **No all-agent routing.** Reviewers are selected by risk class only.
5. **No secrets.** Missions never contain, request or instruct printing of secret values.
6. **No self-accepted state.** A mission may ask for a `state_delta_proposal`; it may never
   authorize the writer to declare its own state accepted.
7. **No authority citation of untracked files.** In particular
   `docs/ai-context/PROMPT__PROTOCOL.md` is untracked, preservation-only and MUST NOT be
   cited as authority.
8. **Exactly one selected executor; no default or substitution.**

## 5. Reviewer receipt requirements

When the risk class names a reviewer with `receipt_required: true` in
`AGENT_REGISTRY.yaml`, the mission MUST require a receipt containing:

`agent_id` · `definition_hash` **or** `implementation_identity` · `configured_model` ·
`reasoning_policy` · `independence_group` · `reviewed_sha` · `verdict` · `evidence_refs`

and MUST state: **a task that requires a reviewer and has no valid receipt cannot return
`PASS`.** The receipt's `reviewed_sha` must equal the envelope's `result_sha`.

## 6. `PROMPT_GATE_BLOCKED`

Reserved for genuine canonical hard boundaries. The architect returns this instead of a
mission only when:

- a mission-core section cannot be populated with a concrete value;
- two canonical artifacts contradict each other irreconcilably;
- the task would mix repository boundaries;
- a required **direct** capability is genuinely unavailable on every eligible executor;
- a mandatory executable or reviewer is genuinely unavailable;
- the task would require secret exposure, forbidden schema/production mutation, or a
  prohibited Founder action;
- protected scope is requested without the required Founder authorization.

Never for: implementation incomplete, remaining work, a failed first attempt, a dirty
Founder root, missing dependencies, generated drift, ordinary CI/deployment/reviewer waits,
or session/runtime slice exhaustion.

Blocked output format:

```
PROMPT_GATE_BLOCKED
Reason: <canonical hard_stop_id>
Missing: <exact missing section / capability / evidence>
Recovery attempted: <registered recovery paths and why each is exhausted>
Narrowest safe next action: <one bounded read-only task>
Founder action: <one action, or none>
```

## 7. Compilation checklist (`MISSION_CONTRACT_CHECK`)

Run before emitting. All must be `true`:

- [ ] all six mission-core sections present and concrete
- [ ] only applicable conditional modules emitted
- [ ] exactly one repository boundary
- [ ] exactly one selected executor; no default or substitution
- [ ] every required capability resolves to a direct action that declares it
- [ ] no capability sourced from risk class
- [ ] application-owned persistence does not require raw DB mutation
- [ ] every referenced command is registered, bound and invokable by the selected executor
- [ ] no recoverable condition declared as a hard boundary
- [ ] acceptance criteria tagged `START_GATE` or `TERMINAL`, with at least one `TERMINAL`
- [ ] operator budget: start ≤ 1, intermediate = 0, terminal result = 1
- [ ] no guessed SHA, path, permission, command id or evidence
- [ ] no Founder CMD / PowerShell / SQL / SSH in the normal flow
- [ ] no registered lifecycle mechanics restated as mission prose
- [ ] `premvp.command.execution_precheck.v1` is invoked; missions do not hand-code
      dirty-root or stale-state recovery
- [ ] completion envelope requirement stated, with `outcome_class`
- [ ] reviewer receipt requirements stated where applicable
- [ ] Founder presentation plus exactly one mission block, with no text after it

## 8. Template

```
# MISSION
# BUSINESS RESULT
# REPOSITORY
# SCOPE
# HARD BOUNDARIES
# ACCEPTANCE

# (conditional, only when relevant)
# FOUNDER AUTHORIZATION
# RUNTIME EVIDENCE
# DATABASE
# REVIEWER
# RELEASE
# PRODUCTION OBSERVATION
# LIVE MONEY
```
