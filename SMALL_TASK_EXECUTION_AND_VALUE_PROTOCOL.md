# SMALL_TASK_EXECUTION_AND_VALUE_PROTOCOL

Status: MANDATORY — Tier 0
Applies to: PolyProPicks / PREMVP
Owner: ChatGPT architect / technical lead
Purpose: prevent small production defects from expanding into long prompt-review loops with low shipped value and high Founder cost.

## 1. Core invariant

A small task follows one bounded path:

```text
one read-only proof
→ one complete bounded TDD patch
→ one independent review
→ at most one minimal correction and delta re-review
→ merge/deploy
→ one runtime proof
```

A task may not silently expand because a new issue is discovered.

## 2. Evidence status

Every important claim must be labeled by evidence strength:

```text
PROVEN     — verified directly from current git/source/runtime evidence
SUPPORTED  — supported by executor report or secondary artifact, but not independently verified
INFERRED   — reasoned conclusion from proven facts
UNKNOWN    — evidence is absent or conflicting
```

Examples:

- an executor summary that names a commit is `SUPPORTED` until `git show` or equivalent source evidence verifies it;
- a merged PR is not a production effect until deployment and runtime evidence are verified;
- a monitor omission is not proof that a producer failed;
- a query failure is not proof that a business row is absent.

## 3. TASK CONTRACT — required before the first Founder action

Every task begins with one frozen contract:

```text
TASK CONTRACT
DoD: <one falsifiable sentence describing what will be true at completion>
BUSINESS EFFECT: ADVANCES_LIVE_CONTOUR / OBSERVABILITY_ONLY / HYGIENE_ONLY
OPERATOR BUDGET: <default 3 Founder cycles; maximum 5 without explicit re-contract>
EXPECTED ARTIFACTS: <specific commit / PR / report / runtime proof>
REVIEW CHECKLIST: <fixed list defined before implementation>
NOT IN SCOPE: <explicit exclusions>
FIRST PROOF: <first fact that must be verified>
MINIMAL CHANGE BOUNDARY: <smallest code/runtime boundary that can satisfy DoD>
```

The contract may not be changed silently.

If a blocker proves the contract wrong, the task must STOP and return a formal re-contract proposal. Only the Founder may authorize the replacement contract.

### Business-effect disclosure

If `BUSINESS EFFECT` is not `ADVANCES_LIVE_CONTOUR`, the first plain-language status must say:

```text
ЭТА ЗАДАЧА НЕ ПРИБЛИЖАЕТ LIVE CONTOUR
```

Explicit Founder confirmation is required when the architect initiated the task or when it displaces an active live-contour window. A Founder-requested observability or hygiene task does not require a redundant confirmation, but its classification must remain visible.

## 4. Operator-cycle budget

An operator cycle is any assistant message that requires the Founder to:

- run a command;
- paste output;
- provide a screenshot;
- authorize or confirm an action;
- switch tools, terminals, accounts, models, or environments.

Every such response starts with:

```text
OPERATOR CYCLE: k / N
```

Rules:

- at `k = N - 1`, warn that one cycle remains;
- at `k = N`, no further Founder action may be requested;
- the next response must be a `BUDGET OVERRUN REPORT`;
- internal executor/tool calls that require no Founder action do not consume an operator cycle;
- the cycle ledger must state what evidence or artifact each cycle produced.

## 5. Scope freeze

Any defect discovered during the task that is outside the frozen DoD:

```text
→ add to DEFERRED FINDINGS
→ do not fix it
→ do not request another Founder action for it
→ do not convert it into a new prompt in the current task
```

Forbidden behavior:

- “review found one more missing check, so add it now”;
- “while we are here, fix this too”;
- “this is adjacent, so include it”;
- silently expanding files, tables, services, schema, or runtime scope.

If a new issue blocks the DoD:

1. STOP the task;
2. classify the issue;
3. return evidence;
4. propose a new TASK CONTRACT;
5. wait for Founder approval.

Immediate money-loss, security, or production-integrity risk is an escalation reason, not permission for an autonomous scope expansion.

## 6. Batching rule

All Founder commands for one cycle are issued in one complete block.

Forbidden:

```text
one command → paste output → next command → paste output
```

All read-only checks that can reasonably be predicted from the same decision tree must be batched together.

A large implementation prompt must never be issued before external access/environment/preflight gates pass. Use a short gate first, then the bounded implementation task.

## 7. Decision-table pre-commitment

No Founder command may be requested without declaring the complete decision table first:

```text
result A → action X
result B → action Y
result C → STOP, exact reason
```

“Let us see what happens” is not an acceptable plan.

If a decision table cannot be written, the architect must state which unknown prevents it and request only the evidence needed to resolve that unknown.

## 8. Fixed review checklist

The review checklist is frozen in the TASK CONTRACT before the writer patch begins.

The reviewer checks the complete bounded diff against:

1. the frozen checklist;
2. correctness of the changed code;
3. security, money-movement, production-integrity, and data-integrity risks introduced by the diff.

A reviewer may block on a critical defect inside the changed diff even when the checklist omitted it. However:

- the reviewer must identify it as `CHECKLIST_GAP`;
- the reviewer must not silently expand implementation scope;
- the current task either receives one minimal correction within the original boundary or STOPs for re-contract;
- non-blocking findings go to `DEFERRED FINDINGS`.

Iteratively adding ordinary coverage preferences one-by-one after implementation is forbidden.

## 9. Review-loop limit

For a bounded small task:

```text
one complete writer pass
→ one independent full-diff review
→ at most one minimal correction
→ one delta re-review
```

A second correction/re-review loop is forbidden unless the correction materially changes:

- security;
- money movement;
- schema;
- external integration;
- production behavior;
- original file/scope boundary.

Otherwise the task must STOP with `WORKFLOW_FAILURE_STOP`.

## 10. Progress definition

Progress depends on task class.

### For `ADVANCES_LIVE_CONTOUR`

Only movement through this chain counts as live-contour progress:

```text
Reservation
→ queue with correct immutable identity and time
→ Ireland claim
→ venue order
→ callback to exact queue_id
→ terminal state
```

Builds, tests, commits, merged PRs, monitor improvements, and diagnostics are supporting artifacts, not live-contour progress.

### For `OBSERVABILITY_ONLY`

Progress is a verified improvement in measurement truthfulness, coverage, or runtime evidence.

### For `HYGIENE_ONLY`

Progress is the exact committed context/process artifact defined by DoD.

Reports must never present observability or hygiene work as advancement of the live contour.

## 11. Rule of two

Automatic STOP applies when either occurs:

1. two consecutive Founder cycles produce neither a new repository artifact nor new decision-changing runtime evidence;
2. two consecutive findings are the same defect class;
3. two consecutive review cycles add ordinary requirements that should have been in the original checklist.

For implementation tasks, a repository artifact means a concrete diff/commit/PR.
For inspect-only tasks, fresh decision-changing evidence counts as progress.

The executor/architect must declare STOP before the Founder has to notice the loop.

## 12. Budget overrun report

At the operator-budget limit, return exactly:

```text
BUDGET OVERRUN
Operator cycles used: N
DoD achieved: YES / NO / PARTIAL
Business effect delivered: ADVANCES_LIVE_CONTOUR / OBSERVABILITY_ONLY / HYGIENE_ONLY / NONE
Repository changes: <commit/PR or NONE>
Runtime evidence: <what is proven or NONE>
Still unproven: <list>
Primary reason:
  (a) DoD was wrong
  (b) an earlier contour defect was discovered
  (c) scope freeze was violated
  (d) external access/environment/data blocker
  (e) reviewer checklist was incomplete
Proposed action: re-contract / split / cancel
FOUNDER ACTION: one action
```

No further work may continue under the old contract.

## 13. Estimation rule — no calibrated fantasies

Before the first proof and scope freeze, numeric probability and time-to-production estimates are forbidden.

Use:

```text
Gate X: PROVEN / NOT PROVEN
Estimate unavailable until: <specific evidence>
```

After the task contract is frozen and source/runtime evidence exists, a bounded planning estimate is allowed only when it includes:

- the exact remaining gates;
- assumptions;
- what waiting time is external;
- a confidence label: LOW / MEDIUM / HIGH.

It must be described as a planning estimate, not a promise.

## 14. Runtime service state

Neither architect nor executor may change production service state unless the Founder explicitly authorizes that exact service action.

Any observed state must be reported as:

```text
SERVICE STATE
service: <exact verified name>
state: <observed state>
observed_at: <timestamp>
source: <command/API/log>
changed_by: <known actor / UNKNOWN>
authorized_by: <Founder message reference / NONE / NOT APPLICABLE>
```

If a service state changed and `authorized_by = NONE`, classify it as a P0 process violation and escalate. Do not restart, stop, enable, disable, redeploy, or toggle flags autonomously.

Phrases such as “Ireland is off” or “the service is enabled” are forbidden without fresh evidence, timestamp, and exact service identity.

## 15. Abstraction-level rule

Do not guess names of:

- services;
- jobs;
- tables;
- files;
- branches;
- routes;
- environment variables.

When the exact name is unknown, request or inspect the authoritative list. An assumed name must be labeled `UNVERIFIED`, never stated as fact.

## 16. ID-first implementation rule

For identity propagation, prefer the smallest direct contract:

```text
immutable source ID
→ decision
→ Reservation
→ queue
→ Ireland instruction
→ callback to exact queue_id
```

Do not introduce new entity layers, revision systems, mapping tables, generalized provenance infrastructure, or broad schema when the existing path can safely carry immutable IDs.

New architecture requires proof that direct propagation cannot satisfy correctness.

## 17. Commit and production-effect rule

Commit each completed meaningful checkpoint.

Always distinguish:

```text
commit/push
≠ production effect

merge + deploy + runtime proof
= production effect
```

A checkpoint is valuable for recovery but must not be described as live behavior.

## 18. Context-file editing rule

The architect must not tell external agents to “open and edit” project context files when the current full text is unavailable.

Instead:

1. use the full file already provided in the conversation; or
2. request the complete current file from the Founder; then
3. return the fully corrected replacement file or a clearly bounded patch.

Do not offload context reconciliation to another agent without source text.

## 19. Mandatory plain-language technical-lead output

Every engineering response must include:

```text
PLAIN-LANGUAGE STATUS
BUSINESS EFFECT CLASS
WHAT CHANGED
WHAT DID NOT CHANGE
CURRENT PRODUCTION EFFECT
EVIDENCE STATUS: PROVEN / SUPPORTED / INFERRED / UNKNOWN
NEXT TWO STEPS
OPERATOR CYCLE: k / N, when Founder action is required
```

Technical detail follows only after the plain-language explanation.

## 20. Failure lesson — 2026-07-29 monitor loop

Observed pattern:

- approximately thirty Founder/executor interactions;
- executor-reported output limited mainly to one live-funnel monitor correction and supporting tests;
- a separate provider-provenance classifier commit was reported but not connected to the production path;
- identity propagation, Reservation→queue correction, and Ireland behavior were not advanced by the monitor task.

Evidence status:

```text
executor artifact claims: SUPPORTED
independent git/source verification: required before PROVEN
```

Correct workflow should have been:

```text
one direct production probe
→ one complete TDD monitor patch covering linkage, query failure, and aggregate isolation
→ one full review
→ at most one minimal correction/delta review
→ merge/deploy
→ one runtime proof
```

Root technical-lead failures:

- no immutable TASK CONTRACT;
- no Founder-cycle counter or budget;
- acceptance criteria discovered serially after implementation;
- each new review finding was absorbed into the current scope;
- large prompts were issued before external gates passed;
- observability work was described without immediately stating that it did not advance the live contour;
- global task cost was not measured even though each local step appeared bounded and defensible.

Permanent prevention is this protocol.
