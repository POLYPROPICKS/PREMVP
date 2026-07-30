# LIVE CONTOUR 6 — Canonical Execution Architecture and Operating Protocol

**Project:** PolyProPicks / PREMVP
**Status:** Founder-approved architecture direction
**Decision date:** 2026-07-30
**Canonical repo:** `C:\WORK\KalshiProPulse\sipropicks-premvp1-1`
**Production:** `https://polypropicks.com`
**Audited production commit:** `6857965d1cf097b37880e429c1f9d41f88883159`

---

## 1. Purpose

LIVE CONTOUR 6 defines the canonical architecture and engineering process for taking one real PolyProPicks event from source selection to terminal execution evidence.

It exists to prevent a repeat of the ten-day integration loop in which individual components and tests passed while the complete business transaction remained unproven.

This document governs:

- identity ownership;
- Reservation and Queue lifecycle;
- Ireland handoff and callback correlation;
- graph-assisted development;
- real-entry TDD;
- model routing;
- Code Auditor behavior;
- production acceptance;
- operator-time limits.

It does not override locked product decisions, security rules, payment/auth boundaries, or founder approval gates.

---

## 2. Founder Decision — Canonical Identity Model

### 2.1 One occurrence → one Reservation

A `Reservation` represents planning intent for exactly one physical event occurrence.

A new physical occurrence must create a new `reservation_id`.

A Reservation must never be reused when any canonical occurrence identity changes, including:

- `physical_event_id`;
- `event_start_iso`;
- selected source/signal/observation identity;
- `condition_id`;
- `token_id`;
- `side`.

### 2.2 Queue is immutable

A Queue row represents one exact execution instruction.

After creation, its business identity must not be rewritten to point to another occurrence, market, outcome, side, or Reservation.

The immutable instruction spine is:

```text
queue_id
reservation_id
physical_event_id
selected_source_or_signal_id
condition_id
token_id
side
event_start_iso
idempotency_key
```

Operational status may advance through the existing lifecycle, but the instruction identity must remain unchanged.

### 2.3 Old Queue rows are historical records

A stale or missed Queue row is not reused for a new occurrence.

It must reach an explicit supported terminal state such as the current repository's canonical equivalent of:

- `EXPIRED`;
- `SUPERSEDED`;
- `MISSED_WINDOW`;
- `FAILED`.

Do not invent a new status without an explicit schema/lifecycle decision.

### 2.4 Callback correlation

Ireland and PREMVP correlate execution by exact identifiers, primarily:

```text
queue_id + idempotency_key + venue_order_id
```

Callback processing must not rediscover an event by text, team names, approximate time, market title, or fuzzy keys.

---

## 3. Canonical End-to-End Spine

```text
provider/source row
→ normalized physical event occurrence
→ admitted planning candidate
→ Reservation for that occurrence
→ immutable Queue instruction
→ READY within active entry window
→ Ireland receives exact instruction
→ order attempt / explicit rejection
→ callback correlated by queue_id
→ terminal persistence
→ accounting / PnL evidence
```

Each boundary has one producer, one consumer, one identity contract, and one observable result.

A component is not considered integrated merely because its local test passes.

---

## 4. Architectural Verdict from Global Review

### 4.1 Continue the architecture

The current architecture is viable and should not be rewritten.

Evidence already proved that:

- producer rows exist;
- Reservations are created;
- Queue rows are created;
- READY rows exist;
- the main code path is connected in Graphify and CodeGraph;
- production commit matches the audited commit;
- scheduler, serializer, order-event and callback contracts exist.

### 4.2 Required bounded correction

The system currently lacks a fully enforced identity and lifecycle contract across Reservation and Queue.

The first proven production defect was:

```text
4 Reservations
→ 1 Queue row
```

A reviewed target connected a Reservation occurrence at `2026-07-29T16:35Z` with a Queue occurrence at `2026-07-27T22:40Z`.

Source inspection further proved:

- duplicate suppression can use `reservation_id` before occurrence parity;
- database uniqueness on `(reservation_id, selection_rank)` blocks a second row for the same Reservation/rank;
- therefore rewriting only the Queue duplicate guard is unsafe;
- the correct first boundary is upstream ownership: a new occurrence must not reuse the old Reservation identity.

### 4.3 Root cause of the ten-day loop

The delay was primarily a process and boundary-definition failure:

1. local symptoms were patched instead of tracing the first broken business boundary;
2. tests frequently began after the suspected defect;
3. in-memory repositories created confidence not matched by persisted production data;
4. identity was sometimes reconstructed rather than carried forward;
5. build/test PASS was treated as integration progress without a new production fact;
6. executor STOPs created repeated operator microcycles;
7. Sol was used too often after the architecture problem was already localized.

---

## 5. Immediate Recovery Plan

### Phase 6.1 — Reservation identity correction

**Goal:** prove and enforce that a new occurrence creates a new Reservation.

Required work:

1. Use CodeGraph to locate the exact producer of `reservation_id` and all reuse/upsert/deduplication decisions.
2. Add a production-shaped failing test:
   - prior occurrence `T1` already has Reservation `R1` and Queue `Q1`;
   - current occurrence `T2` has the same teams/market family but different canonical occurrence identity;
   - current behavior incorrectly reuses `R1` or links `T2` to `Q1`;
   - required behavior creates a new Reservation `R2` for `T2`.
3. Implement the smallest correction at the Reservation identity owner.
4. Preserve the existing Queue uniqueness constraint unless the test proves a schema change is unavoidable.
5. Do not modify Ireland, callback, UI, auth, payments, or unrelated scoring.

**Required proof:**

```text
T1 → R1 → Q1
T2 → R2 → Q2
R1 != R2
Q1 immutable
Q2 carries T2 identity
```

### Phase 6.2 — Queue lifecycle correction

**Goal:** every stale READY instruction reaches an explicit terminal state and cannot appear executable after its entry window.

Required behavior:

- active READY is visible to Ireland;
- expired READY is not executable;
- status and API visibility cannot contradict each other;
- terminalization is idempotent;
- old Queue identity remains immutable.

This phase must not be mixed into Phase 6.1 unless the same existing lifecycle owner and the same failing regression require it.

### Phase 6.3 — Ireland observability

Run only after one fresh, canonical READY row exists.

Prove separately:

```text
instruction serialized
→ delivery/poll observed
→ Ireland acknowledgement
→ order attempt or explicit rejection
→ callback by queue_id
```

Absence of Ireland evidence before a valid READY candidate is not proof that Ireland is broken.

### Phase 6.4 — Terminal and PnL proof

Complete one vertical trace:

```text
source_id
reservation_id
queue_id
idempotency_key
venue_order_id
callback
terminal status
PnL/accounting record
```

---

## 6. Time-Boxed Execution Plan

For the current reservation window, use the following order:

| Work | Target duration | Model |
|---|---:|---|
| CodeGraph boundary extraction + failing test | 20–35 min | Terra |
| Minimal Reservation identity patch + targeted tests | 45–75 min | Terra |
| Independent Code Auditor review | 20–30 min | Luna |
| TypeScript/build/diff and atomic commit decision | 20–30 min | Terra/Luna evidence |
| Push, Railway auto-deploy and production trace | 25–45 min | Founder-authorized release |

If the first bounded implementation exceeds two executor iterations or 90 minutes without a new proven fact, stop implementation and return to the architecture decision rather than starting another broad patch.

---

## 7. Graph Workflow

### 7.1 CodeGraph — default daily tool

Use CodeGraph before every backend or cross-layer patch to answer:

- who creates the target object;
- who consumes it;
- all callers/callees of the changed symbol;
- affected tests;
- whether another writer/path already exists;
- blast radius of the proposed change.

CodeGraph should use incremental project-local indexing. Do not rebuild the full graph for every small patch.

### 7.2 Graphify — architecture gate tool

Use Graphify when:

- identity ownership changes;
- schema or lifecycle changes;
- a new integration boundary is introduced;
- two implementations appear to overlap;
- a global architecture review is required.

Do not rerun Graphify for ordinary bounded fixes when the existing graph remains valid.

### 7.3 Graph evidence rule

Graph output is navigation evidence, not final proof.

Every load-bearing graph connection must be verified through exact source and, when relevant, a real-entry test or runtime evidence.

### 7.4 No global automation before local proof

Do not install global hooks or cross-project MCP automation until project-local graph usage has repeatedly produced correct, low-noise results.

---

## 8. Development Protocol

### Rule 1 — One business boundary per task

Every implementation task changes one measurable boundary only.

Example:

```text
Reservation identity creation
```

Not:

```text
Reservation + Queue + Ireland + callback cleanup
```

### Rule 2 — First proof before patch

Before editing, state:

- business result;
- first verifiable fact;
- real entry boundary;
- minimal allowed files;
- exact stop condition.

### Rule 3 — Real-entry TDD

Programming starts with a failing test that enters before the suspected defect through production-shaped data and the real loader/repository seam.

A unit test beginning from a manually built Queue row does not certify Reservation → Queue integration.

### Rule 4 — Identity must be carried, never rediscovered

Do not reconstruct event identity later from names, labels, approximate timestamps or fuzzy matching when a canonical ID was already available upstream.

### Rule 5 — Vertical acceptance

A patch is accepted only when it creates one new downstream fact.

Examples:

```text
new occurrence creates new Reservation
new Reservation creates current Queue
current Queue is visible to Ireland
Ireland attempt creates callback
callback creates terminal record
```

### Rule 6 — Two-iteration stop

After two failed executor iterations on the same boundary, or 30 minutes without a new proven fact:

- stop broad implementation;
- inspect the direct source/schema contract;
- return one architectural decision;
- do not start another generic repair prompt.

### Rule 7 — Generated artifact allowlist

Any command capable of generating reports, caches or indexes must declare exact expected paths before execution.

Expected generated files are not treated as unexpected dirty state. Unknown generated files stop the task before commit.

### Rule 8 — Runtime errors are not converted to zeros

Missing credentials, query failures and unavailable fields must be reported as `null` or explicit error codes, never as zero.

### Rule 9 — No production claim from local success

Tests, TypeScript and build prove local code quality only.

Production acceptance requires deployment mapping and a new runtime fact.

---

## 9. Model Routing

### Sol

Use only for:

- architecture decisions;
- conflicting source/schema/runtime evidence;
- cross-layer security or money-sensitive decisions;
- final synthesis.

Do not use Sol for routine prechecks, mechanical evidence collection, normal patch writing or repeated STOP recovery.

### Terra

Default writer for:

- bounded TDD implementation;
- small source patches;
- targeted test additions;
- local verification;
- documentation implementation after architecture is approved.

### Luna

Default independent reviewer and evidence checker for:

- diff review;
- source/schema contract verification;
- targeted test sufficiency;
- graph/path validation;
- release-gate evidence.

Writer and reviewer must be separate runs.

---

## 10. Code Auditor Agent

**Canonical name:** `Code Auditor`
**Role:** read-only independent acceptance agent
**Default model:** GPT-5.6 Luna
**Position:** after writer verification, before commit/deploy

### 10.1 Purpose

Code Auditor answers one simple question:

> Did this patch safely advance the real live contour by one boundary?

It does not write or repair code.

### 10.2 Inputs

- task contract;
- approved architecture section from LIVE CONTOUR 6;
- Git diff;
- CodeGraph affected-path output;
- failing and passing test evidence;
- TypeScript/build/diff-check results;
- expected production fact.

### 10.3 Mandatory checks

1. Only allowed files changed.
2. Patch changes the intended source owner, not a downstream symptom.
3. Test enters before the defect through the real boundary.
4. Identity fields remain continuous.
5. No parallel writer or alternate execution path was introduced.
6. Queue remains immutable.
7. Failure paths are explicit and fail closed.
8. No schema, env, security, auth, payment or Ireland scope was added without approval.
9. CodeGraph blast radius is accounted for.
10. The expected production proof is measurable.

### 10.4 Verdicts

Code Auditor returns exactly one:

- `PASS_READY_FOR_COMMIT`
- `FAIL_PATCH_DOES_NOT_FIX_REAL_BOUNDARY`
- `FAIL_TEST_STARTS_AFTER_DEFECT`
- `FAIL_IDENTITY_OR_LIFECYCLE_CONTRACT`
- `FAIL_UNEXPECTED_SCOPE`
- `NEED_ONE_NARROW_FACT`

It must return the first failed gate, exact source evidence, and one next action.

### 10.5 Forbidden behavior

Code Auditor must not:

- edit source;
- propose a broad rewrite;
- run production writes;
- repeat the entire architecture review;
- accept writer summaries without inspecting the diff;
- require full Graphify rebuild for a bounded patch;
- claim production success from local tests.

---

## 11. Required Evidence for Every Live-Contour Patch

```text
TASK
BUSINESS RESULT
FIRST VERIFIABLE FACT
REAL ENTRY BOUNDARY
ALLOWED FILES
FORBIDDEN FILES
EXPECTED FAILING TEST
FAILING TEST RESULT
FILES CHANGED
PASSING TEST RESULT
RELEVANT REGRESSIONS
CODEGRAPH AFFECTED PATHS
TSC RESULT
BUILD RESULT
GIT DIFF CHECK
CODE AUDITOR VERDICT
EXPECTED PRODUCTION FACT
```

Before commit/push:

```text
git branch --show-current
git status --short
git diff --stat
git diff --check
targeted tests
npx tsc --noEmit
npm run build
```

---

## 12. Production Acceptance Ladder

A patch advances the contour only when the next real fact is proven:

```text
L0 source row exists
L1 planning candidate admitted
L2 Reservation created for exact occurrence
L3 immutable Queue created for same occurrence
L4 Queue READY within active window
L5 Ireland receives/acknowledges queue_id
L6 order attempted or explicitly rejected
L7 callback persisted by queue_id
L8 terminal state persisted
L9 PnL/accounting evidence persisted
```

The live monitor must report the first missing level and must not hide query failures.

---

## 13. Founder Operating Model

Founder should receive no more than these checkpoints for one boundary:

1. one Terra implementation run;
2. one Luna Code Auditor result;
3. one commit/deploy approval;
4. one production evidence result.

The Founder must not be asked to execute repeated exploratory CMD chains when an executor can safely collect the evidence in one bounded run.

When the Founder is unavailable, executors may continue only through already-authorized local read-only/TDD gates. They must not commit, push, deploy, change schema, access secrets or trigger production writes without explicit approval.

---

## 14. Current Next Task

### Task

Correct Reservation identity ownership so a new physical occurrence cannot reuse the Reservation of a prior occurrence.

### Business result

Produce:

```text
T1 → R1 → immutable Q1
T2 → R2 → immutable Q2
```

### First verifiable fact

A production-shaped failing test must reproduce the current wrong behavior before implementation.

### CodeGraph question

Identify the exact source owner that creates, deduplicates or reuses `reservation_id`, plus every downstream consumer affected by changing occurrence identity.

### Minimal implementation boundary

Reservation producer/deduplication owner and its real-entry regression test only.

### Forbidden first-step changes

- Queue uniqueness migration;
- Queue in-place identity rewrite;
- Ireland;
- callback/order routes;
- UI;
- auth/payment/admin;
- unrelated scoring or admission thresholds.

### Expected production proof

One new occurrence produces a new Reservation and one matching Queue row with an active entry window.

---

## 15. Canonical Decision

```text
CONTINUE_WITH_LIVE_CONTOUR_6

one occurrence → one Reservation
one Reservation/rank → one immutable Queue instruction
identity is carried forward, never rediscovered
Terra writes
Luna Code Auditor reviews
CodeGraph is default navigation
Graphify is an architecture gate
production truth closes every boundary
```
