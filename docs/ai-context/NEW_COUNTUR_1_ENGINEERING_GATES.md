# NEW_COUNTUR_1 — Engineering Gates (R1)

<!-- TOKEN LOADING RULE: Tier 1. Load before any Contract A / Reservation / Rebalance patch. -->
<!-- STATUS: CANONICAL / FOUNDER LOCKED — R1. Base SHA 6e593a5d0e66e50941f130f7792f67e487dbb347. -->

Companion to [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md) (the lock) and
[`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md)
(the evidence).

**Revision:** R1 (2026-08-02), correcting R0 (`752fd87a`). Gates G1–G18 are carried forward with
R1 corrections; G19–G26 are new and close the defects R0 did not cover.

These gates are additive to `AGENTS.md §3` and `docs/ai-context/VERIFICATION_GATES.md`. They do not
replace them. **This task adds no executable tests** — every test named below is future TDD scope
for the implementation branch.

Phase vocabulary: **DESIGN** (before code) · **COMMIT** (per commit) · **REVIEW** (Fable / Gate 1) ·
**RELEASE** (before deploy).

Every gate below defines: purpose · PASS · FAIL · evidence · owner · phase · release consequence.

---

## 1. Gate definitions

### G1 — ONE MODEL AUTHORITY *(R1: renamed from ONE DECISION OWNER; scope corrected)*

- **Purpose:** exactly one layer — Contract A — owns every model decision class: sport policy,
  model eligibility, market policy, model price policy, score, rank, rejection reasons,
  event-level planning approval, final exact-market identity.
- **PASS:** each class maps to exactly one owning module, and that module is Contract A. Contract A
  may express its authority through **two lifecycle artifacts** (Planning Decision, Final Identity
  Decision) — that is one authority, not two owners.
- **FAIL:** two modules can emit the same decision class; or a non-Contract-A module emits one.
  Also FAIL if the two artifacts diverge into independently-configurable policies.
- **Evidence:** ownership table + repository-wide symbol search showing a single producer per class.
- **Owner:** Claude Code (evidence) / Fable (verdict). **Phase:** DESIGN, COMMIT, REVIEW.
- **Consequence:** FAIL blocks the release. This is the gate the incident violated.
- **R1 correction:** R0 read this gate as "one invocation". It is **one authority**. See
  `NEW_COUNTUR_1.md` §23.

### G2 — PLANNING DECISION CONTRACT *(R1: replaces the generic BOUNDARY CONTRACT FIRST)*

- **Purpose:** the pre-Reservation model→orchestration boundary is a typed, versioned object
  defined before any consumer.
- **PASS:** a `ContractAPlanningDecision` type declares `physical_event_id`, provider/source
  lineage, observation/signal lineage, normalized sport, league, `strategic_scope`, planning
  score/rank, planning policy verdict, event start, execution-window metadata, and a complete
  rejection trace — with an emitted version. Reservation's input type **is** that object. Where the
  final executable identity is not yet knowable, the artifact says so explicitly rather than
  inventing one.
- **FAIL:** Reservation consumes a shape a legacy producer can also emit; or the boundary is
  defined after its consumer; or a required field is absent or optional-by-default.
- **Evidence:** type declaration + Reservation's consumer signature.
- **Owner:** Claude Code. **Phase:** DESIGN, COMMIT A. **Consequence:** blocks Commit B.

### G3 — FINAL IDENTITY DECISION CONTRACT *(R1: new gate, replaces VERSIONED END-TO-END GRAPH)*

- **Purpose:** the near-execution artifact is typed, versioned, and **bounded by input**.
- **PASS:** a `ContractAFinalIdentityDecision` type declares exact `condition_id`, `token_id`,
  `side`, market identity, final price-policy verdict and identity rejection reasons; its producer
  accepts **only the reserved physical events** as input.
- **FAIL:** the producer accepts or fetches an unbounded universe and is bounded afterwards by
  post-filtering — the current shape at `lib/executor/eventExecutionQueue.ts:815`.
- **Evidence:** producer signature + caller trace showing reserved events as the sole input.
- **Owner:** Claude Code. **Phase:** DESIGN, COMMIT C. **Consequence:** blocks release.
- **R1 note:** the existing exact-match, unique-or-fail-closed resolution at `:607-640` is the
  correct *behavior* and is KEEP; only its unbounded input is the defect.

### G4 — NO PARALLEL PRODUCTION PATH

- **Purpose:** one production route from inventory to Queue.
- **PASS:** exactly one production caller chain reaches Reservation, and exactly one reaches Queue.
- **FAIL:** two production callers can create a Reservation or a Queue row. Explicitly in scope:
  `buildFounderBattleBatchQueueRow` (`eventExecutionQueue.ts:1792`, called `:1903`) as an alternate
  Queue writer.
- **Evidence:** caller trace for every Reservation writer and every Queue writer.
- **Owner:** Claude Code. **Phase:** COMMIT B, COMMIT C, REVIEW. **Consequence:** blocks release.

### G5 — SEMANTIC TIME CONTRACT *(R1: corrected)*

- **Purpose:** T−90 / T−120 / T−70…T−3 are input-selection and execution-window rules, never a
  reason to relocate model authority.
- **PASS:** each time constant is documented as belonging to exactly one lifecycle stage; the
  Planning stage reads the broad inventory and the Final Identity stage reads the near-execution
  universe; both remain under Contract A.
- **FAIL:** a time constant is used to justify a second modelling owner, or the same constant means
  different things in two modules.
- **Evidence:** time-constant table with owning stage + the source comment at
  `buildFireModelCandidates.ts:2023-2030` as the production precedent.
- **Owner:** Claude Code / Fable. **Phase:** DESIGN, REVIEW. **Consequence:** blocks release.
- **R1 correction:** R0 treated the two-stage timing as the defect. The two-stage *timing* is
  legitimate and forced by the data; the defect is two-stage **authority**.

### G6 — BROAD SPORT METADATA CONTINUITY *(R1: new gate)*

- **Purpose:** real upstream sport/league/scope metadata survives every hop.
- **PASS:** a production-shaped provider row's sport metadata is observable, unchanged in meaning,
  at each of: source row → observation → signal pair/snapshot → Planning Decision → Reservation →
  Final Identity Decision → Queue → observability. `MODEL_SCOPE_BY_PROVIDER_SPORT_CODE`
  (`buildFireModelCandidates.ts:652-667`, 14 provider-code aliases mapped to 8 distinct
  StrategicScope values in the current source map) and `resolveModelSport` (`:688+`) are the sole
  resolvers.
- **FAIL:** any hop hardcodes `inferred_sport: "unknown"` or `strategic_scope: "OTHER"` where real
  upstream metadata exists — the current Contract A adapter behavior at `:1228`/`:1230`. Also FAIL
  if a title-derived hint substitutes for a real provider field.
- **Evidence:** per-sport counts at each hop for one production-shaped night; the diff must be
  attributable to explicit, reasoned policy exclusions only.
- **Owner:** Claude Code. **Phase:** COMMIT A, COMMIT B, RELEASE. **Consequence:** blocks release.

### G7 — SOURCE LINEAGE CONTINUITY *(R1: new gate)*

- **Purpose:** provider/observation/decision lineage reaches the Queue intact or fails closed.
- **PASS:** every Queue row carries provider source event id, `physical_event_id`, observation/source
  row id, and signal-pair/decision id as **distinct** fields. A lineage value that cannot be
  resolved fails closed with an explicit reason code.
- **FAIL:** a lineage field is silently set to `null` — the current
  `resolveQueueSourceSignalId` behavior (`eventExecutionQueue.ts:161-165`) for non-UUID values.
- **Evidence:** Queue row field list + a test proving a non-UUID identifier produces a reason code,
  not a `null`.
- **Owner:** Claude Code. **Phase:** COMMIT A, COMMIT C. **Consequence:** blocks release.

### G8 — EVENT_START_ISO CONTINUITY *(R1: new gate)*

- **Purpose:** one physical occurrence has exactly one event-start timestamp, from one derivation.
- **PASS:** `event_start_iso` is provider-sourced and carried verbatim from Planning Decision through
  Reservation, Final Identity Decision and Queue. Any comparison uses the carried value, or a
  declared tolerance — never a re-derivation.
- **FAIL:** a second derivation exists — e.g. the arithmetic reconstruction
  `createdMs + minutesUntilStart * 60_000` at `buildFireModelCandidates.ts:1142-1144` — or two
  differently-sourced timestamps are compared at exact millisecond precision, as at
  `nightEventReservations.ts:1571-1574`.
- **Evidence:** single-derivation proof by symbol search + a test asserting byte-identical carriage
  end to end.
- **Owner:** Claude Code. **Phase:** COMMIT A, COMMIT B. **Consequence:** blocks release.

### G9 — EXACT IDENTITY

- **Purpose:** identity is matched exactly, never fuzzily; and identity fields are proved to be
  **persisted**, not merely declared.
- **PASS:** all identity resolution is unique-match-or-fail-closed; every identity field claimed as
  carried is present on the persisted row type **and** confirmed against the live schema.
- **FAIL:** any fuzzy or slug-derived rediscovery; or an identity field declared on a type but
  absent from the persisted table — the current `physical_event_id` / `event_start_iso` state on
  `EventExecutionQueueRow` (`executorQueueTypes.ts:34-35` declares them on the Reservation row only).
- **Evidence:** resolution code + schema confirmation.
- **Owner:** Claude Code. **Phase:** COMMIT C, REVIEW. **Consequence:** blocks release.

### G10 — RESERVATION BOUNDARY *(R1: new gate)*

- **Purpose:** Reservation is orchestration, never modelling.
- **PASS:** Reservation owns exactly — occurrence uniqueness, active duplicate protection, capacity
  cap 15, persistence, lifecycle, lineage carriage. It reads the Planning Decision and applies no
  policy of its own.
- **FAIL:** Reservation recalculates sport policy, eligibility or score; re-ranks; or selects a
  market universe.
- **Evidence:** Reservation module symbol inventory showing zero scoring/policy/ranking calls.
- **Owner:** Claude Code. **Phase:** COMMIT B, REVIEW. **Consequence:** blocks release.

### G11 — MECHANICAL GUARD REACHABILITY *(R1: new gate — the G14 lesson inverted)*

- **Purpose:** a guard that exists must be *reached*.
- **PASS:** every execution guard has at least one proved production caller on the live path.
- **FAIL:** a guard exists only as an uncalled definition — the current state of
  `selectBestCandidateForEventAtRebalance` (`nightPortfolioPlanner.ts:459`, zero callers).
- **Evidence:** caller trace per guard function, run against `lib/`, `app/`, `scripts/`.
- **Owner:** Claude Code. **Phase:** COMMIT C, REVIEW. **Consequence:** blocks release.

### G12 — CURRENT PRICE REFRESH *(R1: new gate)*

- **Purpose:** no order is placed at a price decided hours earlier.
- **PASS:** the mechanical guard stage fetches a current price inside the execution window and
  fails closed when it exceeds the finalized `max_entry_price` or is stale beyond a declared bound.
- **FAIL:** no current-price fetch on the production path — the state at `6e593a5d`, where
  `eventExecutionQueue.ts` has zero matches for `current_price` / `midpoint` / `refreshPrice`.
- **Evidence:** the fetch call site, its caller trace, and its fail-closed reason code.
- **Owner:** Claude Code. **Phase:** COMMIT C, RELEASE. **Consequence:** blocks release.

### G13 — LIQUIDITY REFRESH *(R1: new gate)*

- **Purpose:** no order is placed into a book that cannot fill it.
- **PASS:** the mechanical guard stage fetches current liquidity/book depth and fails closed below
  a declared threshold for the finalized stake.
- **FAIL:** no liquidity check on the production path — the state at `6e593a5d` (zero matches for
  `liquidity` / `orderbook` / `book` in `eventExecutionQueue.ts`).
- **Evidence:** the fetch call site, its caller trace, and its fail-closed reason code.
- **Owner:** Claude Code. **Phase:** COMMIT C, RELEASE. **Consequence:** blocks release.

### G14 — QUEUE-ONLY EXECUTION AUTHORITY *(R1: new gate)*

- **Purpose:** exactly one production execution instruction exists.
- **PASS:** `/api/executor/queue` is the sole production execution-instruction source; the Queue row
  is immutable after creation.
- **FAIL:** any other surface returns executable identity to a production consumer.
- **Evidence:** enumeration of every route returning `condition_id` + `token_id` + `side` + stake,
  with each classified production / diagnostic / test-only.
- **Owner:** Claude Code / Founder. **Phase:** COMMIT C, RELEASE. **Consequence:** blocks release.

### G15 — CANDIDATES ROUTE PRODUCTION CUTOFF *(R1: new gate)*

- **Purpose:** retire `/api/executor/candidates` as an execution authority.
- **PASS:** the route is diagnostics/preview only or removed; it cannot be consumed as production
  execution input; and `IRELAND_RUNTIME_CONTRACT.candidate_endpoint`
  (`nightPortfolioPlanner.ts:157`) no longer advertises it as an execution source.
- **FAIL:** the route still returns executable identity with no Reservation and no Queue row behind
  a production secret — its state at `6e593a5d` (`candidates/route.ts:204`, `:260`, `:308-318`).
- **Evidence:** route diff + runtime-contract diff + the G26 operator proof.
- **Owner:** Claude Code / Founder. **Phase:** COMMIT C, RELEASE. **Consequence:** blocks release.

### G16 — CALLBACK BY IDEMPOTENCY_KEY *(R1: new gate)*

- **Purpose:** callback correlation uses the key that actually exists.
- **PASS:** callback lookup is by `idempotency_key`
  (`app/api/executor/order-events/route.ts:150-166`).
- **FAIL:** any documentation or code requiring an `executor_order_events.queue_id` column — proved
  absent at `:200-205`.
- **Evidence:** lookup call site + live schema confirmation.
- **Owner:** Claude Code. **Phase:** COMMIT C, REVIEW. **Consequence:** blocks release.

### G17 — EXACT IDENTITY CALLBACK VALIDATION *(R1: new gate)*

- **Purpose:** a matched callback must also be the *right* callback.
- **PASS:** after `idempotency_key` lookup, the callback cross-checks the exact immutable identity
  (`condition_id`, `token_id`, `side`) against the Queue row before any terminal state or PnL write.
- **FAIL:** terminal state written on key match alone.
- **Evidence:** cross-check call site + a test asserting a mismatched identity is rejected.
- **Owner:** Claude Code. **Phase:** COMMIT C. **Consequence:** blocks release.

### G18 — CLOB_ORDER_ID RECEIPT *(R1: new gate)*

- **Purpose:** the external venue order identifier is named correctly and persisted.
- **PASS:** `clob_order_id` is persisted as the external order receipt
  (`order-events/route.ts:73`, `:137`, `:167-175`).
- **FAIL:** any use of `venue_order_id` as a target runtime field — it does not exist in tracked
  source and must appear only as corrected historical wording.
- **Evidence:** field write site + a repository-wide search returning zero `venue_order_id` matches.
- **Owner:** Claude Code. **Phase:** COMMIT C, REVIEW. **Consequence:** blocks release.

### G19 — ZERO PRODUCTION CALLERS *(R1: corrected from LEGACY CUTOFF)*

- **Purpose:** retired model paths hold no production authority.
- **PASS:** every path in `NEW_COUNTUR_1.md` §15 has **zero production callers**. Diagnostic,
  script and test callers are permitted and do not fail this gate.
- **FAIL:** a retired path retains a production caller; or the gate is misapplied to demand zero
  callers from `DIAGNOSTIC_ONLY` / `TEST_ONLY` paths.
- **Evidence:** per-symbol caller trace with each caller classified production / diagnostic /
  test-only.
- **Owner:** Claude Code. **Phase:** COMMIT C, RELEASE. **Consequence:** blocks release.
- **R1 correction:** R0 implied blanket zero-caller deletion. Only **production authority** must
  reach zero; physical deletion is a separate post-parity step.

### G20 — TDD AT THE CORRECT ENTRY *(R1: corrected)*

- **Purpose:** tests start at or above the broken producer boundary.
- **PASS:** each test's entry point is the real production producer, with production-shaped input.
- **FAIL:** a test injects rows below the boundary the defect lives at — the current
  `tests/contur3/**` pattern, which injects directly into `buildFireModelCandidates`; or a test
  asserts that a selector-mode string was *passed* rather than that it *reached* its branch (cf.
  `tests/contur3/nightEventReservations.scheduler.test.ts:376-377`).
- **Evidence:** test entry-point table naming the producer under test.
- **Owner:** Claude Code. **Phase:** COMMIT A, B, C. **Consequence:** blocks the commit.

### G21 — DIRECT SOURCE REVIEW *(R1: strengthened)*

- **Purpose:** documentation claims are verifiable.
- **PASS:** every load-bearing claim cites a tracked path + symbol/line area at a named SHA, or
  carries an explicit `NOT_VERIFIABLE` / `RUNTIME_ONLY` tag.
- **FAIL:** a claim rests on chat history, summary, or a prior document; or a target is stated as
  current behavior.
- **Evidence:** the evidence ledger in the postmortem §17.
- **Owner:** Claude Code / Fable. **Phase:** DESIGN, REVIEW. **Consequence:** blocks review PASS.

### G22 — GRAPH TOOLS ARE ADVISORY *(R1: new gate)*

- **Purpose:** prevent tool output from becoming a source of truth.
- **PASS:** any finding originating from a graph/visualization tool is re-derived from tracked
  source before it enters documentation.
- **FAIL:** a documented claim traceable only to a tool artifact.
- **Evidence:** the re-derivation command and its result.
- **Owner:** Claude Code. **Phase:** DESIGN, REVIEW. **Consequence:** blocks review PASS.

### G23 — MODEL OUTPUT IMMUTABILITY

- **Purpose:** a decided identity cannot change downstream.
- **PASS:** after the Final Identity Decision, `physical_event_id`, `condition_id`, `token_id` and
  `side` are immutable through Queue, execution and callback.
- **FAIL:** any downstream write mutates one of them.
- **Evidence:** write-site inventory for each field.
- **Owner:** Claude Code. **Phase:** COMMIT C, REVIEW. **Consequence:** blocks release.

### G24 — OBSERVABILITY OWNED BY THE LAYER

- **Purpose:** each layer reports its own funnel, by sport, market and reason.
- **PASS:** counts are emitted per sport, per market family and per rejection reason at every stage
  named in G6, and counters from different authorities are never chained.
- **FAIL:** a stage reports only totals; or two universes' counters are presented as consecutive —
  the condition `nightFunnelAudit.ts:288` already refuses.
- **Evidence:** one production-shaped funnel report.
- **Owner:** Claude Code. **Phase:** COMMIT B, C, RELEASE. **Consequence:** blocks release.

### G25 — COHERENT DEPLOY

- **Purpose:** no dual-authority state ever reaches production.
- **PASS:** Commits A, B and C ship as one release, after one coherent review.
- **FAIL:** any intermediate commit deployed alone; or `CONTRACT_A_V1` enabled in production before
  G6 and G8 pass.
- **Evidence:** the release branch contents + review verdict.
- **Owner:** Founder. **Phase:** RELEASE. **Consequence:** blocks deploy.

### G26 — RUNTIME IRELAND POLLING PROOF *(R1: new gate)*

- **Purpose:** close the one boundary the repository cannot prove.
- **PASS:** the operator supplies the live Ireland poller configuration and its polling URL, and it
  resolves to `/api/executor/queue`.
- **FAIL:** deploy attempted without that proof; or the proof shows a poller still reading
  `/api/executor/candidates`.
- **Evidence:** operator-supplied poller configuration.
- **Owner:** Founder. **Phase:** RELEASE. **Consequence:** blocks deploy. **RUNTIME-ONLY.**

### G27 — MERMAID DEFERRED UNTIL PRODUCTION PROOF *(R1: new gate)*

- **Purpose:** no diagram may encode a lifecycle that production has not yet reached.
- **PASS:** no active R1 document contains or links a lifecycle diagram. Visualization resumes only
  after runtime implementation, a coherent deploy, production identity proof and broad-sports proof.
- **FAIL:** a diagram is added before those four conditions hold.
- **Evidence:** `NEW_COUNTUR_1.mmd` is deleted from the active package (it encoded the superseded
  one-invocation lifecycle) and remains in Git history at `752fd87a`.
- **Owner:** Founder. **Phase:** DESIGN, RELEASE. **Consequence:** blocks review PASS.

---

## 2. DEV RULE 2 — correct boundary

Write the test at the boundary where the defect lives, not below it. If a defect can only be
reproduced by the real producer, the test must call the real producer. Injecting a hand-built row
into a downstream function proves the downstream function works — which was never in doubt.

## 3. DEV RULE 3 — live value first

A guard that is not reached is not a guard. Before writing a new check, prove the call site exists
and is on the production path. Before trusting an existing check, run its caller trace.

---

## 4. Future TDD test matrix — implementation branch only

**No executable tests are added by this task.** Each row is future scope.

| # | Test | Gate | Commit |
|---|---|---|---|
| 1 | Production-shaped provider row → normalized sport metadata | G6 | A |
| 2 | Planning Decision preserves `physical_event_id` | G2, G7 | A |
| 3 | Planning Decision preserves broad sport / league / scope | G6 | A |
| 4 | Reservation consumes the real Planning Decision producer | G2, G10, G20 | B |
| 5 | Tests start before the broken producer boundary | G20 | A |
| 6 | Final Identity Decision is limited to reserved physical events | G3 | C |
| 7 | Final Identity Decision cannot select an unapproved event | G3, G23 | C |
| 8 | `condition_id` / `token_id` / `side` immutable after finalization | G23 | C |
| 9 | `event_start_iso` exact continuity end to end | G8 | B |
| 10 | Source lineage does not silently null non-UUID identifiers | G7 | A |
| 11 | Mechanical guards refresh current price | G12 | C |
| 12 | Mechanical guards refresh liquidity | G13 | C |
| 13 | Rebalance cannot load a new model universe | G3, G4 | C |
| 14 | `/api/executor/candidates` cannot be consumed as production execution input | G15 | C |
| 15 | Queue is the only production execution instruction | G14 | C |
| 16 | Callback lookup uses `idempotency_key` | G16 | C |
| 17 | Callback validates exact identity | G17 | C |
| 18 | `clob_order_id` persisted as external receipt | G18 | C |
| 19 | Retired model paths have zero production callers | G19 | C |
| 20 | Broad-sports observability reported by sport / market / reason | G6, G24 | B, C |
| 21 | Fixed-time lifecycle test covers planning and execution windows | G5 | B, C |
| 22 | One physical occurrence creates one Reservation lineage | G9, G10 | B |
| 23 | A new occurrence cannot reuse an old Reservation or Queue | G9, G23 | B, C |

---

## 5. Review gates

### 5.1 Gate 1 — technical review (Claude Code)
Per `VERIFICATION_GATES.md` Gate 1. For docs-only work, **Gate D** applies and
`npx tsc --noEmit` / `npm run build` are reported `N/A — docs-only correction`.

### 5.2 Fable architecture review gate
Entry criteria in `NEW_COUNTUR_1.md` §21. Verdicts:
`PASS_NEW_COUNTUR_1_R1_READY_FOR_IMPLEMENTATION` or
`FAIL_NEW_COUNTUR_1_R1_WITH_EXACT_CONTRADICTION`.

### 5.3 Coherent release gate
G25 + G26. One branch, one review, one deploy.

### 5.4 Founder final business / runtime gate
The `NEW_COUNTUR_1.md` §18 operator proofs, supplied before deploy.

---

## 6. Gate applicability matrix

| Phase | Gates |
|---|---|
| DESIGN | G1, G2, G3, G5, G21, G22, G27 |
| COMMIT A | G1, G2, G6, G7, G8, G20 |
| COMMIT B | G1, G4, G6, G8, G10, G20, G24 |
| COMMIT C | G1, G3, G4, G9, G11–G19, G20, G23, G24 |
| REVIEW | G1, G3, G4, G5, G9, G11, G16, G18, G19, G21, G22, G23, G27 |
| RELEASE | G6, G12, G13, G14, G15, G19, G24, G25, G26 |

---

**Related:** [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md) ·
[`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md) ·
[`09_CONTEXT_DELTA_LOG.md`](./09_CONTEXT_DELTA_LOG.md)
