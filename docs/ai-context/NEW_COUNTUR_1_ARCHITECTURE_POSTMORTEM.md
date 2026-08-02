# NEW_COUNTUR_1 — Architecture Postmortem (R1)

<!-- TOKEN LOADING RULE: Tier 1. Load with NEW_COUNTUR_1.md for cutover work. -->
<!-- STATUS: CANONICAL / evidence document — R1. Base SHA 6e593a5d0e66e50941f130f7792f67e487dbb347. -->

Companion to [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md) (the lock) and
[`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md) (the gates).

**Revision:** R1 (2026-08-02). Corrects the R0 postmortem committed at
`752fd87a582fadd68db6056180308801f0a045ec`.
**Every CURRENT SOURCE FACT below was re-verified against tracked source at**
`6e593a5d0e66e50941f130f7792f67e487dbb347` **in this revision.** No finding was carried over on
trust from a prior review.

Tags: **CURRENT SOURCE FACT** · **CURRENT DEFECT** · **CORRECTED R1 TARGET** ·
**FUTURE IMPLEMENTATION REQUIREMENT** · **RUNTIME-ONLY OPERATOR PROOF** · **NOT VERIFIABLE**.

---

## 1. Incident summary

The production contour at `6e593a5d` runs **two modelling authorities** where the architecture
requires one. The Reservation cron believes it is planning with Contract A; the selector mode it
passes does not reach the Contract A branch, so the legacy CONTUR3 pipeline decides what is
reserved and Contract A is invoked hours later inside rebalance.

R0 identified this correctly. R1 exists because R0's *remedy statement* and four of its supporting
claims did not survive direct source re-verification, and because three further defects were not
covered at all.

---

## 2. Defect 1 — dual modelling authority (original finding, upheld)

**CURRENT DEFECT.** `app/api/cron/night-event-reservations/route.ts:76`, `:106`, `:194`, `:254`
pass `selectorMode: "CONTRACT_A_PLANNING_V1"`. `lib/executor/buildFireModelCandidates.ts:1296`
short-circuits to `buildContractAV1Candidates` for **`CONTRACT_A_V1` only**. `CONTRACT_A_PLANNING_V1`
therefore falls through the full legacy pipeline — formula-version, coverage, tier, bad-bucket and
scope predicates — and at `:2023-2037` merely stamps `selector_id` / `contract_a_stage` onto
candidates the legacy pipeline already produced. Final ordering at `:2041-2047` is the legacy
tier → score → hours-to-start sort.

**CURRENT DEFECT — second ranker.** `compareCandidateQuality` (`nightPortfolioPlanner.ts:421`) is
applied at `eventExecutionQueue.ts:748` *and* is the primary ranker inside `buildNightPortfolioPlan`
(`nightPortfolioPlanner.ts:711`, `:727`).

**Verdict:** R0 was right about this. Upheld without change.

---

## 3. Why "Contract A once before Reservation" was too simplistic

R0's remedy — *run Contract A exactly once, before Reservation* — conflated **one authority** with
**one invocation**.

**CURRENT SOURCE FACT.** The in-source comment at `buildFireModelCandidates.ts:2023-2030` records
the exact production consequence of attempting it: at the 17:00 planning stage a game several hours
away legitimately has no T−90 snapshot yet, so resolving the final authoritative universe there
returns nothing and the whole night plan collapses to **zero reservations** (production,
2026-07-25/26). The Contract A adapter consumes the frozen Model V2 shadow producer's accepted
decisions, which carry `condition_id`/`token_id`/`side` and only exist near T−90.

So the complete final Contract A market identity is *produced near the T−70…T−3 execution window*
and is **not** currently produced as a complete authoritative artifact before daily Reservation.
R0's rule was not merely inconvenient — it was infeasible against the real data timeline.

**CORRECTED R1 TARGET.** The invariant is **ONE MODEL OWNER**, expressed as two lifecycle
artifacts (Planning Decision, Final Identity Decision) under one Contract A authority. See
`NEW_COUNTUR_1.md` §4 and §23.

---

## 4. Temporal-stage confusion

The underlying error was treating "before Reservation" and "near execution" as *competing
architectures* rather than *two stages of one*. Symptoms of that confusion in current source:

- The planning stamp (`contract_a_stage: "PLANNING"`) exists, so the two-stage shape was already
  half-implemented — but only as metadata, with no Contract A decision behind it.
- `selectQueueRowForDueReservation` (`eventExecutionQueue.ts:599+`) already implements the correct
  *bounded* final-identity resolution: exact canonical event-key equality against
  `contractAFinalUniverse`, unique-match-required, fail-closed on zero or many (`:607-640`).
- But `fetchContractAFinalCandidates` (`:811-812`, `:912`) feeds it via
  `buildFireModelCandidates(PLAN_POOL, "all", true, undefined, "CONTRACT_A_V1")` (`:815`) — an
  **unbounded** universe fetch, bounded only after the fact by key matching.

**FUTURE IMPLEMENTATION REQUIREMENT.** Bound the Final Identity Decision **by input**, not by
post-filter.

---

## 5. Defect 2 — loss of broad sport metadata (not covered by R0)

**CURRENT SOURCE FACT.** Real upstream sport metadata exists and is already handled well on the
legacy path: `MODEL_SCOPE_BY_PROVIDER_SPORT_CODE` (`buildFireModelCandidates.ts:652-667`) maps 15
provider sport codes onto nine `StrategicScope` values; `resolveModelSport` (`:688+`) reads
`diagnostics.providerSportCode` explicitly before any text fallback and fails closed on a
malformed present value; `provider_sport_code` is recorded into diagnostics (`:1971`) and accepted
rows are reported by raw provider sport (`:2013-2016`).

*(The prior review reported "approximately ten codes". The exact count is 15. Correction recorded;
the finding itself stands.)*

**CURRENT DEFECT.** The Contract A adapter destroys it: `inferred_sport: "unknown"` (`:1228`) and
`strategic_scope: "OTHER"` (`:1230`), hardcoded. The comment at `:1159-1163` acknowledges the
hardcode and compensates by probing the esports BO-series branch with a *title-derived* hint; a
single narrow exception at `:1204` sets `"esport"`.

**Blast radius.** `buildQueueRow` sets `sport: best.inferred_sport`
(`eventExecutionQueue.ts:190`); Reservation sets `sport: best.inferred_sport`
(`nightEventReservations.ts:1136`) and buckets `bySport[best.inferred_sport]` (`:1100`). A direct
cutover to `CONTRACT_A_V1` without fixing the mapping collapses per-sport observability and
Reservation sport metadata into a single `unknown` / `OTHER` bucket — i.e. R0's claim that the
package "preserves broad sports" was true of the inventory but **false of the Contract A path**.

---

## 6. Defect 3 — source-lineage loss and reconstructed event start (not covered by R0)

**CURRENT DEFECT — lineage silently nulled.** `resolveQueueSourceSignalId`
(`eventExecutionQueue.ts:161-165`) prefers `generated_signal_pair_id`, falls back to `signal_id`
only if UUID-shaped, and otherwise **returns `null`**. On the Contract A path `signal_id` is
`condition_id::token_id`, never a row id — so a candidate without `generated_signal_pair_id` loses
its source lineage silently instead of failing closed.

**CURRENT DEFECT — two derivations of the same timestamp.**

| Path | Derivation |
|---|---|
| Legacy / planning | `diag.gameStartIso`, read from the provider row (`buildFireModelCandidates.ts:1543-1546`). |
| Contract A | `new Date(createdMs + decision.minutesUntilStart * 60_000).toISOString()` (`:1142-1144`) — **arithmetic reconstruction**. |

Reservation persists `event_start_iso: best.diagnostics.game_start_iso`
(`nightEventReservations.ts:1126`); duplicate protection then compares
`Date.parse(found.event_start_iso)` against the current value at **exact millisecond precision**
and raises `OCCURRENCE_IDENTITY_CONFLICT` on any difference (`:1571-1574`). Comparing a
reconstructed value against a provider-sourced one at millisecond precision is a defect regardless
of which side is "right".

**CURRENT DEFECT — identity dies at the Queue boundary.** `lib/executor/executorQueueTypes.ts`
declares `physical_event_id` and `event_start_iso` on `NightEventReservationRow` (`:34-35`) only.
`EventExecutionQueueRow` has neither. R0's identity-continuity claim did not hold across that
boundary.

**CURRENT SOURCE FACT — what is *not* broken.** Contract A lookup is
unique-match-or-fail-closed; the comment at `eventExecutionQueue.ts:610-614` states that
`compareCandidateQuality` must never substitute a different `condition_id`/`token_id`/`side`.
**No intended fuzzy sibling substitution exists on the Contract A path.** That part of the design
is sound and is KEEP.

---

## 7. Defect 4 — `/candidates` vs `/queue` dual execution authority (not covered by R0)

**CURRENT DEFECT.** Two production-shaped surfaces can instruct execution:

| Route | Evidence |
|---|---|
| `app/api/executor/queue/route.ts` | Reads persisted `event_execution_queue` rows. Correct source. |
| `app/api/executor/candidates/route.ts` | `buildFireModelCandidates(EVENT_DEDUPE_POOL, scope)` at `:260` with the **default `CONTUR3_CURRENT`** selector; returns `{ ...c, executor_safe: c.live_eligible, ... }` (`:308-318`), i.e. the full candidate including `condition_id`, `token_id`, `side`, `stake_usd`. Requires **no Reservation and no Queue row**. Gated by `EXECUTOR_CANDIDATES_SECRET` (`:204`) — a production secret, not a debug flag. |

`IRELAND_RUNTIME_CONTRACT.candidate_endpoint = "/api/executor/candidates"`
(`nightPortfolioPlanner.ts:157`), published to clients at
`app/api/executor/night-plan/route.ts:380`. The runtime contract still advertises the uncontrolled
surface as the candidate endpoint.

**RUNTIME-ONLY OPERATOR PROOF.** Which URL the live Ireland poller actually calls is **not
provable from this repository**. This is why the endpoint cut cannot be closed by code review
alone.

---

## 8. Defect 5 — callback-key and venue-field wording errors (not covered by R0)

**CURRENT SOURCE FACT.** `app/api/executor/order-events/route.ts` correlates by
`idempotency_key`: `findQueueRowByIdempotencyKey` (`:150-156`), `findOrderEventByIdempotencyKey`
(`:158-166`), plus a `clob_order_id` lookup (`:167-175`); the queue row is updated by primary key
`id` (`:176-182`). Unique-violation handling distinguishes `UNIQUE_VIOLATION_CLOB_ORDER_ID` from
`UNIQUE_VIOLATION_IDEMPOTENCY_KEY` (`:272`).

**CURRENT SOURCE FACT.** The note at `:200-205` records that `executor_order_events.queue_id`,
`match_family_key` and `reservation_id` are **not real live columns** — confirmed by a live `42703`
error and a full `information_schema` dump of the exact 43-column live table — and are never
written.

**Two wording errors corrected:**

1. **Callback key.** Any documentation stating or implying that callbacks correlate by a
   `queue_id` column on `executor_order_events` is wrong. The key is `idempotency_key`, with an
   exact-identity cross-check. R1 does **not** require adding a `queue_id` column; current source
   gives no evidence one is necessary.
2. **`venue_order_id`.** This field does not exist anywhere in tracked source. Wherever it appears
   in earlier documentation it is historical wording only. The real external order identifier is
   `clob_order_id`. It must not appear in any R1 target contract.

---

## 9. `compareCandidateQuality` — the nuance R0 flattened

R0 treated `compareCandidateQuality` as simply "a second ranker to delete". Source shows two
distinct roles that must be classified separately:

| Role | Location | Classification |
|---|---|---|
| Bounded fallback ranker for non-Contract-A reservations, under the planning/legacy-selector guard at `:607-620` | `eventExecutionQueue.ts:748` | `RETIRE_FROM_AUTHORITY` — production authority must reach zero |
| Primary ranker inside `buildNightPortfolioPlan` | `nightPortfolioPlanner.ts:711`, `:727` | Follows `buildNightPortfolioPlan`'s own classification (§10) |
| Ranker inside `selectBestCandidateForEventAtRebalance` | `nightPortfolioPlanner.ts:469` | Unreachable — see §10 |

Deleting the symbol outright, as a naive reading of R0 would suggest, would take out a reachable
non-Contract-A path before parity is proved. The function is retired **from authority** first;
physical deletion is a later cleanup step.

---

## 10. Defect 6 — dead guard logic and missing price/liquidity refresh (not covered by R0)

**CURRENT DEFECT — no fresh price or liquidity check exists in production.**
A full scan of `lib/executor/eventExecutionQueue.ts` for `liquidity`, `current_price`, `orderbook`,
`midpoint`, `refreshPrice` and `book` returns **zero matches**. `entry_price` and `max_entry_price`
appear only as diagnostics copied from the candidate (`:219-220`) — recorded, never re-evaluated
against a live quote at execution time.

**CURRENT DEFECT — the one guard that would have caught it is unreachable.**
`selectBestCandidateForEventAtRebalance` (`nightPortfolioPlanner.ts:459`) implements exactly the
missing behavior: promote the next valid backup when the top candidate's entry price has moved
beyond `max_entry_price`. It has **zero callers** in `lib/`, `app/`, `scripts/` or `tests/` — only
its own definition. Its time parameter is `_nowMs`, commented *"reserved for future price-staleness
checks"*.

**Net effect:** production queues an order at a price decided hours earlier, with no liquidity
check and no staleness check.

**Classification note.** `selectBestCandidateForEventAtRebalance` is `DELETE_AFTER_PARITY`, **not**
"delete now": its logic must first be re-implemented *reachably* inside the mechanical execution
guards.

**Related:** `buildNightPortfolioPlan` (`nightPortfolioPlanner.ts:636`) has exactly one caller,
`app/api/executor/night-plan/route.ts:237`. `buildFounderBattleBatchQueueRow`
(`eventExecutionQueue.ts:1792`, called `:1903`) is an alternate Queue writer and needs an explicit
production/ops classification before the zero-caller cutoff proof.

---

## 11. Why direct source overruled the original documentation

The R0 package was assembled from a mix of direct-source review and graph-assisted review on the
operator workstation. Those graph artifacts are Windows-only and are **not reachable from the
Cloud execution environment**, so for R1 every load-bearing claim was re-derived from
`git grep` / `rg` / targeted reads / `git log` against `6e593a5d`.

Three of R0's errors are traceable to reasoning about *intent* rather than *reachability*:

- A stamped `selector_id` reads like a decision; it is metadata (§2).
- A well-written function reads like a live guard; `selectBestCandidateForEventAtRebalance` has no
  callers (§10).
- A field named on a type reads like a persisted column; `physical_event_id` is on the Reservation
  row type only (§6).

The rule this produces: **presence in source is not reachability, and a type declaration is not a
persisted column.** Both require a caller trace or a schema check.

**No blame clause.** The R0 documentation executor did not cause the production defect and did not
introduce it. The defect predates the documentation package; R0 correctly identified the primary
dual-authority problem. R1 corrects the record, it does not reassign responsibility.

---

## 12. Why existing tests did not catch it

**CURRENT SOURCE FACT.** `tests/contur3/**` is substantial and exercises `buildFireModelCandidates`
under both `CONTRACT_A_PLANNING_V1` and `CONTRACT_A_V1`, plus extensive rebalance identity-parity
coverage (`eventExecutionQueue.rebalanceScheduler.test.ts` D1/D6/D8, `executionIdentityParity.test.ts`,
`nightEventReservations.scheduler.test.ts` C1/C2). `nightEventReservations.scheduler.test.ts:376-377`
even asserts the *literal source text* of the cron's selector-mode arguments.

The gaps:

1. Tests assert that the cron **passes** `CONTRACT_A_PLANNING_V1`; none asserts that passing it
   **reaches the Contract A branch**. The stamp is verified, the authority is not.
2. Tests start *below* the broken producer boundary — they inject rows directly into
   `buildFireModelCandidates` rather than exercising the real pre-Reservation producer.
3. No test asserts a fresh price or liquidity refresh, because no production code implements one
   (§10) — an absent behavior cannot fail an existing assertion.
4. No test asserts sport-metadata continuity across the Contract A adapter, so the hardcoded
   `unknown` / `OTHER` (§5) passes silently.
5. No test asserts `event_start_iso` derivation parity between the two paths (§6).

---

## 13. Blast radius

| Area | Effect |
|---|---|
| Model authority | Legacy pipeline decides reservations; Contract A decides nothing pre-Reservation. |
| Observability | Per-sport reporting collapses on the Contract A path (§5). |
| Identity | Source lineage nullable (§6); occurrence identity absent from Queue (§6). |
| Execution safety | No fresh price or liquidity guard (§10). |
| Execution surface | A second, secret-gated instruction source (§7). |
| Counters | Legacy funnel and Contract A audit are non-chainable universes (`nightFunnelAudit.ts:288`). |

---

## 14. Preserved working infrastructure

Broad provider inventory · observations · signal pairs · snapshots ·
`MODEL_SCOPE_BY_PROVIDER_SPORT_CODE` / `resolveModelSport` · Contract A pure model logic ·
exact-match identity resolution and fail-closed reason codes (`eventExecutionQueue.ts:607-640`) ·
`OCCURRENCE_IDENTITY_CONFLICT` occurrence uniqueness · Reservation persistence, duplicate
protection, cap 15, lifecycle · queue builder · `/api/executor/queue` · Ireland mapper/API ·
callback `idempotency_key` correlation · terminal states · balance/PnL · funnel instrumentation.

---

## 15. Corrective architecture

See [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md) §3–§13 for the corrected target and §17 for the
revised Commit A/B/C sequence. Summary: one model authority, two lifecycle artifacts, Reservation
as pure orchestration, bounded final identity, reachable mechanical guards, an immutable Queue as
sole execution instruction.

---

## 16. Prevention controls

| # | Control | Enforced by |
|---|---|---|
| P1 | A selector/mode argument must be proved to **reach** its branch, not merely to be passed. | Gate G1, G16 |
| P2 | Every function claimed as a guard must have a proved production caller. | Gate G14, G19 |
| P3 | A field on a TypeScript type is not a persisted column until schema-checked. | Gate G9, G17 |
| P4 | Any timestamp used in an equality comparison must have exactly one derivation. | Gate G8 |
| P5 | Metadata that exists upstream may not be hardcoded downstream. | Gate G6 |
| P6 | Every production execution surface must be enumerated and reduced to one. | Gate G12, G13 |
| P7 | Documentation claims must carry a path + symbol at a named SHA, or a NOT VERIFIABLE tag. | Gate G21 |
| P8 | Graph-tool findings are advisory; direct source is authoritative. | Gate G22 |

---

## 17. Source evidence ledger

Verdicts: `PROVED_CURRENT_SOURCE` · `PROVED_GIT_HISTORY` · `CONTRADICTED` · `PARTIAL` ·
`NOT_VERIFIABLE` · `RUNTIME_ONLY`.

| # | Claim | Source path | Symbol / line area | Verdict |
|---|---|---|---|---|
| 1 | Reservation cron plans with `CONTRACT_A_PLANNING_V1` | `app/api/cron/night-event-reservations/route.ts` | `:76`, `:106`, `:194`, `:254` | PROVED_CURRENT_SOURCE |
| 2 | `CONTRACT_A_PLANNING_V1` does not enter the Contract A branch; only stamps metadata | `lib/executor/buildFireModelCandidates.ts` | `:1296` (branch), `:2023-2037` (stamp), `:2041-2047` (legacy sort) | PROVED_CURRENT_SOURCE |
| 3 | `CONTRACT_A_V1` short-circuits to the Contract A adapter | `lib/executor/buildFireModelCandidates.ts` | `:1296` → `buildContractAV1Candidates` `:1097+` | PROVED_CURRENT_SOURCE |
| 4 | Current pre-Reservation model owner is the legacy pipeline | `lib/executor/buildFireModelCandidates.ts` | `:1300-2047` | PROVED_CURRENT_SOURCE |
| 5 | Post-Reservation Contract A caller is rebalance | `lib/executor/eventExecutionQueue.ts` | `:815`, `:1169` | PROVED_CURRENT_SOURCE |
| 6 | `compareCandidateQuality` has two live roles | `lib/executor/eventExecutionQueue.ts:748`; `lib/executor/nightPortfolioPlanner.ts:711`, `:727` | — | PROVED_CURRENT_SOURCE |
| 7 | `selectBestCandidateForEventAtRebalance` has zero callers | `lib/executor/nightPortfolioPlanner.ts` | `:459` (definition only) | PROVED_CURRENT_SOURCE |
| 8 | No price/liquidity refresh is reachable in the rebalance path | `lib/executor/eventExecutionQueue.ts` | zero matches for `liquidity`/`current_price`/`orderbook`/`midpoint`/`refreshPrice`/`book` | PROVED_CURRENT_SOURCE |
| 9 | Broad sport metadata exists upstream (15 provider codes) | `lib/executor/buildFireModelCandidates.ts` | `:652-667`, `resolveModelSport` `:688+`, `:1971`, `:2013-2016` | PARTIAL — finding upheld, count corrected from ~10 to 15 |
| 10 | Contract A adapter hardcodes `unknown` / `OTHER` | `lib/executor/buildFireModelCandidates.ts` | `:1228`, `:1230`, comment `:1159-1163`, exception `:1204` | PROVED_CURRENT_SOURCE |
| 11 | `physical_event_id` continuity: Reservation yes, Queue no | `lib/executor/nightEventReservations.ts:1125`; `lib/executor/executorQueueTypes.ts:34-35` | — | PROVED_CURRENT_SOURCE |
| 12 | `condition_id`/`token_id`/`side` continuity is exact-match, fail-closed | `lib/executor/eventExecutionQueue.ts` | `:607-640`, `buildQueueRow` `:170-230` | PROVED_CURRENT_SOURCE |
| 13 | Source lineage silently nulled for non-UUID values | `lib/executor/eventExecutionQueue.ts` | `resolveQueueSourceSignalId` `:161-165` | PROVED_CURRENT_SOURCE |
| 14 | `event_start_iso` arithmetically reconstructed on the Contract A path, exact-ms compared | `lib/executor/buildFireModelCandidates.ts:1142-1144` vs `:1543-1546`; `lib/executor/nightEventReservations.ts:1126`, `:1571-1574` | — | PROVED_CURRENT_SOURCE |
| 15 | `/api/executor/candidates` returns executable identity without Reservation or Queue | `app/api/executor/candidates/route.ts` | `:260`, `:308-318`, secret `:204` | PROVED_CURRENT_SOURCE |
| 16 | `/api/executor/queue` returns the persisted execution instruction | `app/api/executor/queue/route.ts` | `:50`, `:72` | PROVED_CURRENT_SOURCE |
| 17 | `IRELAND_RUNTIME_CONTRACT.candidate_endpoint` points at `/api/executor/candidates` | `lib/executor/nightPortfolioPlanner.ts:157`; served `app/api/executor/night-plan/route.ts:380` | — | PROVED_CURRENT_SOURCE |
| 18 | Callback lookup key is `idempotency_key` | `app/api/executor/order-events/route.ts` | `:150-166` | PROVED_CURRENT_SOURCE |
| 19 | `executor_order_events` has no `queue_id`/`match_family_key`/`reservation_id` column | `app/api/executor/order-events/route.ts` | note `:200-205` (live 42703 + information_schema dump) | PROVED_CURRENT_SOURCE |
| 20 | `clob_order_id` is the external order identifier; `venue_order_id` does not exist | `app/api/executor/order-events/route.ts` | `:73`, `:137`, `:167-175`, `:272`; zero matches for `venue_order_id` | PROVED_CURRENT_SOURCE |
| 21 | Production callers that must lose authority | `eventExecutionQueue.ts:748`; `nightPortfolioPlanner.ts:636`; `app/api/executor/candidates/route.ts`; `app/api/executor/night-plan/route.ts:237`; `eventExecutionQueue.ts:1792/1903` | — | PROVED_CURRENT_SOURCE |
| 22 | Tests assert the stamp, not the authority; no price/liquidity/sport-continuity tests | `tests/contur3/nightEventReservations.scheduler.test.ts:376-377`; `tests/contur3/**` | — | PROVED_CURRENT_SOURCE |
| 23 | Owner of rejection reason `MARKET_POLICY_ACTIVITY_LABEL` | — | zero matches in tracked source at `6e593a5d` | NOT_VERIFIABLE |
| 24 | Live Ireland polling URL | — | not in repository | RUNTIME_ONLY |
| 25 | Docs commit `752fd87a` is documentation-only over `6e593a5d` | git | `git diff --name-only 6e593a5d 752fd87a` → 5 files, all `docs/ai-context/` | PROVED_GIT_HISTORY |

---

**Related:** [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md) ·
[`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md) ·
[`09_CONTEXT_DELTA_LOG.md`](./09_CONTEXT_DELTA_LOG.md)
