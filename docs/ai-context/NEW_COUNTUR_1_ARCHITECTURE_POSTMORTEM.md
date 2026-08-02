# NEW_COUNTUR_1 — Architecture Postmortem

<!-- TOKEN LOADING RULE: Tier 1. Load with NEW_COUNTUR_1.md for cutover work. -->
<!-- STATUS: CANONICAL / evidence document. Base SHA 6e593a5d0e66e50941f130f7792f67e487dbb347. -->

Companion to [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md) (the lock) and
[`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md) (the gates).
Graph: [`NEW_COUNTUR_1.mmd`](./NEW_COUNTUR_1.mmd).

Tags used throughout: **CURRENT SOURCE FACT** · **HISTORICAL INTENT** · **TARGET LOCK** ·
**NOT VERIFIABLE**.

---

## 1. Incident summary

The production execution contour ran **two modelling authorities in parallel**, not one model
followed by orchestration.

- The nightly reservation path selected, scored, and ranked candidates with the **legacy CONTUR3
  pipeline**, then stamped them `selector_id = "CONTRACT_A_PLANNING_V1"`. The label asserted
  Contract A ownership that the code did not implement.
- **Contract A proper** ran later and separately, inside rebalance, over a different universe.
- Consequence: Contract A's accepted decisions were never the input to Reservation. On
  2026-08-02 the legacy path produced 0 planning candidates and 0 Reservations while the
  parallel Contract A audit produced 4 accepted decisions that reached nothing.

This is an **ownership** defect, not a threshold defect. No individual rejection-reason fix can
resolve it.

---

## 2. User / business impact

- Zero terminal business outcomes on the affected nights: 0 Reservations → 0 queue rows →
  0 orders → no PnL, from a corpus of thousands of source rows.
- Four genuinely accepted Contract A decisions were discarded silently — the worst impact class,
  because the model was working and the wiring was not.
- Diagnostic effort was repeatedly spent on legacy rejection reasons
  (`GAME_STARTED_OR_INVALID`, `UNKNOWN_SCOPE`, …) that belong to an authority scheduled for
  retirement, delaying the real fix.
- Every "fix a reason, re-run" cycle carried live-money risk surface without moving the
  contour toward a terminal outcome.

---

## 3. Detection path

1. Released funnel instrumentation (`lib/executor/nightFunnelAudit.ts`,
   `scripts/contur3/audit-night-funnel.ts`) made both funnels observable in one read-only run —
   **CURRENT SOURCE FACT**, and the reason the defect became visible at all.
2. The instrumentation refused to chain the two funnels: it emits `planning_funnel`,
   `contract_a_at_plan_time`, and `contract_a_forecast` as separate sections and applies
   `assertFunnelContinuity` only to the planning funnel (`nightFunnelAudit.ts:733-745`).
3. The `diag-probe:20260802T085311` run then showed, side by side, a legacy funnel ending at 0
   and a Contract A funnel ending at 4 — two endpoints that cannot both belong to one chain.
4. Source inspection confirmed the cause: the "Contract A planning" selector never calls
   Contract A.

---

## 4. Production evidence

Supplied production evidence, cross-referenced against source where possible.

- Production / `main` SHA: `6e593a5d0e66e50941f130f7792f67e487dbb347`
- Diagnostic plan: `diag-probe:20260802T085311` — as-of `2026-08-02T08:53:11.000Z`

**Legacy planning path**

| Counter | Value |
|---|---|
| Deduped rows | 3228 |
| Planning-shadow rejects | 416 |
| Admitted rows | 2812 |
| Rejected | 2812 |
| Planning candidates | **0** |
| Reservations | **0** |

Legacy reasons: `GAME_STARTED_OR_INVALID` 2262 · `UNKNOWN_SCOPE` 311 ·
`MARKET_POLICY_ACTIVITY_LABEL` 228 · `MISSING_GAME_START` 9 · `BAD_BUCKET_COV_PRICE` 2.

Source cross-reference: `GAME_STARTED_OR_INVALID`, `UNKNOWN_SCOPE`, and `BAD_BUCKET_COV_PRICE`
are owned by `lib/executor/buildFireModelCandidates.ts` and `lib/executor/nightPortfolioPlanner.ts`
— **CURRENT SOURCE FACT**. `MARKET_POLICY_ACTIVITY_LABEL` was **not** found anywhere in tracked
source at the base SHA — **NOT VERIFIABLE**; its owner must be resolved before any counter claim
depends on it.

**Parallel Contract A audit**

| Counter | Value |
|---|---|
| Source rows | 8049 |
| Strict identity groups | 3418 |
| Rejected | 3414 |
| Accepted decisions | **4** |

Contract A reasons: `ESPORTS_EXCLUDED` 1233 · `SCORE_BELOW_65` 1568 ·
`SNAPSHOT_NOT_T90_COMPATIBLE` 577 · `OUTSIDE_120M` 36. All four are owned by
`lib/modeling/frozenModelProducerV2Shadow.ts` — **CURRENT SOURCE FACT**.

---

## 5. Current source caller graph — CURRENT SOURCE FACT

Everything below is at `6e593a5d`.

**Production reservation path (17:00 Minsk)**

```
app/api/cron/night-event-reservations/route.ts:76 / :106 / :194
  → buildReservationPlan(nowMs, { selectorMode: "CONTRACT_A_PLANNING_V1" })
  → lib/executor/nightEventReservations.ts:711-715
      fetchCandidates = () => buildFireModelCandidates(PLAN_POOL, "all", true, undefined, selectorMode)
  → lib/executor/buildFireModelCandidates.ts:1296
      if (selectorMode === "CONTRACT_A_V1") → buildContractAV1Candidates   ← NOT TAKEN
      otherwise → legacy CONTUR3 scored/shadow pipeline                     ← TAKEN
  → :2023-2037  stamp diagnostics.selector_id = "CONTRACT_A_PLANNING_V1",
                      diagnostics.contract_a_stage = "PLANNING"
  → :2040       candidates.sort(tier, score, hours_to_start)                ← legacy ranking
  → Reservation rows
```

The label is applied *after* legacy filtering, scoring, and ranking have already decided the
outcome. `CONTRACT_A_PLANNING_V1` is a provenance stamp, not a model invocation.

**Production rebalance path (T−70…T−3)**

```
app/api/cron/event-rebalance/route.ts
  → runEventRebalance (lib/executor/eventExecutionQueue.ts)
  → :806-809   fetchCandidates            = buildFireModelCandidates(PLAN_POOL,"all",true)          ← legacy universe
  → :812-816   fetchContractAFinalCandidates = buildFireModelCandidates(..., "CONTRACT_A_V1")       ← MODEL RUNS HERE
  → :910-912   hasContractAPlanning = due.some(r => r.diagnostics?.contract_a_stage === "PLANNING")
               contractAFinalUniverse = hasContractAPlanning ? await fetchContractAFinalCandidates() : []
  → selectQueueRowForDueReservation (:599)
       planning reservations  → resolve against contractAFinalUniverse (STORED_IDENTITY | PLANNING_EVENT_KEY, both exact)
       other reservations     → :748  .sort(compareCandidateQuality)                                ← SECOND RANKER
  → queue row → Ireland
```

Identical duplication exists in the controlled live-intent seam
(`eventExecutionQueue.ts:1159-1170`, `:1202-1204`).

**Proved dual-authority edges**

| # | Edge | Evidence |
|---|---|---|
| E1 | Reservation is fed by the legacy model, not Contract A | `buildFireModelCandidates.ts:1296` routes only `CONTRACT_A_V1` to Contract A; the reservation cron passes `CONTRACT_A_PLANNING_V1` |
| E2 | Contract A runs inside rebalance | `eventExecutionQueue.ts:815`, `:1169` |
| E3 | A second ranker runs inside rebalance | `eventExecutionQueue.ts:18` import, `:748` `.sort(compareCandidateQuality)` |
| E4 | The Contract A label is cosmetic at planning | `buildFireModelCandidates.ts:2023-2037` stamps diagnostics only |
| E5 | Contract A output → Reservation is unwired | no production caller passes `"CONTRACT_A_V1"` into `buildReservationPlan`; the only non-rebalance `CONTRACT_A_V1` callers are `scripts/contur3/preview-contract-a-authoritative.ts` and tests |

---

## 6. Parallel-universe counter problem

The two funnels are not two stages of one chain. They differ in **every** dimension that would
be required for continuity:

| Dimension | Legacy planning funnel | Contract A audit funnel |
|---|---|---|
| Producer | `buildFireModelCandidates` legacy predicates | `produceFrozenModelV2ShadowDecisions` |
| Row base | 3228 deduped rows | 8049 source rows |
| Granularity | market/candidate rows | strict observation-identity groups (3418) |
| Reason vocabulary | `GAME_STARTED_OR_INVALID`, `UNKNOWN_SCOPE`, `BAD_BUCKET_COV_PRICE`, … | `ESPORTS_EXCLUDED`, `SCORE_BELOW_65`, `SNAPSHOT_NOT_T90_COMPATIBLE`, `OUTSIDE_120M` |
| Time basis | plan-time lookback window | per-identity T−90 snapshot resolution |
| Terminal output | 0 candidates → 0 Reservations | 4 accepted decisions → nothing |

Chaining them (e.g. "2812 rejected, therefore 4 accepted from the remainder") would be
arithmetic fiction. The released instrumentation encodes exactly this refusal
(`nightFunnelAudit.ts:733-745`). The counter reconciliation rule is locked in
[`NEW_COUNTUR_1.md` §11](./NEW_COUNTUR_1.md).

---

## 7. Divergence timeline

### 7.1 Proven facts

| When | Ref | Fact |
|---|---|---|
| 2026-07-21T09:18+03:00 | `3d967bb Docs: define Contur Roadmap 2` | `CONTUR_ROADMAP_2.md` §1 defines the two-stage lifecycle: Stage A applies "the existing score, coverage, tier, and slot rules"; Stage B runs "the final Contract A decision stage" at rebalance. §2 states the required repair as "broad Contract A planning stage → event reservation → later final Contract A decision at rebalance". This is the **design origin** of the dual authority. |
| — | `git merge-base --is-ancestor 3d967bb origin/main` → false | `3d967bb` is **not** an ancestor of `main`. It sits on an 8-commit pre-import line (`3d967bb ← 7342090 Add read-only Contract A preview runner ← a698b65 Wire authoritative Contract A decisions into Contur3 ← …`) that is not reachable from any branch. |
| 2026-07-21T09:32:28+03:00 | `2591e8e Implement canonical two-stage Contract A flow` | **Root commit of `main`** (`%p` empty), a bulk import of 588 files / 127,438 insertions. It already contains `CONTRACT_A_PLANNING_V1`, `buildContractAV1Candidates`, `fetchContractAFinalCandidates`, and `compareCandidateQuality` inside `eventExecutionQueue.ts`. |
| 2026-07-21T09:46:58+03:00 | `0fcbd0c Repair two-stage Contract A acceptance gaps` | First in-`main` reinforcement: touches the reservation route, `eventExecutionQueue.ts`, `nightEventReservations.ts`, the preview runner, and two test files. It repairs the two-stage design; it does not question it. |
| 2026-07-22 → 2026-08-02 | `82be4b8`, `4e03615`, `4405637`, `fed8f90`, `73609d5`, `5163146`, `28b9f7f`, `1ffbaeb`, `6e593a5` | Successive identity, policy-ordering, canary, and audit-attribution work, all inside the two-stage frame. `82be4b8 Add exact night funnel audit` is the instrumentation that eventually exposed the parallelism. |

### 7.2 Likely leads

- `a698b65 Wire authoritative Contract A decisions into Contur3` (pre-import line) is the most
  likely **first** Contract A wiring, and `7342090 Add read-only Contract A preview runner` the
  likely origin of the preview-only evaluation habit. Both are off-`main` and cannot be
  confirmed as production-reachable from this repository's history.
- `CONTUR_ROADMAP_2.md` §2 records that an earlier attempt wired Contract A at the *planning*
  boundary and produced `19 accepted → 0 reserved`, which was then judged invalid evidence
  (**HISTORICAL INTENT**). That judgement is the pivot that moved Contract A to rebalance.

### 7.3 Not verifiable

- The exact commit that first introduced the dual authority **cannot** be pinned inside `main`:
  `main`'s root is a bulk import that already contains it. No blame or `-S` search inside `main`
  can go earlier.
- Whether the pre-import line was ever deployed to production is unknown from this checkout.
- `MARKET_POLICY_ACTIVITY_LABEL` (228 rejects) has no owner in tracked source at `6e593a5d`.

**Verdict.** Neither `3d967bb` nor `0fcbd0c` is the singular root cause. `3d967bb` is the
**documented intent** that authorized late Contract A invocation; `2591e8e` is the point at
which `main`'s history begins already carrying the implementation; `0fcbd0c` and later commits
**reinforced and hardened** it. The bounded timeline above is the honest maximum.

---

## 8. Root architectural causes

1. **Two producers of the same decision class.** Model/policy/ranking is emitted by both
   `buildFireModelCandidates` (legacy) and `frozenModelProducerV2Shadow` (Contract A), at two
   different points in the same contour.
2. **A label was accepted as a contract.** `selector_id = "CONTRACT_A_PLANNING_V1"` named an
   ownership that no code enforced. Nothing tested that the name implied the invocation.
3. **No typed boundary between model and orchestration.** Contract A's output has no
   distinct, immutable "approved candidate set" type that Reservation is obliged to consume;
   both authorities emit the same `FireModelCandidate` shape, so a legacy candidate is
   structurally indistinguishable from an approved decision.
4. **A time-semantics confusion was resolved by relocating the model** rather than by
   re-running it (see §12).
5. **The legacy path was never cut off.** Retirement was assumed by naming, not proved by a
   zero-caller test.
6. **The design document authorized it.** Roadmap 2 §1 made the two-stage split canonical, so
   every subsequent executor was correct-by-the-document while wrong-by-the-architecture.

---

## 9. Why existing tests did not catch it

- Tests exercise `CONTRACT_A_V1` and `CONTRACT_A_PLANNING_V1` **as designed**:
  `tests/contur3/nightEventReservations.scheduler.test.ts:376-386` asserts that the cron passes
  `"CONTRACT_A_PLANNING_V1"` — it pins the defect in place as the expected contract.
- `tests/contur3/twoStageReservationTiming.test.ts` and
  `tests/contur3/executionIdentityParity.test.ts` verify the *two-stage* flow end to end, so a
  green suite confirms the dual authority rather than flagging it.
- Identity tests (`executionIdentityParity`, `eventExecutionQueue.rebalanceScheduler` D1/D6/D7)
  correctly prove that the exact identity is never substituted — a real and valuable guarantee —
  but identity immutability says nothing about **who decided** the candidate.
- No test asserts *ownership*: nothing asserts "Reservation input originated from a Contract A
  accepted decision", and nothing asserts "rebalance invokes zero model producers".
- No test asserts **caller cutoff**: no zero-production-caller proof exists for the legacy
  selector.

---

## 10. Why executor reports were insufficient

- Reports answered "did the patch apply and build?" — both true — while the architectural
  question was "which layer owns the decision?".
- Per-reason funnel reporting made legacy rejections look like the whole story; a funnel that
  ends at 0 invites reason-by-reason repair, which is exactly the wrong move when the funnel
  itself is the retired authority.
- Counters from two universes were reported in one document, which made a chained reading
  psychologically available even where the code never chained them.
- Green build + green tests were treated as architectural acceptance. `AGENTS.md §3.4` already
  forbids that; the gap was that no gate specifically demanded *ownership* evidence.

---

## 11. Model vs orchestration ownership failure

The contour has exactly two kinds of layer, and they were mixed:

| Layer kind | Legitimate powers | Observed violation |
|---|---|---|
| **Model authority** (Contract A) | policy, score, eligibility, market policy, price policy, ranking, approved-set formation, rejection reasons | invoked in the wrong place (rebalance), and not invoked in the right place (planning) |
| **Orchestration** (Reservation, Rebalance, Queue) | grouping, dedupe, capacity, persistence, waiting, refreshing prices, mechanical guards, immutability | `buildFireModelCandidates` filtering/scoring/ranking at planning; `compareCandidateQuality` ranking at rebalance; model invocation inside rebalance |

Orchestration is permitted to **discard** an approved candidate for mechanical reasons. It is
never permitted to **create, re-score, or re-rank** one.

---

## 12. T−90 semantic confusion

**CURRENT SOURCE FACT.** T−90 and T−120 are both *inside* Contract A:

- `T90_OFFSET_MS = 90 * 60_000`; `resolveT90Snapshot` picks the latest snapshot at or before
  `start − 90m` per strict observation identity — a **snapshot-selection rule**
  (`frozenModelProducerV2Shadow.ts:230-242`).
- `TIMING_UPPER_HOURS = 2`; `passesTimingWithin120m` requires `0 ≤ hoursUntilStart < 2` — a
  **model timing predicate** (`:184-187`).
- The *execution* window is a different thing entirely: T−70…T−3, enforced by `isDueForRebalance`
  (`nightWindow.ts:21,24,110`).

**HISTORICAL INTENT.** The comment at `buildFireModelCandidates.ts:2023-2029` states the
reasoning verbatim: a 17:00 plan reads the broad inventory because "a game several hours away
legitimately has no T−90 snapshot yet, so resolving the final universe here returns nothing and
the whole night plan collapses to zero reservations (production, 2026-07-25/26)".

**The error.** The observation was correct; the inference was not. "Contract A cannot decide
*this occurrence yet*" was converted into "Contract A must not own the planning decision at
all", which handed authority back to the legacy pipeline and moved the model behind Reservation.

**TARGET LOCK.** An occurrence without a T−90 snapshot is simply **not yet approved**. The
correct response is to re-run Contract A as snapshots appear and to let the approved set fill
over time — never to introduce a second authority. T−90/T−120 are execution-window and
input-selection metadata, not model-invocation timing.

---

## 13. Observability ownership failure

- Rejection reasons were emitted by the layer that happened to drop the row, not by the layer
  that **owns** the decision class. Legacy pipeline reasons therefore described model-class
  outcomes (`UNKNOWN_SCOPE`, `MARKET_POLICY_ACTIVITY_LABEL`) that belong to Contract A.
- The result: two reason vocabularies for one decision, and no single place where "why was this
  occurrence not bet?" can be answered.
- At least one reason (`MARKET_POLICY_ACTIVITY_LABEL`, 228) has no owner discoverable in tracked
  source — an observability surface with no located producer.
- Counter-positive: `nightFunnelAudit.ts` is layer-honest by construction — it "NEVER recomputes
  a threshold, score, tier, timing, price, or grouping decision", only reshapes counts the
  production code already emitted. That property is what made the incident detectable and is a
  KEEP.

---

## 14. Legacy-cutoff failure

Retirement was declared by renaming, not by removal:

- `CONTRACT_A_PLANNING_V1` was added to `FireModelSelectorMode` alongside `CONTUR3_CURRENT`
  rather than replacing it. Three selector modes coexist at `6e593a5d`.
- No zero-production-caller proof was ever produced for the legacy selector.
- `compareCandidateQuality` was retained in the execution contour with a comment warning it
  "must NEVER substitute a different condition_id/token_id/side" (`eventExecutionQueue.ts:610`) —
  a comment guarding a call site that should not exist in the target contour at all.
- `lib/executor/nightPortfolioPlanner.ts` remains reachable from
  `app/api/executor/night-plan/route.ts:11`; its production status is **NEEDS VERIFICATION**.

---

## 15. Roadmap delta failure

`CONTUR_ROADMAP_2.md` was never revised after the two-stage design produced 0 Reservations. The
document remained the authority while production evidence contradicted it. Each subsequent task
was measured against Roadmap 2 compliance rather than against the terminal business outcome, so
correct-per-document work accumulated on top of an architecture the evidence had already
falsified. `NEW_COUNTUR_1.md` §10 supersedes those semantics explicitly; the historical documents
stay in the repository as evidence.

---

## 16. Blast radius

**Affected (authority must change)**

- `lib/executor/buildFireModelCandidates.ts` — selector modes, legacy predicates, ranking, stamp.
- `lib/executor/nightEventReservations.ts` — candidate intake path (`:711-715`); orchestration retained.
- `lib/executor/eventExecutionQueue.ts` — `fetchContractAFinalCandidates` (`:812-816`, `:1166-1170`),
  `compareCandidateQuality` usage (`:18`, `:748`), selection logic (`:599+`).
- `lib/executor/nightPortfolioPlanner.ts` — ranking authority; disposition pending.
- `app/api/cron/night-event-reservations/route.ts` — selector wiring.
- Tests that pin the two-stage contract (`nightEventReservations.scheduler.test.ts`,
  `twoStageReservationTiming.test.ts`, `executionIdentityParity.test.ts`,
  `eventExecutionQueue.rebalanceScheduler.test.ts`).

**Not affected**

- Ingestion, signal pairs, snapshots, structured sport metadata.
- Reservation persistence, duplicate protection, capacity cap, lifecycle.
- Identity contract, queue builder, queue route, Ireland mapper, callback, terminal states, PnL.
- All UI, feed, pricing, payment, and auth surfaces — entirely out of scope.

---

## 17. Preserved working infrastructure

The incident is narrow. Almost everything built to date is correct and stays:

broad provider inventory · canonical observations · signal pairs · snapshots · broad sports and
markets · structured sport metadata · Contract A's pure model logic · exact identity work ·
physical-occurrence identity · Reservation persistence · active duplicate protection · cap 15 ·
lifecycle · queue builder · Ireland mapper/API · callback · terminal states · balance/PnL ·
released funnel instrumentation (as migration evidence).

Full table with source references: [`NEW_COUNTUR_1.md` §8](./NEW_COUNTUR_1.md).

---

## 18. Corrective architecture

One authority, one path, one deploy:

```
snapshots → Contract A (sole owner, runs once, before Reservation)
          → approved candidate set + complete rejection trace + execution-window metadata
          → Reservation (exact occurrence, dedupe, cap 15, lineage, persistence)
          → Rebalance (mechanical guards only, persisted approved set only, no model)
          → immutable Queue → Ireland → callback → terminal state → PnL
```

Delivered as three stacked commits on one branch (Commit A: authoritative output; Commit B:
direct output → Reservation; Commit C: mechanical rebalance + legacy cutoff), reviewed once,
deployed once. Scopes and rollback: [`NEW_COUNTUR_1.md` §12-§15](./NEW_COUNTUR_1.md).

---

## 19. Prevention controls

Each maps to a gate in [`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md).

| Cause (§8) | Control | Gate |
|---|---|---|
| Two producers | one named decision owner per decision class | `ONE DECISION OWNER` |
| Label ≠ contract | typed, immutable boundary object; ownership asserted by test | `BOUNDARY CONTRACT FIRST`, `CALLER OWNERSHIP TEST` |
| No approved-set type | approved set frozen at emit | `MODEL OUTPUT IMMUTABILITY` |
| Time confusion | explicit semantic time contract | `SEMANTIC TIME CONTRACT` |
| Legacy never cut off | zero-production-caller proof required | `LEGACY CUTOFF`, `NO PARALLEL PRODUCTION PATH` |
| Document outlived evidence | roadmap delta review each cycle | `ROADMAP DELTA REVIEW` |
| Reason-by-reason repair | failure tree with 3-5 competing causes before any patch | `FAILURE TREE BEFORE PATCH` |
| Cross-universe counters | same-universe continuity proof | `COUNTER RECONCILIATION` |
| Dual-authority deploys | one coherent cutover release | `COHERENT CUTOVER RELEASE` |

---

## 20. Evidence ledger summary

| CLAIM | SOURCE PATH | COMMIT | FUNCTION / SECTION | VERDICT |
|---|---|---|---|---|
| Reservation cron selects `CONTRACT_A_PLANNING_V1` | `app/api/cron/night-event-reservations/route.ts` | `6e593a5d` | `:76`, `:106`, `:194` | PROVED_CURRENT_SOURCE |
| Only `CONTRACT_A_V1` routes to Contract A | `lib/executor/buildFireModelCandidates.ts` | `6e593a5d` | `:1296` `buildContractAV1Candidates` | PROVED_CURRENT_SOURCE |
| `CONTRACT_A_PLANNING_V1` only stamps diagnostics | `lib/executor/buildFireModelCandidates.ts` | `6e593a5d` | `:2023-2037` | PROVED_CURRENT_SOURCE |
| Legacy ranking still decides planning order | `lib/executor/buildFireModelCandidates.ts` | `6e593a5d` | `:2040` tier/score/hours sort | PROVED_CURRENT_SOURCE |
| Contract A is invoked inside rebalance | `lib/executor/eventExecutionQueue.ts` | `6e593a5d` | `:812-816`, `:1166-1170` `fetchContractAFinalCandidates` | PROVED_CURRENT_SOURCE |
| A second ranker runs in rebalance | `lib/executor/eventExecutionQueue.ts` | `6e593a5d` | `:18` import, `:748` `.sort(compareCandidateQuality)` | PROVED_CURRENT_SOURCE |
| Contract A model owner is pure and side-effect free | `lib/modeling/frozenModelProducerV2Shadow.ts` | `6e593a5d` | header, `:51-58` | PROVED_CURRENT_SOURCE |
| T−90 / T−120 are Contract A internals | `lib/modeling/frozenModelProducerV2Shadow.ts` | `6e593a5d` | `:184-187`, `:230-242` | PROVED_CURRENT_SOURCE |
| Execution window is T−70…T−3, separate from T−90 | `lib/executor/nightWindow.ts` | `6e593a5d` | `:21`, `:24`, `:110` | PROVED_CURRENT_SOURCE |
| Instrumentation refuses to chain the two funnels | `lib/executor/nightFunnelAudit.ts` | `6e593a5d` | `:733-745` | PROVED_CURRENT_SOURCE |
| Identity contract already forbids substitution | `lib/executor/executableMarketIdentity.ts` | `6e593a5d` | header invariants 1-8 | PROVED_CURRENT_SOURCE |
| Cap 15 is the reservation/queue capacity | `lib/executor/nightEventReservations.ts:399`; `app/api/executor/queue/route.ts` | `6e593a5d` | `TARGET_LIVE_SLOTS`, `DEFAULT_CAP` | PROVED_CURRENT_SOURCE |
| Callback joins on `idempotency_key`, not `queue_id` | `lib/executor/executorCallbackContract.ts` | `6e593a5d` | `:14-20` | PROVED_CURRENT_SOURCE |
| Roadmap 2 authorized late Contract A invocation | `CONTUR_ROADMAP_2.md` | `3d967bb` | §1 Stage A/B, §2 | HISTORICAL_INTENT |
| `3d967bb` is not an ancestor of `main` | `git merge-base --is-ancestor` | — | pre-import 8-commit line | PROVED_GIT_HISTORY |
| `main`'s root already contains the dual authority | `git show -s --format=%p 2591e8e` (empty) | `2591e8e` | 588 files bulk import | PROVED_GIT_HISTORY |
| `0fcbd0c` reinforced, did not introduce | `git show --stat 0fcbd0c` | `0fcbd0c` | 6 files, +96/−13 | PROVED_GIT_HISTORY |
| Contract A must be the sole owner, before Reservation | task lock | — | `NEW_COUNTUR_1.md` §4 | FOUNDER_LOCKED_TARGET |
| `MARKET_POLICY_ACTIVITY_LABEL` has no source owner | repository-wide `rg` | `6e593a5d` | — | NOT_VERIFIABLE |
| `app/api/executor/night-plan/route.ts` production status | `app/api/executor/night-plan/route.ts:11` | `6e593a5d` | imports `nightPortfolioPlanner` | NEEDS_IMPLEMENTATION_REVIEW |
