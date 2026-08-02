# NEW_COUNTUR_1 — Canonical Single-Model-Authority Execution Contour

<!-- TOKEN LOADING RULE: Tier 1. Load before any Contract A / Reservation / Rebalance task. -->
<!-- OWNER: Founder (architecture lock) / Claude Code (evidence) -->

## 1. Document status

| Field | Value |
|---|---|
| Status | `CANONICAL / FOUNDER LOCKED` |
| Date | 2026-08-02 |
| Base production SHA | `6e593a5d0e66e50941f130f7792f67e487dbb347` (`origin/main`, `Audit: use deduped planning admission universe`, 2026-08-02T08:35:51Z) |
| Package version | `NEW_COUNTUR_1` v1 |
| Package members | `NEW_COUNTUR_1.md` (this file), [`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md), [`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md), [`NEW_COUNTUR_1.mmd`](./NEW_COUNTUR_1.mmd) |
| Change class | documentation only — zero runtime, test, schema, config, or dependency change |
| Name lock | The canonical spelling is `NEW_COUNTUR_1`. It is not `NEW_CONTOUR_1` and must not be "corrected". |

Every statement below is tagged:

- **CURRENT SOURCE FACT** — proved from repo source or git output at the base SHA.
- **HISTORICAL INTENT** — what an earlier accepted document or commit intended.
- **TARGET LOCK** — the Founder-locked target architecture. It may intentionally differ
  from current source. That difference is the migration gap, not a licence to restate
  the target as if it were already true.

---

## 2. Executive verdict

**Current production verdict — CURRENT SOURCE FACT.**
The production path at `6e593a5d` carries **two modelling authorities**.

1. The 17:00 Minsk reservation cron calls `buildReservationPlan(nowMs, { selectorMode: "CONTRACT_A_PLANNING_V1" })`
   (`app/api/cron/night-event-reservations/route.ts:76`, `:106`, `:194`).
2. `CONTRACT_A_PLANNING_V1` does **not** invoke Contract A. In
   `lib/executor/buildFireModelCandidates.ts` only `selectorMode === "CONTRACT_A_V1"` routes to
   `buildContractAV1Candidates` (line 1296). `CONTRACT_A_PLANNING_V1` falls through to the legacy
   CONTUR3 scored/shadow pipeline and, at line 2023, merely **stamps**
   `diagnostics.selector_id = "CONTRACT_A_PLANNING_V1"` and `contract_a_stage = "PLANNING"` onto
   candidates that legacy filters already selected, scored, and ranked.
3. Contract A proper — `produceFrozenModelV2ShadowDecisions` in
   `lib/modeling/frozenModelProducerV2Shadow.ts` — is reached in production **only later**, inside
   rebalance, via `fetchContractAFinalCandidates` →
   `buildFireModelCandidates(PLAN_POOL, "all", true, undefined, "CONTRACT_A_V1")`
   (`lib/executor/eventExecutionQueue.ts:815` and `:1169`).
4. A second ranker is live in the same layer: `compareCandidateQuality` is imported into
   `lib/executor/eventExecutionQueue.ts:18` and applied at `:748` (`.sort(compareCandidateQuality)`).

**First broken edge — TARGET LOCK vs CURRENT SOURCE FACT.**
`Contract A → Reservation`. Contract A's accepted decisions are not the input to Reservation.
Reservation consumes a legacy-selected candidate set wearing a Contract A label.

**Next measurable transition.**
One coherent cutover in which Reservation rows are created **only** from a Contract A approved
candidate set with a complete rejection trace, and rebalance invokes **no** model producer. The
measurable signal is: reservations created > 0 whose lineage resolves to a Contract A accepted
decision, and zero production callers of a model producer inside rebalance.

---

## 3. Canonical end-to-end production path — TARGET LOCK

```
Provider inventory jobs
  → canonical observations
    → signal pairs
      → snapshots
        → Contract A            (sole modelling / policy / ranking owner; runs ONCE, before Reservation)
          → versioned approved candidate set + complete rejection trace + execution-window metadata
            → Reservation       (exact physical occurrence; active duplicate protection;
                                 capacity up to 15; persistence; Contract A lineage)
              → Rebalance       (mechanical guards only: wait for the persisted execution window,
                                 refresh price/liquidity for the exact approved identity,
                                 apply price/time/liquidity/stake guards,
                                 select only inside the persisted approved set)
                → immutable Queue
                  → Ireland
                    → callback
                      → terminal state
                        → balance / PnL
```

There is exactly **one** solid production path. Any second producer of model, policy, score, or
rank is out of the contour by definition.

---

## 4. Ownership contract — TARGET LOCK

### 4.1 Contract A — the only modelling authority

Contract A **solely** owns:

- sport policy;
- signal score;
- model eligibility;
- market policy;
- model price policy;
- identity requirements;
- ranking;
- one-per-event (or bounded) approved-set formation;
- rejection reasons;
- sport / market / reason observability.

Contract A runs exactly once per plan, **before** Reservation. Its output is immutable
downstream.

### 4.2 Reservation — orchestration, not modelling

Reservation **owns**: exact physical-occurrence grouping, active duplicate protection,
capacity accounting up to 15 slots, persistence of the approved decision and its lineage,
and lifecycle status.

Reservation **must not**: recalculate score, sport policy, market policy, scope, ranking,
or model eligibility. It consumes Contract A output directly.

### 4.3 Rebalance — mechanical only

Rebalance **may**:

- wait for the persisted execution window;
- refresh price and liquidity for the exact approved identity;
- apply mechanical price / time / liquidity / stake guards;
- select only among the persisted approved set;
- use the persisted score and rank as data.

Rebalance **may not**:

- recalculate score, policy, or ranking;
- load a new model universe;
- add a market that was not approved;
- select an unapproved sibling market;
- perform fuzzy rediscovery from slug, title, or lineage strings.

### 4.4 Queue — immutable instruction

The queue row copies the approved identity verbatim. It ranks nothing and discovers nothing.
`app/api/executor/queue/route.ts` is already documented as the only executable source for
Ireland and explicitly does not call `buildFireModelCandidates` — **CURRENT SOURCE FACT**,
and a KEEP.

### 4.5 Ireland — execution boundary

Ireland mechanically consumes the immutable queue instruction, validates current time, price,
liquidity, and units against its own caps, executes no more than the PREMVP USD cap, and
returns execution facts. It never selects a market.

---

## 5. Typed boundary concept

Conceptual only. **Do not treat these as final TypeScript signatures** — the concrete types
are future TDD scope, defined in Commit A of the roadmap in §12.

| Boundary element | Concept | Immutability |
|---|---|---|
| Contract A input | a bounded, time-fixed set of snapshot rows for a plan horizon, already carrying strict observation identity | read-only to Contract A |
| Approved candidate set | versioned, ordered set of accepted decisions; each carries the exact executable identity (`condition_id`, `token_id`, `side`), the canonical physical-occurrence key, persisted score and rank | frozen at emit; no downstream re-rank |
| Rejection trace | complete, per-input-row reason coverage by canonical sport / market / reason — every input row is either approved or rejected with an exact reason; no unexplained residue | frozen at emit |
| Lineage | selector id + model version + plan id + as-of instant, persisted on the Reservation | append-only |
| Execution-window metadata | the persisted instruction describing *when* the approved decision may be executed (see §6) | data, not a re-decision trigger |

Existing source already provides the identity half of this boundary:
`lib/executor/executableMarketIdentity.ts` declares the canonical immutable execution identity
contract (`ExecutableMarketIdentityDecision`) with the invariants "no complete identity → no
Reservation row", "strings never determine execution after identity creation", "rebalance
validates, never substitutes" — **CURRENT SOURCE FACT**, and a KEEP. `NEW_COUNTUR_1` extends the
same discipline from *identity* to *the whole model decision*.

---

## 6. Semantic time contract — TARGET LOCK

| Time | Meaning | Owner |
|---|---|---|
| Dataset time | when provider inventory was collected | ingestion |
| Snapshot time | `created_at` of the observation row Contract A evaluates | signal pairs / snapshots |
| Model decision time | the fixed as-of instant at which Contract A evaluates a plan | Contract A |
| Reservation time | when the approved decision is persisted as a slot | Reservation |
| Execution-window time | the persisted T−70…T−3 interval during which the approved identity may be queued | Reservation (persisted) / Rebalance (waits) |
| Order time | when Ireland actually submits | Ireland |

**T−90 / T−120 semantics — TARGET LOCK.**
T−90 is a *snapshot-selection rule inside Contract A*: `resolveT90Snapshot` picks, per strict
observation identity, the latest snapshot at or before `start − 90m`
(`lib/modeling/frozenModelProducerV2Shadow.ts:230-242`, `T90_OFFSET_MS = 90 * 60_000`).
T−120 is a *timing predicate inside Contract A*: `passesTimingWithin120m`, `0 ≤ hoursUntilStart < 2`
(`:184-187`, `TIMING_UPPER_HOURS = 2`). Rejection reasons `SNAPSHOT_NOT_T90_COMPATIBLE` and
`OUTSIDE_120M` are Contract A's own — **CURRENT SOURCE FACT**.

T−90 / T−120 are **execution-window metadata and model input-selection rules**. They are
**not** justification for postponing Contract A until rebalance. The separate execution window
enforced by `isDueForRebalance` is T−70…T−3
(`lib/executor/nightWindow.ts:21,24`: `REBALANCE_MINUTES_BEFORE_START = 70`,
`LATEST_ENTRY_MINUTES_BEFORE = 3`) — **CURRENT SOURCE FACT**, and a KEEP.

The historical argument that a 17:00 plan cannot run Contract A because a distant game "has no
T−90 snapshot yet" (**HISTORICAL INTENT**, recorded verbatim in the comment at
`lib/executor/buildFireModelCandidates.ts:2023-2029`) is superseded: an occurrence whose T−90
snapshot does not yet exist is not yet a Contract A approval, and the correct response is a
Contract A re-run as snapshots appear — not a second, legacy modelling authority.

---

## 7. Exact identity continuity — TARGET LOCK

One identity travels the whole chain and is never re-derived from strings:

```
Contract A accepted decision (condition_id / token_id / side + canonical physical-occurrence key)
  → persisted verbatim on the Reservation
    → rebalance VALIDATES those exact IDs against a refreshed price/liquidity read
      → queue row copies them verbatim
        → Ireland receives the exact condition_id / token_id / side
```

Rules: no synthetic or defaulted IDs; absent means rejected; a string mismatch may **block**
execution but may never **select** another token; display titles and slugs are diagnostics only.

**Callback join — CURRENT SOURCE FACT that qualifies the target.** The task target names
"callback by `queue_id`". Source proves the live schema has **no** `executor_order_events.queue_id`
column: `lib/executor/executorCallbackContract.ts:14-20` documents the canonical join as
`idempotency_key` with a mandatory identity cross-check on `condition_id` / `token_id` / `side`,
and records that a `queue_id` insert attempt produced a live PostgREST `42703` error and was
removed at the route. `NEW_COUNTUR_1` therefore locks the *property* — the callback correlates to
exactly one immutable queue instruction by an exact key, never by fuzzy match — and names the
current key as `idempotency_key + identity cross-check`. Any future move to a literal `queue_id`
join is a schema change and is **out of scope** for this package.

---

## 8. Preserves (KEEP)

Documented as KEEP; current source shows no narrower qualification unless noted.

| Area | Surface | Note |
|---|---|---|
| Broad provider inventory | ingestion jobs | keep breadth; do not narrow sports to restore a funnel |
| Canonical observations | `generated_signal_pairs` export rows | keep |
| Signal pairs / snapshots | snapshot corpus | keep |
| Broad sports and markets | strategic scope set (`WC`, `SOCCER`, `MLB`, `ESPORT`, `BASKETBALL`, `HOCKEY`, `TENNIS`, `CRICKET`, `MMA`, `OTHER`) in `lib/executor/buildFireModelCandidates.ts:52+` | keep breadth; policy narrowing is Contract A's decision, not a pipeline-shape decision |
| Structured sport metadata | structured sport boundary (`d157b2f`, `d5be0f2`) | keep |
| Contract A pure model logic | `lib/modeling/frozenModelProducerV2Shadow.ts` — pure, read-only, side-effect free | keep; becomes the *only* authority |
| Exact identity work | `lib/executor/executableMarketIdentity.ts` | keep |
| Physical occurrence identity | `physical_event_id` / canonical event-key surfaces (`executorQueueTypes.ts`, `eventExecutionQueue.ts`, `r0PlanningTrace.ts`, migration `20260730_live_contour6_reservation_occurrence_identity.sql`) | keep |
| Reservation persistence + duplicate protection + lifecycle | `lib/executor/nightEventReservations.ts` | keep the orchestration; retire only its modelling authority |
| Capacity cap 15 | `TARGET_LIVE_SLOTS = 15` (`nightEventReservations.ts:399`); queue `DEFAULT_CAP = 15` (`app/api/executor/queue/route.ts`) | keep |
| Queue builder | `buildQueueRow` / `app/api/executor/queue/route.ts` | keep; already rank-free |
| Ireland mapper / API / callback | `lib/executor/executorCallbackContract.ts`, `app/api/executor/order-events/route.ts`, `app/api/executor/queue/mark/route.ts` | keep |
| Terminal states, balance / PnL | existing lifecycle + PnL derivation | keep |
| Released funnel instrumentation | `lib/executor/nightFunnelAudit.ts`, `scripts/contur3/audit-night-funnel.ts` | keep as **migration evidence**; it is pure, write-free, and already refuses to chain the two universes |

---

## 9. Retires from production authority

These lose *authority*, not necessarily their files. Physical deletion is a **separate cleanup
commit** after production parity and a zero-production-caller proof (§12, Gate `LEGACY CUTOFF`).

| Retired authority | Exact current surface — CURRENT SOURCE FACT | Disposition |
|---|---|---|
| Legacy filters inside `CONTRACT_A_PLANNING_V1` | `lib/executor/buildFireModelCandidates.ts:2023-2037` stamps a Contract A label onto legacy-filtered candidates | RETIRE FROM AUTHORITY |
| `buildFireModelCandidates` as an independent model owner | `lib/executor/buildFireModelCandidates.ts`; production entries `app/api/cron/night-event-reservations/route.ts:76/106/194`, `lib/executor/nightEventReservations.ts:715` | RETIRE FROM AUTHORITY; may survive as a pure adapter with zero policy/score/rank/selection ownership |
| Repeated Contract A / frozen-model invocation inside rebalance | `lib/executor/eventExecutionQueue.ts:812-816` and `:1166-1170` (`fetchContractAFinalCandidates`) | RETIRE FROM AUTHORITY — rebalance must invoke no model producer |
| `compareCandidateQuality` as a second model ranker | imported `lib/executor/eventExecutionQueue.ts:18`, applied `:748`; defined `lib/executor/nightPortfolioPlanner.ts:421`, also used `:469`, `:711`, `:727` | RETIRE FROM AUTHORITY inside the execution contour |
| Policy / score / scope recalculation after Reservation | any post-Reservation eligibility recomputation | RETIRE FROM AUTHORITY |
| Unapproved market substitution | alternate-sibling selection for a due reservation | FORBIDDEN |
| Fuzzy rediscovery | slug / title / lineage re-resolution of a market | FORBIDDEN (already blocked for the identity path by `executableMarketIdentity.ts`; must become universal) |
| Any parallel production modelling path | — | FORBIDDEN |

`lib/executor/nightPortfolioPlanner.ts` is also reached by `app/api/executor/night-plan/route.ts:11`.
That route's disposition is **NEEDS VERIFICATION** — it must be classified (production, ops-only, or
test-only) during Commit C before the zero-caller proof can be claimed.

---

## 10. Supersedes

`NEW_COUNTUR_1` **explicitly supersedes the Roadmap 2 two-stage modelling semantics**:
`CONTUR_ROADMAP_2.md` §1 "Canonical two-stage lifecycle" — Stage A "apply the existing score,
coverage, tier, and slot rules" at planning, Stage B "run the final Contract A decision stage"
at rebalance — and §2's required repair, "broad Contract A planning stage → event reservation →
later final Contract A decision at rebalance".

That design is the direct textual origin of the dual authority now in production
(**HISTORICAL INTENT**, `3d967bb Docs: define Contur Roadmap 2`, 2026-07-21T09:18+03:00).

`CONTUR_ROADMAP_2.md` and every other historical document are **preserved unchanged as
evidence**. Superseded means "no longer the design authority", not "deleted". Where a historical
document and this package conflict on modelling ownership, `NEW_COUNTUR_1` wins.

---

## 11. Counter reconciliation rule

**Never chain counters across two different universes.**

The 2026-08-02 evidence contains two funnels that share no continuity:

| Funnel | Counters (supplied production evidence, `diag-probe:20260802T085311`, as-of `2026-08-02T08:53:11.000Z`) |
|---|---|
| Legacy planning path | 3228 deduped rows; 416 planning-shadow rejects; 2812 admitted; 2812 rejected; **0** planning candidates; **0** Reservations. Reasons: `GAME_STARTED_OR_INVALID` 2262, `UNKNOWN_SCOPE` 311, `MARKET_POLICY_ACTIVITY_LABEL` 228, `MISSING_GAME_START` 9, `BAD_BUCKET_COV_PRICE` 2 |
| Parallel Contract A audit | 8049 source rows; 3418 strict identity groups; 3414 rejected; **4 accepted decisions**. Reasons: `ESPORTS_EXCLUDED` 1233, `SCORE_BELOW_65` 1568, `SNAPSHOT_NOT_T90_COMPATIBLE` 577, `OUTSIDE_120M` 36 |

**Required architectural conclusion — verified against source.** These were *parallel* model
paths, not consecutive stages, and the four accepted Contract A decisions were never fed into
Reservation. Source corroboration: the two funnels are produced by different owners
(`buildFireModelCandidates` legacy predicates vs `frozenModelProducerV2Shadow`), the reason
vocabularies are disjoint (legacy reasons live in `buildFireModelCandidates.ts` /
`nightPortfolioPlanner.ts`; Contract A reasons live in `frozenModelProducerV2Shadow.ts`), the row
bases differ (3228 vs 8049), and the released instrumentation itself keeps them apart:
`lib/executor/nightFunnelAudit.ts` emits `planning_funnel`, `contract_a_at_plan_time`, and
`contract_a_forecast` as **separate** sections and applies `assertFunnelContinuity` only to the
planning funnel, with the explicit comment that "Contract-A funnels are intentionally two
separate same-granularity segments … so they are not checked here" (`:733-745`).

The rule, going forward:

1. Counters may be chained only when same-universe continuity is **proved** (identical row base,
   identical identity granularity, single producer invocation).
2. `input === dropped + output` must hold at every chained stage; a contradiction throws, it is
   never floored to zero (already enforced by `PlanningAttributionError` / `FunnelArithmeticError`).
3. Cross-universe numbers must be reported side by side, never summed or subtracted.
4. `MARKET_POLICY_ACTIVITY_LABEL` was **not** locatable in tracked source at the base SHA
   (`rg` over the whole repo): treat it as `NOT_VERIFIABLE` from source and resolve its owner
   before any counter claim relies on it.

---

## 12. Implementation roadmap — DOCUMENTATION ONLY

**One** implementation branch. **Three** stacked commits. **One** coherent review.
**One** coherent deploy. No intermediate commit may be deployed separately, because every
intermediate state is a dual-authority state.

Preconditions: this package committed and pushed; Fable review returns
`PASS_NEW_COUNTUR_1_READY_FOR_IMPLEMENTATION`; Founder authorization.

---

## 13. Commit A / B / C scopes

### Commit A — Contract A authoritative output

- Deterministic, versioned approved candidate set from `produceFrozenModelV2ShadowDecisions`.
- Complete rejection trace keyed by canonical sport / market / reason, with full input coverage.
- Execution-window metadata emitted alongside each approved decision.
- Isolated pure functions (no DB, no network in the decision core).
- Production-shaped tests through the real loader → normalization → Contract A path, fixed time.

### Commit B — direct Contract A output → Reservation

- Reservation consumes the Contract A approved set **directly**.
- Exact physical-occurrence grouping.
- Active duplicate protection.
- Capacity cap 15.
- Contract A lineage persisted on every Reservation row.
- Legacy model filters and legacy ranking **bypassed** on the Reservation path.

### Commit C — mechanical rebalance + legacy cutoff

- **Zero** model invocation in rebalance: `fetchContractAFinalCandidates` and any equivalent
  producer call removed from `lib/executor/eventExecutionQueue.ts`.
- Selection restricted to the persisted approved set.
- Fresh price / liquidity read for the exact approved identity only.
- Mechanical guards only (price, time, liquidity, stake).
- Immutable queue row.
- Zero production callers of retired selector paths, proved repository-wide — including a
  disposition verdict for `app/api/executor/night-plan/route.ts`.

---

## 14. Rollback principle

The cutover is reversible as **one unit**, never partially.

1. Roll back by reverting the whole three-commit set / redeploying the previous `main` SHA.
2. Never roll back Commit C alone — that restores the dual authority the cutover removed.
3. Preserved infrastructure (Reservation persistence, identity contract, queue, Ireland,
   callback, PnL) is unchanged by the cutover, so rollback is a selector-ownership rollback,
   not a data rollback.
4. Released funnel instrumentation stays on across the cutover: the before/after funnels are
   the migration evidence.

---

## 15. Release and deploy prohibition

- **No intermediate dual-authority deploy.** Commits A and B alone leave both authorities live.
- Railway deploys from GitHub `main` automatically; `railway up` is forbidden.
- Therefore: nothing from the implementation branch may reach `main` until all three commits
  are complete, reviewed, and approved as one release.
- This documentation package is exempt from the cutover prohibition because it changes no
  runtime behaviour — it is the prerequisite that makes a coherent cutover possible.

---

## 16. Fable review entry criteria

Fable is **not** run in this task. Fable reviews the committed package and must cover:

divergence timeline · one model owner · T−90/T−120 execution semantics ·
direct `Contract A → Reservation` · mechanical-only rebalance · exact identity continuity ·
broad sport / market preservation · function disposition · old-caller cutoff · TDD plan ·
rollback · one coherent deploy.

Allowed verdicts:

- `PASS_NEW_COUNTUR_1_READY_FOR_IMPLEMENTATION`
- `FAIL_NEW_COUNTUR_1_WITH_EXACT_CONTRADICTION`

No runtime implementation may begin before `PASS`.

---

## 17. Current roadmap position

| # | Phase | Status |
|---|---|---|
| 1 | Dataset collection | KEEP — production exists |
| 2 | Signal pairs and snapshots | KEEP — production exists |
| 3 | Contract A implementation | EXISTS (`lib/modeling/frozenModelProducerV2Shadow.ts`) |
| 4 | Contract A sole ownership | **FAIL in current runtime** |
| 5 | Contract A direct output → Reservation | **NOT WIRED** |
| 6 | Legacy pre-Reservation modelling authority | **ACTIVE — must be retired** |
| 7 | Late Contract A invocation in rebalance | **ACTIVE — must be removed** |
| 8 | Reservation, exact identity, Queue, Ireland, callback, terminal state, PnL | KEEP |
| 9 | Diagnostic instrumentation | RELEASED — migration evidence |
| 10 | `NEW_COUNTUR_1` documentation package | **THIS TASK** |
| 11 | Fable review | only after this package is committed and pushed |
| 12 | Runtime implementation | only after Fable `PASS` |
| 13 | Production release | one coherent deploy only |

**Live-value rule.** The first broken edge is `Contract A output → Reservation` ownership. The
cutover must directly shorten the path to a real terminal business outcome. Legacy
reason-by-reason fixes are superseded. No new taxonomy, cleanup, alternate architecture, or
parallel producer is permitted unless it is a prerequisite for the coherent cutover. No second
implementation. Secondary optimization is deferred until the production path is restored. Every
later task must return the current production verdict and the next measurable transition.

See also: [`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md) ·
[`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md) ·
[`NEW_COUNTUR_1.mmd`](./NEW_COUNTUR_1.mmd)
