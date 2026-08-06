# PROMPT__PROTOCOL.md — Canonical Executor Prompt Contract

<!-- ACTIVATION POINT: Before compiling ANY executor prompt -->
<!-- OWNER: Architect Control Plane -->
<!-- AUTHORITY: canonical. Supersedes any untracked prompt-protocol file. -->

## 0. Authority

This file is the **one canonical executor prompt contract** for PolyProPicks.

- It is referenced by `ARCHITECT_CONTROL_PLANE.yaml → canonical_artifacts.prompt_protocol`.
- A file named `docs/ai-context/PROMPT__PROTOCOL.md` exists only in an **untracked Local
  Windows worktree**. It is **not** present in tracked `origin/main`, its authority is
  unresolved, and it **MUST NOT** be cited as authority by any agent.
- `PROMPT_COMPLETION_PROTOCOL.md` is absent. The completion contract is
  `COMPLETION_ENVELOPE.schema.json`.

## 1. Output shape

An architect output may contain a short Founder presentation followed by **exactly one
copyable execution block**. There are no alternative blocks and no text after that block.

If the architect cannot produce a complete, non-contradictory block, it MUST return
`PROMPT_GATE_BLOCKED` instead (§5).

## 2. Mandatory prompt sections

A prompt is **invalid** unless every section below is present and populated with a
concrete value. `N/A` is permitted only where the section explicitly allows it and only
with a stated reason.

| # | Section | Rule |
|---|---|---|
| 1 | `MODEL` | Exact model identifier for the executor. |
| 2 | `MODEL LEVEL` | Reasoning/effort level. |
| 3 | `SESSION MODE` | `NEW SESSION` or `CONTINUE SESSION`. |
| 4 | `SESSION REASON` | Why this session exists, in one paragraph. |
| 5 | `EXECUTION ENVIRONMENT` | Executor id from `CAPABILITY_MATRIX.yaml`. Never invented. |
| 6 | `REPOSITORY / WORKTREE / CWD` | From `CAPABILITY_MATRIX.yaml`. Exactly one repository boundary. |
| 7 | `BRANCH / TARGET REF / TARGET SHA` | Named branch policy. A SHA is either resolved live or explicitly marked `RESOLVE_AT_RUNTIME`. **Never guessed.** |
| 8 | `TOKEN / READ BUDGET` | Explicit read budget and full-read allowlist. |
| 9 | `VALUE TARGET` | The business value this task delivers. |
| 10 | `CURRENT ROADMAP PHASE` | From `CURRENT_STATE.yaml`. |
| 11 | `NEXT TWO VALUE STEPS` | Exactly two, from `CURRENT_STATE.yaml`. |
| 12 | `OPERATOR MODE` | Default `MOBILE_REMOTE`. |
| 13 | `TASK CLASS` | From `ROUTING_AND_PIPELINES.yaml → task_classes`. |
| 14 | `RISK CLASS` | One of `R0`–`R5`. |
| 15 | `REQUIRED CAPABILITIES` | Each must be `authorized: true` for the chosen executor per `CAPABILITY_MATRIX.yaml`, and hold verdict `PROVEN` on at least one eligible executor for the risk class. Authorization and evidence are distinct: a capability whose verdict is `NOT_PROVEN` is not thereby forbidden — see §3a same-run capability bootstrap. |
| 16 | `REQUIRED AGENTS / REVIEWERS` | Minimum set for the risk class. Never "all agents". |
| 17 | `PRECHECK` | Ordered, mechanical, evidence-producing steps. |
| 18 | `EXECUTION SCOPE` | What is in scope and what is explicitly out of scope. |
| 19 | `ALLOWED FILES` | Explicit list or glob set. |
| 20 | `FORBIDDEN FILES` | Explicit, including the catch-all "everything else". |
| 21 | `WRITE POLICY` | Write / commit / push / PR / merge / deploy permissions, each explicitly granted or denied. |
| 22 | `STOP CONDITIONS` | Named, machine-quotable identifiers. |
| 23 | `EVIDENCE REQUIRED` | Exact commands and artifacts. |
| 24 | `COMPLETION ENVELOPE` | Requirement to emit an envelope valid against `COMPLETION_ENVELOPE.schema.json`. |
| 25 | `FOUNDER ACTION` | Exactly one action, or `none`. |

## 3. Hard prohibitions

1. **No guessed values.** A SHA, path, permission, capability verdict or evidence claim
   that has not been resolved live or read from a canonical artifact may not appear.
2. **No mixed repository boundary.** A single prompt targets PREMVP **or** Ireland, never
   both. Violation → `PROMPT_GATE_BLOCKED` with reason `REPOSITORY_BOUNDARY_MIXED`.
3. **No Founder-facing shell or database work in the normal flow.** No Windows CMD, no
   PowerShell, no SQL, no SSH, no Supabase UI query. These are permitted only inside an
   explicitly labelled `BREAK_GLASS_OPERATOR_ACTION` that first proves no registered
   executor can perform the action.
4. **No all-agent routing.** Reviewers are selected by risk class only. The Weather
   reviewer is mandatory only for Weather model work; the Contur reviewer is mandatory
   only for Contur / exact-SHA / production-boundary acceptance work.
5. **No secrets.** Prompts never contain, request or instruct printing of secret values.
6. **No self-accepted state.** An implementation prompt may ask for a
   `state_delta_proposal`; it may never authorize the writer to declare its own state
   accepted.
7. **No authority citation of untracked files**, in particular
   the untracked `docs/ai-context/PROMPT__PROTOCOL.md` on the Local Windows worktree.

## 3a. Authorization versus evidence and normal mode

`CAPABILITY_MATRIX.yaml` records two independent facts per capability: `authorized`
(policy permission) and `verdict` (live runtime evidence: `PROVEN`, `FAILED`,
`NOT_PROVEN`, or `NOT_AVAILABLE`). These MUST NOT be collapsed into one:

- Authorization alone never produces a runtime `PASS`.
- Normal mode requires every required capability to be `PROVEN`. `NOT_PROVEN` means
  untested rather than forbidden, but it remains a fail-closed gate for an ordinary task.
- `NOT_AVAILABLE` means the runtime genuinely lacks the surface — that does block routing.
- `authorized: false` blocks routing regardless of verdict.

## 3b. `FOUNDER_AUTHORIZED_CAPABILITY_BOOTSTRAP` exception

Only an explicitly named Founder-authorized bootstrap may label one capability
`BOOTSTRAP_PENDING`. The prompt must name the decision, executor, PREMVP repository,
capability, authenticated transport, exact minimum proving call, and postconditions; it
must also prove same-runtime authentication and repository-read authority. The capability
is not usable by a dependent phase until the exact call succeeds and its runtime evidence
is captured. Failure leaves it `NOT_PROVEN` and returns `BLOCKED`; no executor switch or
intermediate Founder confirmation is implied.

This exception never authorizes direct main push, force push, branch-protection bypass,
secret exposure, database write, manual deployment, Ireland access, live money, or R5
work. It expires when the named bootstrap run completes or terminates.

## 3c. Executor-owned state reconciliation

When the baseline is an ancestor of live main and production equals main, refresh through
`premvp.command.control_plane_reconcile.v1` is executor-owned and never requires Founder
authorization. Invalid ancestry remains a HARD_SAFETY_STOP; writers never self-accept state.

## 4. Reviewer receipt requirements

When §2.16 names a reviewer with `receipt_required: true` in `AGENT_REGISTRY.yaml`, the
prompt MUST require a receipt containing:

- `agent_id`
- `definition_hash` **or** `implementation_identity`
- `configured_model`
- `reasoning_policy`
- `independence_group`
- `reviewed_sha`
- `verdict`
- `evidence_refs`

and MUST state: **a task that requires a reviewer and has no valid receipt cannot return
`PASS`.** The receipt's `reviewed_sha` must equal the envelope's `result_sha`.

## 5. `PROMPT_GATE_BLOCKED`

The architect returns this instead of a prompt when any of the following hold:

- a mandatory section from §2 cannot be populated with a concrete value;
- stale state has invalid ancestry or an unreconcilable semantic conflict;
- a required capability is not `PROVEN` for any eligible executor;
- two canonical artifacts contradict each other;
- the task would mix repository boundaries;
- the risk class is `R5_CROSS_REPO_OR_LIVE_MONEY` without separate authorization and
  proven capabilities;
- the task would require a prohibited Founder action.

The sole exception is an exact §3b bootstrap task whose concrete preconditions are all
present. Missing any one bootstrap field or precondition returns `PROMPT_GATE_BLOCKED`
immediately; failed proof returns `BLOCKED` and does not permit dependent work. §3c does
not relax ordinary stale-state handling.

Blocked output format:

```
PROMPT_GATE_BLOCKED
Reason: <named stop condition>
Missing: <exact missing section / capability / evidence>
Narrowest safe next action: <one bounded read-only task>
Founder action: <one action, or none>
```

## 6. Compilation checklist (`PROMPT_CONTRACT_CHECK`)

Run before emitting. All must be `true`:

- [ ] all 25 sections present and concrete
- [ ] exactly one repository boundary
- [ ] executor exists in `CAPABILITY_MATRIX.yaml`
- [ ] every required capability is `PROVEN`, or one named §3b `BOOTSTRAP_PENDING` capability has every concrete exception field and no dependent phase precedes proof
- [ ] required agents are the minimum set for the risk class
- [ ] every required agent exists in `AGENT_REGISTRY.yaml`
- [ ] `NEXT TWO VALUE STEPS` has exactly two entries and matches `CURRENT_STATE.yaml`
- [ ] no guessed SHA, path, permission or evidence
- [ ] no Founder CMD / PowerShell / SQL / SSH in the normal flow
- [ ] Founder action budget ≤ 1
- [ ] completion envelope requirement stated
- [ ] reviewer receipt requirements stated where applicable
- [ ] bootstrap proving call and resulting capability transition reported where §3b applies
- [ ] exactly one selected executor; no default or substitution
- [ ] `premvp.command.execution_precheck.v1` is invoked; prompts do not hand-code dirty-root or stale-state recovery
- [ ] Founder presentation plus exactly one executor block, with no text after it

## 7. Template

```
# MODEL
# MODEL LEVEL
# SESSION MODE
# SESSION REASON
# EXECUTION ENVIRONMENT
# REPOSITORY / WORKTREE / CWD
# BRANCH / TARGET REF / TARGET SHA
# TOKEN / READ BUDGET
# VALUE TARGET
# CURRENT ROADMAP PHASE
# NEXT TWO VALUE STEPS
# OPERATOR MODE
# TASK CLASS
# RISK CLASS
# REQUIRED CAPABILITIES
# REQUIRED AGENTS / REVIEWERS
# PRECHECK
# EXECUTION SCOPE
# ALLOWED FILES
# FORBIDDEN FILES
# WRITE POLICY
# STOP CONDITIONS
# EVIDENCE REQUIRED
# COMPLETION ENVELOPE
# FOUNDER ACTION
```
