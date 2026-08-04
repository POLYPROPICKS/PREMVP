# NEW_COUNTUR_1 — Canonical Single-Model-Authority Execution Contour

<!-- TOKEN LOADING RULE: Tier 1. Load before any Contract A / Reservation / Rebalance task. -->
<!-- OWNER: Founder (architecture lock) / Claude Code (evidence) -->

## 1. Document status and R1 correction summary

| Field | Value |
|---|---|
| Status | `CANONICAL / FOUNDER LOCKED — R1` |
| Revision | R1 (2026-08-02), corrects R0 (`752fd87a582fadd68db6056180308801f0a045ec`) |
| Date | 2026-08-02 |
| Base production SHA | `6e593a5d0e66e50941f130f7792f67e487dbb347` (`origin/main`, `Audit: use deduped planning admission universe`) |
| Docs base commit | `752fd87a582fadd68db6056180308801f0a045ec` |
| Package members | `NEW_COUNTUR_1.md` (this file), [`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md), [`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md) |
| Change class | documentation only — zero runtime, test, schema, config, or dependency change |
| Name lock | The canonical spelling is `NEW_COUNTUR_1`. It is not `NEW_CONTOUR_1` and must not be "corrected". |
| Mermaid | `NEW_COUNTUR_1.mmd` **deleted** from the active package and deferred — see §23 |

### C1 checkpoint and configurable-orchestrator lock — 2026-08-04

**C1 current release state:** branch `codex/queue-authority-cutoff-20260803`, source/test commit
`05ed5f45f60567a80fa6a231479ae95bc92962ab`, and remote feature head match are
**PROVEN_BY_CURRENT_GIT**. C1 is **not merged, deployed, or production-proven**. Detailed executable
gates are **FRESHLY_REVERIFIED_IN_RELEASE_TASK** and belong in PR/release evidence, not permanent
architecture prose.

**Founder-approved target contract — not a claim of current configurability.** One sequential
operator-configured run is: selected model/contour snapshot as-of cutoff → Contract A Planning →
physical-event grouping → event ranking and group/slot allocation → `persistReservationPlan()` →
`night_event_reservations`. Planning and Reservation are not parallel jobs. Configuration owns model,
contour, cutoff/as-of, total slots, group/sport allocation, and plan/run identity; “17:00 and 15” is
one present configuration, not a universal architecture rule.

Contract A owns eligibility, policy, score, rank, tier, rejection trace, unique physical-event
selection, and allocation before Reservation. Reservation freezes that selected portfolio and its
recoverable lineage. Final Identity is downstream and may inspect only the reserved physical event to
choose one exact condition/token/side and apply mechanical guards; it may not select a sibling event,
switch models, rerank, or recalculate planning. Queue is immutable; Ireland executes Queue and does
not rediscover model, event, market, token, side, or ranking. Do not add a separate Planning table now:
`night_event_reservations` remains the durable handoff unless independent planning/replay/rematerialize
or complete accepted/rejected-ledger requirements become real.

Every statement below is tagged. Read the tag before the sentence:

| Tag | Meaning |
|---|---|
| **CURRENT SOURCE FACT** | Verified against tracked source at `6e593a5d`. |
| **CURRENT DEFECT** | A verified fact that violates the target contract. |
| **CORRECTED R1 TARGET** | What the architecture must become. Not current behavior. |
| **FUTURE IMPLEMENTATION REQUIREMENT** | Work a later implementation branch must do. |
| **RUNTIME-ONLY OPERATOR PROOF** | Not provable from this repository. Operator must supply. |

### What R1 corrects

R0 locked the right *goal* — one model authority — but stated it in a form that direct source
review proved wrong or infeasible. R1 corrects five load-bearing claims and adds three R0 did not
cover.

| # | R0 claim | R1 correction | Section |
|---|---|---|---|
| 1 | "Contract A runs **once** before Reservation." | One model **authority**, expressed as **two lifecycle artifacts**. One invocation is infeasible, not merely inconvenient. | §4, §23 |
| 2 | Rebalance's defect is that it re-invokes Contract A. | The deeper defect: rebalance performs **no fresh price or liquidity check at all**, and the only code that ever did is **unreachable**. | §8 |
| 3 | Broad sports metadata is "preserved". | The Contract A adapter **hardcodes** `inferred_sport: "unknown"` and `strategic_scope: "OTHER"`, destroying upstream metadata that provably exists. | §12 |
| 4 | Queue already carries occurrence identity. | `EventExecutionQueueRow` carries **no** `physical_event_id` and **no** `event_start_iso`. | §9, §13 |
| 5 | Only `/api/executor/queue` treated as the execution surface. | `/api/executor/candidates` is a **secret-gated, production-shaped second execution authority** needing neither Reservation nor Queue. | §10 |
| 6 | *(absent in R0)* | `event_start_iso` is **arithmetically reconstructed** on the Contract A path, then **exact-millisecond compared** against a differently sourced Reservation timestamp. | §13 |
| 7 | *(absent in R0)* | Callback correlates by `idempotency_key`; `executor_order_events.queue_id` **does not exist**; the external order id is `clob_order_id`, never `venue_order_id`. | §11 |
| 8 | *(absent in R0)* | Provider→scope sport mapping already exists: **14 provider-code aliases mapped to 8 distinct StrategicScope values in the current source map**, not "about ten". | §12 |

---

## 2. Current production defect

**CURRENT DEFECT — dual modelling authority.**
`app/api/cron/night-event-reservations/route.ts:76`, `:106`, `:194`, `:254` all plan with
`selectorMode: "CONTRACT_A_PLANNING_V1"`. But `lib/executor/buildFireModelCandidates.ts:1296`
short-circuits to the Contract A adapter for **`CONTRACT_A_V1` only**:

- `CONTRACT_A_PLANNING_V1` falls through the entire legacy CONTUR3 pipeline — formula-version
  filter, coverage, tier, bad-bucket and scope predicates.
- At `:2023-2037` planning mode then stamps `selector_id: "CONTRACT_A_PLANNING_V1"` and
  `contract_a_stage: "PLANNING"` onto candidates **the legacy pipeline already produced**.
- At `:2041-2047` the final ordering is the legacy tier → score → hours-to-start sort.

The stamp is provenance metadata on a legacy decision. **Contract A does not decide what is
reserved.** It is invoked later, from inside rebalance: `lib/executor/eventExecutionQueue.ts:815`
and `:1169` call `buildFireModelCandidates(..., "CONTRACT_A_V1")`.

**CURRENT DEFECT — second live ranker in the same layer.**
`compareCandidateQuality` (`lib/executor/nightPortfolioPlanner.ts:421`) is imported at
`eventExecutionQueue.ts:18` and applied at `:748` to sort the executable market set for
non-Contract-A reservations. It is *also* the primary ranker inside `buildNightPortfolioPlan`
(`nightPortfolioPlanner.ts:711`, `:727`). Two ranking authorities in one lifecycle.

**Consequence.** The legacy funnel and the Contract A audit are parallel universes, not
consecutive stages. The released instrumentation already refuses to chain their counters
(`lib/executor/nightFunnelAudit.ts:288`).

---

## 3. Corrected canonical path — CORRECTED R1 TARGET

```
provider inventory
  → canonical observations
  → signal pairs / snapshots
  → CONTRACT A · PLANNING DECISION          (one model authority, stage 1)
  → event-level RESERVATION                 (orchestration only)
  → CONTRACT A · FINAL IDENTITY DECISION    (one model authority, stage 2)
  → mechanical execution guards             (no model, no ranking)
  → immutable QUEUE                         (sole execution instruction)
  → Ireland                                 (external execution)
  → callback                                (idempotency_key + identity cross-check)
  → terminal state → balance / PnL
```

Nothing between Reservation and Queue may open a new model universe, compute a new score, or
re-rank. Everything downstream of the Final Identity Decision is mechanical.

---

## 4. One model authority, two lifecycle artifacts — CORRECTED R1 TARGET

R0's rule — *Contract A runs once, before Reservation* — is superseded because it is not
achievable against the real data timeline.

**CURRENT SOURCE FACT.** The Contract A adapter (`buildContractAV1Candidates`,
`buildFireModelCandidates.ts:1097+`) consumes the frozen Model V2 shadow producer's own accepted
decisions, which carry `condition_id` / `token_id` / `side` and are resolved near the T−90 window.
The in-source comment at `buildFireModelCandidates.ts:2023-2030` records the production failure
directly: at the 17:00 planning stage a game several hours away legitimately has **no T−90
snapshot yet**, so resolving the final universe there returns nothing and the night plan collapses
to zero reservations (production, 2026-07-25/26).

**CORRECTED R1 TARGET.** The invariant is **ONE MODEL OWNER**, not one function invocation.
Contract A is the sole authority for:

sport policy · model eligibility · market policy · model price policy · score · rank · rejection
reasons · event-level planning approval · final exact-market identity decision.

It expresses that authority through exactly two artifacts:

1. **Contract A Planning Decision** — before Reservation (§5)
2. **Contract A Final Identity Decision** — near the execution window (§7)

These are two stages of one authority. They are **not** two competing models, and no third party —
not Reservation, not rebalance, not a route handler — may hold any responsibility listed above.

---

## 5. Planning Decision contract — CORRECTED R1 TARGET

Produced before Reservation, from the broad physical-event inventory.

| Required field | Note |
|---|---|
| `physical_event_id` | Canonical physical occurrence. |
| provider / source lineage | Provider event id, provider row id. |
| observation / signal lineage | Observation id and `generated_signal_pairs.id`, kept distinct. |
| normalized sport | Real upstream value. Never `"unknown"` when the provider supplied one. |
| league / competition | Real upstream value. |
| `strategic_scope` | Derived from provider sport code. Never a blanket `"OTHER"`. |
| planning score / rank | Contract A's own, not a legacy tier sort. |
| planning policy verdict | Approved / rejected. |
| event start | Provider-sourced, not reconstructed (§13). |
| execution-window metadata | T−70…T−3 bounds. |
| complete rejection trace | Every dropped row, with a reason code. |

**Permitted honesty clause.** The Planning Decision **may remain event-level or bounded
market-family level** when the final executable identity cannot yet be determined. It must say so
explicitly rather than inventing an identity it cannot yet know. This is the concession that makes
§4 feasible where R0 was not.

---

## 6. Reservation ownership — CORRECTED R1 TARGET

Reservation consumes the Contract A Planning Decision **directly** — not a legacy candidate set
that happens to carry a Contract A stamp.

**Reservation owns, and owns only:** exact physical-occurrence uniqueness · active duplicate
protection · capacity / risk cap up to 15 · persistence · lifecycle state · model lineage
(carrying it forward, never creating it).

**Reservation must not:** recalculate sport policy · recalculate model eligibility · recalculate
score · re-rank · independently choose a new market universe.

**CURRENT SOURCE FACT.** Reservation already persists `physical_event_id` (= group key) and
`event_start_iso` (`lib/executor/nightEventReservations.ts:1125-1126`), and enforces occurrence
uniqueness with an `OCCURRENCE_IDENTITY_CONFLICT` failure (`:1547-1574`). This machinery is
**KEEP** — the defect is what feeds it, not the mechanism.

---

## 7. Final Identity Decision contract — CORRECTED R1 TARGET

Near the execution window, Contract A produces the Final Identity Decision **only for persisted
reserved events**.

**It owns:** exact `condition_id` · exact `token_id` · exact `side` · exact market identity ·
final model price-policy verdict · final identity rejection reasons.

**It is bounded.** It operates strictly within the set of previously approved and reserved physical
events. It must never open an unrelated broad universe, and never select a different physical
occurrence than the one reserved.

**CURRENT SOURCE FACT — the correct shape partly exists.**
`selectQueueRowForDueReservation` (`eventExecutionQueue.ts:599+`) already resolves the final
identity for planning reservations by **exact canonical event-key equality** against
`contractAFinalUniverse`, requires a unique match, and fails closed on zero or on more than one
(`:607-640`). The comment at `:610-614` states the rule explicitly: `compareCandidateQuality` must
never substitute a different `condition_id`/`token_id`/`side`. **No intended fuzzy sibling
substitution exists on the Contract A path.**

**CURRENT DEFECT.** That bounded resolution runs *inside* the rebalance orchestrator and is fed by
`fetchContractAFinalCandidates` (`:811-812`, `:912`), which calls
`buildFireModelCandidates(PLAN_POOL, "all", true, undefined, "CONTRACT_A_V1")` (`:815`) — an
**unbounded** universe fetch. Boundedness is applied after the fact by key matching, not by
construction.

**FUTURE IMPLEMENTATION REQUIREMENT.** The Final Identity Decision must be bounded **by input**
(reserved events only), not filtered into boundedness afterwards.

---

## 8. Mechanical execution guards — CORRECTED R1 TARGET

After the Final Identity Decision, orchestration may **only**: wait for the execution window ·
refresh **current price** · refresh **liquidity** · enforce stake · enforce exposure · enforce
expiry / time · fail closed.

It must **not**: load a new model universe · compute a new score · re-rank · select an unapproved
sibling · change `physical_event_id` · change `condition_id` / `token_id` / `side` after
finalization.

**CURRENT DEFECT — the guards do not exist in production.**
A full scan of `lib/executor/eventExecutionQueue.ts` for `liquidity`, `current_price`, `orderbook`,
`midpoint`, `refreshPrice` or `book` returns **zero matches**. The queue path carries `entry_price`
and `max_entry_price` only as *diagnostics copied from the candidate* (`:219-220`) — recorded,
never re-evaluated against a live quote.

**CURRENT DEFECT — the only price-movement guard is unreachable.**
`selectBestCandidateForEventAtRebalance` (`nightPortfolioPlanner.ts:459`) is the one function
implementing "if the top candidate's entry price has moved beyond its `max_entry_price`, promote
the next valid backup". It has **zero callers** anywhere in `lib/`, `app/`, `scripts/` or
`tests/` — only its own definition. Its `nowMs` parameter is named `_nowMs` with the comment
*"reserved for future price-staleness checks"*. Dead code.

**Net effect:** production queues an order at a price decided hours earlier, with no liquidity
check and no staleness check, and the code that would have caught it is not wired to anything.

---

## 9. Immutable Queue — CORRECTED R1 TARGET

Queue is the **only** production execution instruction.

**Must persist:** `queue_id` · `reservation_id` · `physical_event_id` · source / observation /
decision lineage · `condition_id` · `token_id` · `side` · `event_start_iso` · `idempotency_key` ·
price / stake / liquidity guards · Contract A version and decision lineage.

After Queue creation, execution identity is **immutable**.

**CURRENT SOURCE FACT — what the Queue actually carries.**
`buildQueueRow` (`eventExecutionQueue.ts:170-230`) writes `reservation_id`, `plan_run_id`,
`rebalance_run_id`, `match_family_key`, `game_start_iso`, `condition_id`, `token_id`, `side`,
`stake_usd`, `order_key`, `idempotency_key`, and a diagnostics blob containing `source_signal_id`,
`battle_trace_id` and the `identity_*` parity fields.

**CURRENT DEFECT.** `lib/executor/executorQueueTypes.ts` declares `physical_event_id` and
`event_start_iso` on `NightEventReservationRow` (`:34-35`) **only**. `EventExecutionQueueRow` has
neither. Occurrence identity is reachable from the Queue only indirectly, by joining back through
`reservation_id`.

**FUTURE IMPLEMENTATION REQUIREMENT.** Carry both onto the Queue row as first-class fields.

---

## 10. Ireland execution authority — CORRECTED R1 TARGET

Ireland is the external execution service. It must consume `/api/executor/queue` and nothing else.

**CURRENT DEFECT — two production execution surfaces.**

| Route | Behavior at `6e593a5d` |
|---|---|
| `app/api/executor/queue/route.ts` | Reads persisted `event_execution_queue` rows. Correct source. |
| `app/api/executor/candidates/route.ts` | Calls `buildFireModelCandidates(EVENT_DEDUPE_POOL, scope)` at `:260` with the **default `CONTUR3_CURRENT`** selector, and returns each candidate via `{ ...c, executor_safe: c.live_eligible, ... }` (`:308-318`) — the full `FireModelCandidate` spread, i.e. `condition_id`, `token_id`, `side`, `stake_usd`. It requires **no Reservation and no Queue row**, and is gated by a production secret, `EXECUTOR_CANDIDATES_SECRET` (`:204`). |

`IRELAND_RUNTIME_CONTRACT.candidate_endpoint` is `"/api/executor/candidates"`
(`lib/executor/nightPortfolioPlanner.ts:157`), served to clients at
`app/api/executor/night-plan/route.ts:380`. The published runtime contract still names the
uncontrolled surface.

**CORRECTED R1 TARGET.**
- `/api/executor/queue` becomes the sole production execution-instruction source.
- `/api/executor/candidates` becomes diagnostics/preview only, or is removed from the production
  executor path. It must not remain a second production execution authority.
- `IRELAND_RUNTIME_CONTRACT.candidate_endpoint` must stop advertising it as an execution source.

**RUNTIME-ONLY OPERATOR PROOF.** The URL the live Ireland poller actually calls is **not provable
from this repository**. The operator must supply the live poller configuration before any deploy.
Blocking pre-deploy gate, not a documentation item.

---

## 11. Callback correlation — CORRECTED R1 TARGET

| Stage | Field |
|---|---|
| Queue instruction | `queue_id`, `idempotency_key`, exact immutable identity |
| Callback lookup | `idempotency_key` |
| Callback validation | exact identity cross-check |
| External venue receipt | `clob_order_id` |

**CURRENT SOURCE FACT.** `app/api/executor/order-events/route.ts` looks up the queue row by
`idempotency_key` (`findQueueRowByIdempotencyKey`, `:150-156`), looks up prior order events by
`idempotency_key` (`:158-166`) and by `clob_order_id` (`:167-175`), and updates the queue row by
its primary key `id` (`:176-182`). Unique-violation handling distinguishes
`UNIQUE_VIOLATION_CLOB_ORDER_ID` from `UNIQUE_VIOLATION_IDEMPOTENCY_KEY` (`:272`).

**CURRENT SOURCE FACT — no `queue_id` column.** The in-source note at `:200-205` records that
`executor_order_events.queue_id`, `match_family_key` and `reservation_id` are **not real live
columns**, confirmed by a live `42703` error and a full `information_schema` dump of the exact
43-column live table. They are never written.

**Corrected wording.** `venue_order_id` is **not** a runtime field anywhere in tracked source.
Wherever it appears in earlier documentation it is a wording error; the real external order
identifier is `clob_order_id`. R1 does **not** require a `queue_id` column on
`executor_order_events` — current source gives no evidence one is necessary.

---

## 12. Broad-sports preservation — CORRECTED R1 TARGET

**CURRENT SOURCE FACT — real sport metadata exists upstream.**
`MODEL_SCOPE_BY_PROVIDER_SPORT_CODE` (`buildFireModelCandidates.ts:652-667`) has **14 provider-code
aliases mapped to 8 distinct StrategicScope values in the current source map** — `basketball`,
`nba`, `hockey`, `nhl`, `ice hockey`, `baseball`, `mlb`, `tennis`, `cricket`, `mma`, `ufc`,
`soccer`, `football`, `esports`.
`resolveModelSport` (`:688+`) reads `diagnostics.providerSportCode` explicitly, before any
text-derived fallback, and fails closed on a malformed present value. The legacy/planning path
records `provider_sport_code` into diagnostics (`:1971`) and reports accepted rows by raw provider
sport (`:2013-2016`).

*(Correction to the reported finding: "approximately ten codes" is 14 provider-code aliases mapped
to 8 distinct StrategicScope values in the current source map. The finding stands; the count was
low.)*

**CURRENT DEFECT — the Contract A adapter throws it away.**
`buildContractAV1Candidates` hardcodes `inferred_sport: "unknown"`
(`buildFireModelCandidates.ts:1228`) and `strategic_scope: "OTHER"` (`:1230`). The comment at
`:1159-1163` acknowledges this and works around it by probing the esports BO-series branch with a
*title-derived* sport hint, because the real field is "always unknown" on this path. A single
narrow exception at `:1204` sets `"esport"` for BO-series titles.

This propagates: `buildQueueRow` sets `sport: best.inferred_sport`
(`eventExecutionQueue.ts:190`); Reservation sets `sport: best.inferred_sport`
(`nightEventReservations.ts:1136`) and buckets `bySport[best.inferred_sport]` (`:1100`). A direct
cutover to `CONTRACT_A_V1` without fixing the mapping would collapse per-sport observability and
Reservation sport metadata into one `unknown` / `OTHER` bucket.

**CORRECTED R1 TARGET.** Real normalized sport / league / scope metadata must flow through:

```
provider rows → observations → signal pairs / snapshots → Planning Decision
  → Reservation → Final Identity Decision → Queue → observability
```

Never hardcode `unknown` / `OTHER` when real upstream metadata exists. Explicit Contract A
sport-policy exclusions are permitted, but only when observable at every stage: source rows,
policy-approved rows, unique `physical_event_id`, approved planning decisions, Reservations, final
identity decisions, Queue, terminal result.

---

## 13. Identity lineage — CORRECTED R1 TARGET

The target is **immutable lineage across distinct entity IDs**. There is no single universal ID and
R1 does not invent one. Each is traced separately:

`provider source event ID` · `physical_event_id` · observation / source row ID · signal pair or
decision ID · `condition_id` · `token_id` / `selected_token_id` · `side` · `event_start_iso` ·
`reservation_id` · `queue_id` · `idempotency_key` · `clob_order_id`.

**CURRENT SOURCE FACT — exact-match discipline holds.** Contract A lookup is
unique-match-or-fail-closed (§7). No fuzzy sibling substitution is intended on that path.

**CURRENT DEFECT — source lineage is silently dropped.**
`resolveQueueSourceSignalId` (`eventExecutionQueue.ts:161-165`) prefers `generated_signal_pair_id`,
falls back to `signal_id` only if UUID-shaped, and otherwise **returns `null`**. On the Contract A
path `signal_id` is `condition_id::token_id` — never a row id — so a candidate lacking
`generated_signal_pair_id` silently loses its source lineage rather than failing closed.

**CURRENT DEFECT — `event_start_iso` is reconstructed, then compared exactly.**

| Path | Derivation |
|---|---|
| Legacy / planning | `diag.gameStartIso` read directly from the provider row (`buildFireModelCandidates.ts:1543-1546`). |
| Contract A | **Arithmetic:** `new Date(createdMs + decision.minutesUntilStart * 60_000).toISOString()` (`:1142-1144`). |

Reservation persists `event_start_iso: best.diagnostics.game_start_iso`
(`nightEventReservations.ts:1126`), and duplicate protection compares
`Date.parse(found.event_start_iso)` against the current value at **exact millisecond precision**,
raising `OCCURRENCE_IDENTITY_CONFLICT` on any difference (`:1571-1574`). A reconstructed timestamp
and a provider-sourced timestamp for the same physical occurrence will differ, producing a false
conflict — or a false *non*-conflict against a differently rounded value.

**CURRENT DEFECT — identity dies at the Queue.** See §9: the Queue row carries neither
`physical_event_id` nor `event_start_iso`.

**FUTURE IMPLEMENTATION REQUIREMENT.** One provider-sourced `event_start_iso`, carried verbatim end
to end; no arithmetic reconstruction; comparison at a declared tolerance or by exact carried value,
never by re-derivation.

---

## 14. Preserves (KEEP)

Broad provider inventory · canonical observations · signal pairs · snapshots ·
`MODEL_SCOPE_BY_PROVIDER_SPORT_CODE` and `resolveModelSport` · Contract A pure model logic
(`lib/modeling/frozenModelProducerV2Shadow.ts`) · exact-match identity resolution and its
fail-closed reason codes (`eventExecutionQueue.ts:607-640`) · `readPersistedExecutableIdentity` /
`readPersistedPlanningEventIdentity` · physical-occurrence identity and
`OCCURRENCE_IDENTITY_CONFLICT` · Reservation persistence · active duplicate protection · cap 15 ·
lifecycle · queue builder · `/api/executor/queue` · Ireland mapper and API · callback route and its
`idempotency_key` correlation · terminal states · balance / PnL accounting · released funnel
instrumentation (`nightFunnelAudit.ts`) as migration evidence.

---

## 15. Retires from production authority

| Path | Classification |
|---|---|
| Legacy predicates reached via `CONTRACT_A_PLANNING_V1` | `RETIRE_FROM_AUTHORITY` |
| `buildFireModelCandidates` as an independent model owner | `ADAPT` — becomes a Contract A adapter, not a decider |
| `compareCandidateQuality` as a ranker at `eventExecutionQueue.ts:748` | `RETIRE_FROM_AUTHORITY` |
| `buildNightPortfolioPlan` (`nightPortfolioPlanner.ts:636`) | `RETIRE_FROM_AUTHORITY` — sole caller is `/api/executor/night-plan` |
| `/api/executor/candidates` GET | `RETIRE_FROM_AUTHORITY` → `DIAGNOSTIC_ONLY` (§10) |
| `/api/executor/night-plan` GET | `NEEDS_IMPLEMENTATION_REVIEW` — advertises `IRELAND_RUNTIME_CONTRACT`; classify as ops-only or retire |
| `selectBestCandidateForEventAtRebalance` (`nightPortfolioPlanner.ts:459`) | `DELETE_AFTER_PARITY` — zero callers today; its price-movement logic must be **re-implemented reachably** in the mechanical guards first (§8) |
| `buildFounderBattleBatchQueueRow` (`eventExecutionQueue.ts:1792`, called `:1903`) | `NEEDS_IMPLEMENTATION_REVIEW` — an alternate Queue writer; must not remain a second production Queue authority |
| Post-Reservation policy / score / scope recalculation | `RETIRE_FROM_AUTHORITY` |
| Unapproved market substitution, fuzzy rediscovery | `RETIRE_FROM_AUTHORITY` |

Physical deletion is a separate cleanup step after production parity and a
zero-**production**-caller proof. Zero callers is **not** demanded of diagnostic or test-only
paths — only production authority must reach zero.

---

## 16. Diagnostic / test-only paths

| Path | Classification | Note |
|---|---|---|
| `scripts/contur3/preview-contract-a-authoritative.ts` | `DIAGNOSTIC_ONLY` | Read-only preview; never calls `persistReservationPlan`. |
| `scripts/contur3/audit-night-funnel.ts` | `DIAGNOSTIC_ONLY` | Funnel evidence. |
| `scripts/contur3/reservation-capacity-audit.tier-probe.ts` | `DIAGNOSTIC_ONLY` | `buildReservationPlan` is pure. |
| `scripts/preview-event-rebalance.ts` | `DIAGNOSTIC_ONLY` | `write` flag. |
| `lib/executor/nightFunnelAudit.ts`, `r0PlanningTrace.ts`, `fullmatchRejectionEvidence.ts` | `KEEP` | Observability. |
| `tests/contur3/**` | `TEST_ONLY` | See §18 test-gap note. |

---

## 17. Revised Commit A / B / C

One branch, three stacked commits, one coherent review, one coherent deploy. **No intermediate
commit may be deployed separately** — any intermediate state is dual-authority.

### Commit A — authoritative Contract A decision contracts
- `ContractAPlanningDecision` type (§5) and `ContractAFinalIdentityDecision` type (§7).
- Complete rejection trace on both.
- Broad sport metadata carried, not hardcoded (§12).
- Source / observation / decision lineage as distinct fields (§13).
- Pure model functions, no I/O.
- Tests at the **real producer entry**, not below it.

### Commit B — Planning Decision → Reservation
- Reservation consumes the Planning Decision directly.
- Exact physical occurrence; one provider-sourced `event_start_iso`.
- Broad sport metadata persisted.
- Lineage persistence.
- Duplicate protection and cap 15 unchanged in mechanism.
- Legacy pre-Reservation model authority bypassed.
- Production-shaped tests.

### Commit C — Final Identity + mechanical guards + Queue-only execution
- Final Identity Decision bounded **by input** to reserved events (§7).
- Exact `condition_id` / `token_id` / `side`, immutable thereafter.
- Mechanical guards: current price refresh, liquidity refresh, stake, exposure, time (§8).
- Immutable Queue carrying `physical_event_id` and `event_start_iso` (§9).
- `/api/executor/candidates` removed from production execution authority;
  `IRELAND_RUNTIME_CONTRACT` updated.
- Callback wording aligned to `idempotency_key` + identity cross-check; `clob_order_id` as the
  external receipt (§11).
- Retired production callers reach zero.
- Live Ireland polling configuration becomes a pre-deploy operator gate.

**Fourth-commit clause.** If direct source proves three commits unsafe, document the unavoidable
fourth commit and the exact boundary requiring it. Do not invent extra phases for cleanup alone.

---

## 18. Runtime-only operator proofs

These cannot be settled from this repository and block deploy:

1. The live Ireland polling URL and poller configuration (§10).
2. Whether any external consumer currently reads `/api/executor/candidates` in production.
3. The live `executor_order_events` column set beyond the 43-column dump referenced at
   `order-events/route.ts:200-205`.
4. Live per-sport volume before and after the Contract A cutover, proving §12 did not narrow the
   inventory.
5. The owner of rejection reason `MARKET_POLICY_ACTIVITY_LABEL` — **still not locatable in tracked
   source** at `6e593a5d` (carried forward from R0).

**Test-gap note.** `tests/contur3/**` exercises `buildFireModelCandidates` under both selector
modes and covers rebalance identity parity extensively, but no test asserts a fresh price or
liquidity refresh (§8) — because no such production code exists to assert against.

---

## 19. Rollback

Each commit is revertible in isolation at the source level, but **only the full A+B+C set is
revertible as a behavior**. Rollback of the deployed cutover is a revert of the whole branch plus a
Reservation/Queue state check for the affected night. Partial rollback re-creates the
dual-authority state this document exists to remove, and is prohibited.

---

## 20. One coherent deploy

One branch → one coherent review → one coherent deploy. Prohibited: deploying Commit A or B alone;
enabling `CONTRACT_A_V1` in production before §12 and §13 are fixed; any deploy before the §18
operator proofs are supplied.

---

## 21. Fable entry criteria

Independent architecture review may begin when: this R1 package is committed; every §2 / §7 / §8 /
§9 / §10 / §11 / §12 / §13 fact cites a path and symbol at `6e593a5d`; no target is presented as
current behavior; and the §18 list is complete. Allowed verdicts:
`PASS_NEW_COUNTUR_1_R1_READY_FOR_IMPLEMENTATION` or
`FAIL_NEW_COUNTUR_1_R1_WITH_EXACT_CONTRADICTION`.

---

## 22. Current roadmap position

R0 package locked (`752fd87a`) → **R1 correction committed (this package)** → *next:* independent
Fable architecture review of R1. No runtime implementation, schema change, merge or deploy before
an R1 review `PASS`.

---

## 23. Explicit supersession of the one-invocation interpretation

> **Superseded:** "Contract A runs **once**, before Reservation."

That reading is withdrawn. It is not achievable against the real data timeline: the complete final
market identity does not exist at the 17:00 planning boundary, and forcing it there produced zero
reservations in production on 2026-07-25/26 (`buildFireModelCandidates.ts:2023-2030`).

> **Replacement invariant:** **ONE MODEL OWNER**, expressed as two lifecycle artifacts — Planning
> Decision and Final Identity Decision — under a single Contract A authority.

The prohibition R0 was reaching for survives intact and unweakened: no layer other than Contract A
may hold sport policy, eligibility, market policy, price policy, score, rank, rejection reasons,
planning approval, or final identity. What changes is the count of invocations, not the count of
authorities.

**Mermaid deferred.** `NEW_COUNTUR_1.mmd` is deleted from the active package — it encoded the
superseded one-invocation lifecycle. It remains in Git history at `752fd87a`. Visualization resumes
only after runtime implementation, a coherent deploy, production identity proof, and broad-sports
proof.

---

**Related:** [`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md) ·
[`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md) ·
[`09_CONTEXT_DELTA_LOG.md`](./09_CONTEXT_DELTA_LOG.md)
