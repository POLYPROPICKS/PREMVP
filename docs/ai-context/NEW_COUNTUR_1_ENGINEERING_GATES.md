# NEW_COUNTUR_1 — Engineering Gates

<!-- TOKEN LOADING RULE: Tier 1. Load before any Contract A / Reservation / Rebalance patch. -->
<!-- STATUS: CANONICAL / FOUNDER LOCKED. Base SHA 6e593a5d0e66e50941f130f7792f67e487dbb347. -->

Companion to [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md) (the lock) and
[`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md)
(the evidence). Graph: [`NEW_COUNTUR_1.mmd`](./NEW_COUNTUR_1.mmd).

These gates are additive to `AGENTS.md §3` and `docs/ai-context/VERIFICATION_GATES.md`. They do
not replace them. **This task adds no executable tests** — every test named below is future TDD
scope for the implementation branch.

Phase vocabulary: **DESIGN** (before code) · **COMMIT** (per commit) · **REVIEW** (Fable /
Gate 1) · **RELEASE** (before deploy).

---

## 1. Gate definitions

### G1 — ONE DECISION OWNER

- **Purpose:** exactly one named layer may produce each decision class (policy, score,
  eligibility, market policy, price policy, ranking, approved-set formation, rejection reasons).
- **PASS:** every decision class in the contour maps to exactly one owning module, and that
  module is Contract A for all model classes.
- **FAIL:** two modules can emit the same decision class; or a module emits a decision class it
  does not own.
- **Evidence:** ownership table + repository-wide symbol search showing a single producer.
- **Owner:** Claude Code (evidence) / Fable (verdict).
- **Phase:** DESIGN, COMMIT, REVIEW.
- **Consequence:** FAIL blocks the release. No exceptions — this is the gate the incident violated.

### G2 — BOUNDARY CONTRACT FIRST

- **Purpose:** the model → orchestration boundary is a typed, versioned object defined before
  any consumer is written.
- **PASS:** approved candidate set, rejection trace, lineage, and execution-window metadata are
  declared as distinct types with an emitted version; Reservation's input type is that object.
- **FAIL:** orchestration consumes the same shape a legacy producer can emit; or the boundary is
  defined after the consumer.
- **Evidence:** type declarations + the consumer signature.
- **Owner:** Claude Code. **Phase:** DESIGN, COMMIT A. **Consequence:** blocks Commit B.

### G3 — VERSIONED END-TO-END GRAPH

- **Purpose:** one committed graph of the whole path, kept current.
- **PASS:** `NEW_COUNTUR_1.mmd` is tracked, matches current source, and every retired authority
  is marked retired with no arrow into the production path.
- **FAIL:** graph absent, stale, or shows an opaque combined box hiding model vs orchestration.
- **Evidence:** the tracked `.mmd` + a diff review against the caller graph.
- **Owner:** Claude Code. **Phase:** DESIGN, REVIEW, RELEASE. **Consequence:** blocks review entry.

### G4 — NO PARALLEL PRODUCTION PATH

- **Purpose:** exactly one production path from snapshots to order.
- **PASS:** repository-wide search finds one production caller chain; every other producer is
  test-only, script-only, or a pure adapter with zero policy/score/rank/selection ownership.
- **FAIL:** any second production-reachable modelling path exists (the state at `6e593a5d`).
- **Evidence:** caller search output per retired symbol, with each caller classified
  production / ops-script / test.
- **Owner:** Claude Code. **Phase:** COMMIT C, REVIEW, RELEASE. **Consequence:** blocks deploy.

### G5 — SEMANTIC TIME CONTRACT

- **Purpose:** every time value has one declared meaning and one owner.
- **PASS:** dataset / snapshot / model-decision / reservation / execution-window / order times are
  documented and distinct; T−90 and T−120 are Contract A internals; T−70…T−3 is the execution
  window; no time value is used to justify relocating a decision owner.
- **FAIL:** a time value silently changes meaning across layers, or a timing argument is used to
  move model authority.
- **Evidence:** [`NEW_COUNTUR_1.md` §6](./NEW_COUNTUR_1.md) table cross-checked against constants.
- **Owner:** Claude Code / Fable. **Phase:** DESIGN, REVIEW. **Consequence:** FAIL blocks Commit A.

### G6 — TDD AT THE CORRECT ENTRY

- **Purpose:** tests start **before** the suspected boundary, over the real path.
- **PASS:** each test enters at the loader/normalization stage and runs through the real
  producer; fixtures are production-shaped source rows; time is fixed.
- **FAIL:** a test manually constructs the object whose producer is under suspicion.
- **Evidence:** test entry points + fixture provenance.
- **Owner:** Claude Code. **Phase:** COMMIT A/B/C. **Consequence:** blocks the commit.

### G7 — FUNCTION ISOLATION

- **Purpose:** the decision core is pure; I/O lives at the edges.
- **PASS:** Contract A's decision functions perform no DB, network, clock, or random access;
  fetch and persist are separate, injectable seams.
- **FAIL:** a decision function imports a Supabase client or reads `Date.now()` internally.
- **Evidence:** import graph of the decision core (the pattern `nightFunnelAudit.ts` already follows).
- **Owner:** Claude Code. **Phase:** COMMIT A. **Consequence:** blocks Commit A.

### G8 — NO RUNTIME AI-GENERATED LOGIC

- **Purpose:** no model/LLM call decides anything at runtime.
- **PASS:** the contour contains zero runtime AI invocations; all logic is deterministic code.
- **FAIL:** any runtime AI call in ingestion, modelling, orchestration, or execution.
- **Evidence:** dependency and call-site search.
- **Owner:** Claude Code / Founder. **Phase:** COMMIT, RELEASE. **Consequence:** blocks deploy.

### G9 — EXACT IDENTITY

- **Purpose:** one immutable identity travels the chain; strings never select.
- **PASS:** `condition_id` / `token_id` / `side` + canonical physical-occurrence key are decided
  once, persisted, validated, and copied verbatim; absent identity → rejected, never defaulted.
- **FAIL:** any slug / title / lineage rediscovery, synthetic ID, or substitution.
- **Evidence:** the invariants in `lib/executor/executableMarketIdentity.ts` plus continuity tests.
- **Owner:** Claude Code. **Phase:** COMMIT B/C, RELEASE. **Consequence:** blocks deploy.

### G10 — OBSERVABILITY OWNED BY THE LAYER

- **Purpose:** the layer that owns a decision emits its reason codes.
- **PASS:** all model-class rejection reasons originate in Contract A; orchestration emits only
  mechanical reasons (window, price, liquidity, stake, duplicate, capacity); every reason code
  has a locatable producer in tracked source.
- **FAIL:** a model-class reason emitted outside Contract A, or a reason with no source owner
  (current example: `MARKET_POLICY_ACTIVITY_LABEL`).
- **Evidence:** reason-code inventory mapped to owning module.
- **Owner:** Claude Code. **Phase:** COMMIT A/C, REVIEW. **Consequence:** blocks review sign-off.

### G11 — COUNTER RECONCILIATION

- **Purpose:** no cross-universe arithmetic.
- **PASS:** `input === dropped + output` at every chained stage; chaining only where same-universe
  continuity is proved (same row base, same identity granularity, single producer invocation);
  contradictions throw.
- **FAIL:** counters from different universes summed, subtracted, or presented as one funnel;
  any `Math.max` flooring of a contradiction.
- **Evidence:** funnel output + the continuity assertion.
- **Owner:** Claude Code. **Phase:** COMMIT, REVIEW. **Consequence:** FAIL invalidates the evidence.

### G12 — DIRECT SOURCE REVIEW

- **Purpose:** claims are proved from source and git, not from summaries or executor narratives.
- **PASS:** every load-bearing claim carries `path:line` or a commit SHA.
- **FAIL:** a claim rests on chat history, a prior report, or memory.
- **Evidence:** the evidence ledger.
- **Owner:** Claude Code / Fable. **Phase:** all. **Consequence:** unsourced claims are struck.

### G13 — ROADMAP DELTA REVIEW

- **Purpose:** a design document that production evidence contradicts must be superseded, not
  silently followed.
- **PASS:** each cycle returns the current production verdict and the next measurable transition,
  and any contradicted document is explicitly superseded.
- **FAIL:** work proceeds against a document the evidence has falsified (Roadmap 2, 2026-07→08).
- **Evidence:** the supersession statement + delta-log entry.
- **Owner:** Founder / Claude Chat. **Phase:** REVIEW. **Consequence:** blocks the next task.

### G14 — LEGACY CUTOFF

- **Purpose:** retirement is proved, not declared.
- **PASS:** zero production callers of every retired selector/ranker path; survivors are
  test-only, script-only, or pure adapters; physical deletion is a **separate** cleanup commit
  after production parity.
- **FAIL:** a retired symbol still has a production caller, or deletion is bundled into the cutover.
- **Evidence:** repository-wide caller search with each caller classified.
- **Owner:** Claude Code. **Phase:** COMMIT C, RELEASE. **Consequence:** blocks deploy.

### G15 — COHERENT CUTOVER RELEASE

- **Purpose:** never deploy a dual-authority intermediate state.
- **PASS:** Commits A, B, C reach `main` as one release, after one review and one approval.
- **FAIL:** any intermediate commit merged or deployed alone; `railway up` used.
- **Evidence:** branch history + deploy record.
- **Owner:** Founder. **Phase:** RELEASE. **Consequence:** absolute — FAIL stops the release.

### G16 — CALLER OWNERSHIP TEST

- **Purpose:** ownership is asserted by an executable test, not by a name.
- **PASS:** a test proves Reservation input originated from a Contract A accepted decision, and a
  test proves rebalance invokes zero model producers.
- **FAIL:** ownership is implied only by a `selector_id` string (the state at `6e593a5d`).
- **Evidence:** the two tests plus an invocation counter.
- **Owner:** Claude Code. **Phase:** COMMIT B/C. **Consequence:** blocks the commit.

### G17 — MODEL OUTPUT IMMUTABILITY

- **Purpose:** the approved set is frozen at emit.
- **PASS:** no downstream layer re-scores, re-ranks, adds, or substitutes a member; persisted
  score/rank are read-only data.
- **FAIL:** any downstream sort, filter-by-score, or sibling substitution.
- **Evidence:** immutability tests + absence of ranking imports in orchestration modules.
- **Owner:** Claude Code. **Phase:** COMMIT B/C. **Consequence:** blocks deploy.

### G18 — FAILURE TREE BEFORE PATCH

- **Purpose:** no patch before 3-5 competing causes are stated and discriminated.
- **PASS:** a failure tree exists covering upstream producer/filter, identity, serializer/
  persistence, consumer, and external execution boundary; the chosen cause is discriminated by
  evidence, not assumed.
- **FAIL:** a patch aimed at one convenient hypothesis (e.g. a single rejection reason).
- **Evidence:** the tree + the discriminating trace.
- **Owner:** Claude Code. **Phase:** before every patch. **Consequence:** blocks the patch.

---

## 2. DEV RULE 2 — correct boundary

1. Map the complete real end-to-end path from source row to business result before writing a test.
2. Define a failure tree with at least 3-5 competing causes: upstream producer/filter · identity ·
   serializer/persistence · consumer · external execution boundary.
3. Tests must begin **before** the suspected boundary.
4. Never manually inject an object whose producer may contain the defect.
5. Implementation tests must drive production-shaped rows through the real path:
   `loader → normalization → Contract A → approved-set producer → Reservation → Rebalance → Queue → serializer → Ireland consumer`.
6. Use fixed time.
7. Every stage must emit a structured trace: input count · output count · first rejection reason ·
   target row present/absent.
8. Tests must prove **ownership and caller cutoff**, not only one convenient hypothesis.

This task is docs-only: **no tests and no fixtures are created here.**

---

## 3. DEV RULE 3 — live value first

- The first broken edge is `Contract A output → Reservation` ownership.
- The cutover must directly shorten the path to a real terminal business outcome.
- Legacy reason-by-reason fixes are **superseded**.
- No new taxonomy, cleanup, alternate architecture, or parallel producer is allowed unless it is
  a prerequisite for the coherent cutover.
- **No second implementation.**
- Secondary optimization is deferred until the production path is restored.
- Every later task must return the current production verdict and the next measurable transition.
- This documentation package is permitted because it is the prerequisite for a coherent,
  non-dual-authority release.

---

## 4. Future TDD test matrix — implementation branch only

| # | Test class | Entry point | Proves | Commit | Gate |
|---|---|---|---|---|---|
| T1 | Caller ownership regression | reservation cron seam | Reservation input originated from a Contract A accepted decision | B | G16 |
| T2 | Caller ownership regression | rebalance seam | rebalance performs **zero** model-producer invocations (counter = 0) | C | G16, G4 |
| T3 | Approved-set immutability | approved set → Reservation → Rebalance → Queue | no member added, removed, re-scored, or re-ranked downstream | B, C | G17 |
| T4 | Approved-set immutability | rebalance with a higher-scoring unapproved sibling present | the sibling is never selected | C | G17, G9 |
| T5 | Same-universe counter reconciliation | funnel assembly | `input === dropped + output` per chained stage; cross-universe chaining throws | A, C | G11 |
| T6 | Same-universe counter reconciliation | two-funnel audit | legacy and Contract A counters are reported separately, never merged | C | G11 |
| T7 | Exact identity continuity | source row → queue row | `condition_id`/`token_id`/`side` byte-identical end to end | B, C | G9 |
| T8 | Exact identity continuity | missing/ambiguous identity | fails closed: no Reservation, no queue row, exact reason code | B, C | G9 |
| T9 | Mechanical-only rebalance | due reservation, refreshed price/liquidity | only window/price/liquidity/stake guards can drop it; no re-score | C | G1, G17 |
| T10 | Mechanical-only rebalance | rebalance module import graph | no ranking or model-producer import present | C | G4, G14 |
| T11 | Legacy cutoff | repository-wide caller search | zero production callers of retired selector/ranker paths | C | G14 |
| T12 | Time semantics | fixed-clock plan | T−90/T−120 affect only Contract A input selection; T−70…T−3 affects only execution | A, C | G5 |
| T13 | Rejection-trace completeness | Contract A over a production-shaped corpus | every input row is approved or rejected with an exact reason; no residue | A | G10 |
| T14 | Function isolation | Contract A decision core | no DB/network/clock/random access | A | G7 |
| T15 | Capacity + duplicate protection | Reservation over an oversized approved set | cap 15 respected; duplicates rejected; slots not consumed by rejected rows | B | G9 |

**Zero-production-callers legacy cutoff proof (T11) must classify every caller** of
`buildFireModelCandidates`, `compareCandidateQuality`, and `nightPortfolioPlanner` as
production / ops-script / test — including a disposition verdict for
`app/api/executor/night-plan/route.ts`, currently `NEEDS_IMPLEMENTATION_REVIEW`.

---

## 5. Failure tree template

```
SYMPTOM: [exact observable, with counts and as-of instant]

CAUSE 1 — upstream producer/filter
  Hypothesis:
  Discriminating evidence:      [stage input/output counts at the producer]
  Would also explain symptom?   [yes/no]

CAUSE 2 — identity
  Hypothesis:
  Discriminating evidence:      [identity present/absent for the target row]

CAUSE 3 — serializer / persistence
  Hypothesis:
  Discriminating evidence:      [row written vs row read back]

CAUSE 4 — consumer
  Hypothesis:
  Discriminating evidence:      [consumer input count vs producer output count]

CAUSE 5 — external execution boundary
  Hypothesis:
  Discriminating evidence:      [queue row vs Ireland response vs callback]

TARGET ROW: [exact identity followed through every stage: present / absent / reason]
SELECTED CAUSE: [with the evidence that excluded the others]
TEST ENTRY POINT: [must be BEFORE the selected boundary]
```

No patch may be written before this template is filled with real values.

---

## 6. Review gates

### 6.1 Gate 1 — technical review (Claude Code)

PASS requires all of:

- only allowed files changed;
- `git status --short` shows nothing unexpected;
- `git diff --check` clean;
- `npx tsc --noEmit` passes;
- `npm run build` passes;
- old/new snippets supplied for every code change;
- no secrets or raw env values;
- evidence ledger rows for every load-bearing claim (G12).

Any FAIL is a total FAIL, never partial success (`CLAUDE.md §5`, `AGENTS.md §3.4`).

### 6.2 Fable architecture review gate

Entry criteria: the `NEW_COUNTUR_1` package is committed and pushed; Gate 1 PASS; no runtime
change in the reviewed commit.

Fable must review: divergence timeline · one model owner · T−90/T−120 execution semantics ·
direct `Contract A → Reservation` · mechanical-only rebalance · exact identity continuity ·
broad sport/market preservation · function disposition · old-caller cutoff · TDD plan ·
rollback · one coherent deploy.

Allowed verdicts:

- `PASS_NEW_COUNTUR_1_READY_FOR_IMPLEMENTATION`
- `FAIL_NEW_COUNTUR_1_WITH_EXACT_CONTRADICTION`

Fable is **not** run in this task. No runtime implementation before `PASS`.

### 6.3 Coherent release gate

PASS requires: G1, G4, G9, G14, G15, G16, G17 all PASS; the three commits present as one branch;
zero production callers of retired paths; before/after funnel evidence from the released
instrumentation; no intermediate deploy performed; `railway up` not used.

### 6.4 Founder final business / runtime gate

Founder alone approves the merge to `main` and therefore the Railway auto-deploy. Founder
confirms: bounded live exposure, capacity policy, and the terminal-outcome measurement that
defines success for the cutover. Commit and push are **not** production effect; only merge +
deploy + runtime proof are.

---

## 7. Gate applicability matrix

| Gate | DESIGN | COMMIT A | COMMIT B | COMMIT C | REVIEW | RELEASE |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| G1 ONE DECISION OWNER | ● | ● | ● | ● | ● | ● |
| G2 BOUNDARY CONTRACT FIRST | ● | ● | ● | | ● | |
| G3 VERSIONED END-TO-END GRAPH | ● | | | | ● | ● |
| G4 NO PARALLEL PRODUCTION PATH | ● | | | ● | ● | ● |
| G5 SEMANTIC TIME CONTRACT | ● | ● | | ● | ● | |
| G6 TDD AT CORRECT ENTRY | | ● | ● | ● | ● | |
| G7 FUNCTION ISOLATION | | ● | | | ● | |
| G8 NO RUNTIME AI LOGIC | ● | ● | ● | ● | ● | ● |
| G9 EXACT IDENTITY | ● | | ● | ● | ● | ● |
| G10 OBSERVABILITY OWNED BY LAYER | | ● | | ● | ● | |
| G11 COUNTER RECONCILIATION | | ● | | ● | ● | |
| G12 DIRECT SOURCE REVIEW | ● | ● | ● | ● | ● | ● |
| G13 ROADMAP DELTA REVIEW | ● | | | | ● | |
| G14 LEGACY CUTOFF | | | | ● | ● | ● |
| G15 COHERENT CUTOVER RELEASE | | | | | ● | ● |
| G16 CALLER OWNERSHIP TEST | | | ● | ● | ● | |
| G17 MODEL OUTPUT IMMUTABILITY | | | ● | ● | ● | ● |
| G18 FAILURE TREE BEFORE PATCH | ● | ● | ● | ● | | |
