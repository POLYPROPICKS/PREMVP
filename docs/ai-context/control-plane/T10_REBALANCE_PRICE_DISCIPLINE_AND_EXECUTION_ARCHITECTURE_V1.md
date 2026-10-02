# T10 Rebalance Price Discipline and Execution Architecture — V1

| Field | Value |
|---|---|
| Architecture id | `T10_REBALANCE_PRICE_DISCIPLINE_AND_EXECUTION_ARCHITECTURE_V1` |
| Mission | `T10_ECONOMIC_ACTION_POLICY_FREEZE_V1` |
| Status | **DESIGN_FROZEN_SHADOW_PROVEN** once an exact-SHA reviewer PASS is recorded; until then DESIGN_IMPLEMENTED_REVIEW_PENDING |
| Money path | **NOT_ACTIVE_IN_MONEY_PATH** — no Queue, TAKER, MAKER, LIVE_GUARD, stake, cap, Reservation or Ireland behavior reads this policy |
| Design base | `main` at `ef6ad01c783de306ae1b3010312a573a10dbff08` (includes PR #453, reference engine `8c6e9c2`) |
| Price authority | `T30_BID_ANCHOR_V1` |
| Policy version | `T10_ECONOMIC_ACTION_POLICY_SHADOW_V1` |
| Next transition | `T10_EXACT_MARKET_MONEY_ACTIVATION_V1` |

This document is the canonical description of how a reserved physical event is
turned into **at most one** economic action at T10. It separates three authorities
that earlier designs conflated: **which market may be bet** (bet-selection),
**the most we are willing to pay** (price), and **whether and how an order can be
executed** (execution).

---

## 1. Physical-event Reservation authority

A Reservation owns one **physical match** (`physical_event_id`, game-id based when
structured). The Reservation is the only authority that an event is in the night's
portfolio. One Reservation → at most **one economic bet** (one-event-one-bet
invariant). The policy never creates a second action for the same physical event,
and never reaches outside the reserved event.

## 2. T30 / T10 full sibling universe

At `T_MINUS_30` (20–30 min before start) and `T_MINUS_10` (9–15 min before start),
`captureReservationMarketObservation` (`lib/executor/reservationMarketBaseline.ts`)
discovers **every** current provider market of the same game (`sameGameLiveUniverse`)
and fetches every token's order book. Each token becomes one row in
`reservation_market_observations` (best bid/ask, spread, fetch status, timestamps);
each capture is one `reservation_market_capture_runs` row with `capture_complete` /
`capture_status`. Only a run with `capture_complete = true` and
`capture_status = 'COMPLETE'` is a usable source.

## 3. Supported families

Unchanged: `SPREADS`, `TOTAL_CORNERS`, `MONEYLINE`, `TOTALS` (full match only).
This policy does not add families.

## 4. Support bands (V1 support boundaries)

The existing B support regions (`bStrategySupportRegion`) remain the V1
bet-selection boundary, evaluated on the current T10 ask decimal odds:

| Family | Decimal-odds band | Approx. ask price |
|---|---|---|
| SPREADS | 1.85 – 2.00 | 0.500 – 0.541 |
| TOTAL_CORNERS | 2.25 – 2.50 | 0.400 – 0.444 |
| MONEYLINE | 1.85 – 2.00 | 0.500 – 0.541 |
| TOTALS | 1.85 – 2.00 | 0.500 – 0.541 |

A band is **eligibility**, not a price authority. It is not broadened here.

## 5. Family priority is no longer the economic winner

The current B selector (`selectReservationT3AbDecisions`) takes the first family in
the order SPREADS → TOTAL_CORNERS → MONEYLINE → TOTALS that has any in-band book.
That order is **not** an economic argument. Under this architecture, every
supported in-band sibling is evaluated, and the winner is chosen by the economic
ranking in §13. Family appears only as a reporting stratum.

## 6. Exact-market reference: STRONG / WEAK / UNRESOLVED

Module: `lib/executor/exactMarketReference.ts` (`EXACT_MARKET_REFERENCE_SHADOW_V1`).
For one exact token (physical event + `condition_id` + `token_id` + side):

- **STRONG** — at least two usable, non-duplicative, identity-exact temporal
  witnesses (T30 book and T10 book of the same token) whose `[bid, ask]` intervals
  share a common price.
- **WEAK** — exactly one usable witness.
- **UNRESOLVED** — no usable witness, an identity inconsistency, or witnesses
  with no common price. No reference price is produced.

A book is a usable witness only if: its capture run is complete, the fetch
succeeded, it lies inside its phase window (`classifyReservationMarketPhase`), it
is two-sided, it is not crossed, and its spread is ≤ `LIVE_EXECUTION_MAX_SPREAD`
(0.03). The 0.03 is used here **only as a source-quality label**.

`reference_price` is market price evidence only. It is **not** a win probability.

## 7. Binary complement mirror rule

For a binary market, the other token on the **same** `condition_id` is a mirror of
the **same** CLOB (`Over bid = 1 − Under ask`). It carries zero independent
information. It is diagnostic only: it never counts as a witness, never upgrades
WEAK → STRONG, and never creates a price authority. Real example (2026-10-02, game
75172418, `total-2pt5`): Under 0.02/0.51 with Over 0.49/0.98 is **UNRESOLVED**, and
no 0.49 maker price may be inferred from the mirror.

Also never evidence for another exact market: a Planning price for a sibling
market, another line, another family, any synthetic or bookmaker-equivalent odds.
Recent trades have no authoritative carrier in the T10 lineage
(`SOURCE_UNAVAILABLE`).

## 8. Exact temporal price witnesses

The only witnesses in V1 are the T30 and T10 order books of the identical token.
They are two observations of the **same venue at two times**: T30 evidence is
**not** independent-venue evidence. STRONG means "the exact book was usable and
consistent across 20 minutes", not "two independent markets agree".

## 9. P_BUY_MAX — price authority (`T30_BID_ANCHOR_V1`)

```
P_BUY_MAX = min( T30 best_bid of the identity-exact T30 witness ACCEPTED by
                 the canonical reference engine , 0.54 )
```

- Exists only when the reference status is STRONG or WEAK **and** the engine
  accepted the exact token's T30 book as a witness.
- Meaning: "a real buyer was willing to pay this price for this exact token at
  T30". It is **not** a probability.
- It is **non-circular**: the current T10 ask never defines the maximum we pay.
- It adds **no new pricing constant**; versus the T30 midpoint it carries a built-in
  half-spread cushion.
- WEAK from the T10 book alone has **no** price authority (the current book cannot
  justify its own price) → SKIP.
- No stronger non-circular exact-token authority exists in the repo today (no
  trade carrier, no cross-venue feed, no calibrated model), so T30_BID_ANCHOR_V1
  is chosen.

## 10. TAKER — full-stake VWAP and fee semantics

TAKER is allowed only for **STRONG** references. The order is evaluated at the full
ordinary stake (`QUEUE_DEFAULT_STAKE_USD` = $2.50):

1. hard raw ceiling 0.54 (`QUEUE_MAX_ENTRY_PRICE`) — the ask above it is rejected;
2. fresh, identity-exact T10 book;
3. `best_ask > P_BUY_MAX` → reject (VWAP ≥ best ask, so this is provable without
   the ladder);
4. full-stake raw VWAP over real ask levels at or below `P_BUY_MAX`
   (`fullStakeExecutableVwap`, the same function LIVE_GUARD uses); missing depth
   → reject;
5. fee: the effective cost equals the VWAP only when an authoritative carrier
   proves the taker fee is zero for this order. The repo has **no pre-execution
   fee carrier**, so V1 applies no fee formula and rejects with
   `TAKER_FEE_EVIDENCE_UNAVAILABLE` rather than inventing one.

Safe TAKER ⇔ `TAKER_EFFECTIVE_COST ≤ P_BUY_MAX`. Ranking quantity:
`EXECUTION_PRICE_ADVANTAGE_VS_ANCHOR = P_BUY_MAX − TAKER_EFFECTIVE_COST` (not EV).

Structural consequence: under T30_BID_ANCHOR_V1, TAKER needs the current ask to
have fallen to at or below the T30 bid. On the 72h replay this happened for zero
in-band candidates (ask − P_BUY_MAX was 1–2 cents). TAKER is therefore expected
to be rare.

## 11. MAKER_FIRST price semantics

Allowed for STRONG, or WEAK **with** a T30 price authority:

```
maker_limit = floor_to_valid_tick( min( P_BUY_MAX, current_ask − tick, 0.54 ) )
```

Required: `maker_limit > 0`, `maker_limit < current_ask`, `≤ 0.54`, on the
token's valid tick, before latest entry, no existing exposure. If a
**meaningful** (non-dust, authoritative) best bid is available, additionally
`maker_limit ≥ meaningful_best_bid`; the repo has no such semantics yet, so that
guard is recorded as `NOT_PROVEN` and no dust threshold is invented.

`best_bid + tick` (today's `deriveMakerLimitPrice` for MAKER_FALLBACK_1) is an
**execution placement** formula, not a bettor price authority, and is never used
to set the first-entry maker price.

Real consequence: on the replay, the maker limit (= T30 bid) sat **at** the current
best bid for 8 of 11 feasible candidates and **below** it for 2. The order joins or
sits behind the bid and fills only if a seller crosses to it. That is the price
discipline the anchor buys; it costs fill rate.

## 12. Raw spread — future role

`raw spread > 0.03` is **not** intended to remain a universal business veto once
this policy is active:

- STRONG + wide current spread → decided by price authority + execution rules;
- WEAK + wide spread → MAKER-only;
- UNRESOLVED → SKIP.

0.03 stays as the exact-witness source-quality label inside the reference engine.
No 0.05 / 0.08 / 0.10 threshold is introduced. The runtime LIVE_GUARD 0.03 guard is
unchanged until the money-activation mission explicitly replaces it.

## 13. Action ranking (one action per event)

1. Compute every safe TAKER and every safe MAKER candidate among supported,
   in-band siblings of the reserved event.
2. If any safe TAKER exists → `TAKER_FIRST` with the best TAKER, ordered by
   larger `EXECUTION_PRICE_ADVANTAGE_VS_ANCHOR`, then identity.
3. Else if any safe MAKER exists → `MAKER_FIRST` with the best MAKER, ordered by:
   STRONG before WEAK, larger price cushion (`P_BUY_MAX − maker_limit`), fewer
   ticks to ask, (depth and freshness when carriers exist), then deterministic
   identity (`compareExactIdentity`, side).
4. Else `SKIP`.
5. The best MAKER alternative is **always** reported even when TAKER wins.

No P(fill), no φ weighting, no family priority. "Easier to fill" never beats a worse
price.

## 14. Immutable Queue target contract

Unchanged in V1 and binding for activation: the Queue row freezes the exact
identity (`reservation_id`, `condition_id`, `token_id`, `side`,
`physical_event_id`), stake, price cap and idempotency key. Activation will add the
selected **mode** and the **price authority snapshot** (`P_BUY_MAX`, version,
source observation id) to the frozen target. Nothing downstream may re-select.

## 15. Ireland execution-only boundary

Ireland executes the frozen Queue instruction (`execution_mode`, identity, limit,
stake) and reports results. It makes no selection or price decision. An Ireland
adapter is needed only if the Queue contract gains a mode Ireland does not accept
(`IRELAND_EXPLICIT_EXECUTION_MODE_COMPATIBILITY_V1`).

## 16. Partial / UNKNOWN exposure stop

Any partial fill or UNKNOWN result stops further automated action on that event.
No re-entry or second order is placed until exposure is proven.

## 17. Terminal ZERO → same-token MAKER_FALLBACK_1 only

Only a terminal TAKER_ATTEMPT_1 result that proves zero exposure
(`evaluateMakerEligibility`) may authorize **one** MAKER_FALLBACK_1, on the **same**
token, same stake, never above the frozen cap, before
`min(latest_entry, game_start)`.

## 18. No MAKER_FALLBACK_2

There is no second fallback and no cross-token fallback.

## 19. Post-Queue markout plan

For the selected token only: record the mid / best bid / best ask at +1m, +5m and
+15m after Queue (where the event has not started), so each live decision can be
compared with where the exact market moved.

## 20. Settlement / fee / rebate / net-PnL telemetry

Per filled order: fill price, filled quantity, fee and rebate from the venue
callback (`economicTelemetry.ts` carriers), settlement outcome, and gross and net
PnL. Each must be reconcilable to the frozen Queue identity.

### Telemetry contract the money mission must make reconstructable

all candidates considered → reference status / reasons → price authority source →
`P_BUY_MAX` → TAKER simulation → MAKER simulation → selected token → selected
mode → frozen Queue identity → Ireland attempt → fill / partial / zero / unknown →
fee / rebate → selected-token 1m/5m/15m markouts → settlement → gross / net PnL.

## 21. Explicit unproven assumptions and statistical honesty

- There is **no** calibrated own win probability in V1. CLOB prices are price
  evidence, not oracle truth.
- The Founder's 40–45% win-rate hypothesis is **not** a live input.
- If future settled data shows a 40–45% realised win rate for entries around
  0.50–0.54, the **selection** policy is structurally wrong, and no execution
  tuning can rescue it.
- T30 temporal evidence is not independent-venue evidence.
- The meaningful-best-bid guard is NOT_PROVEN.
- Replay assumptions: before latest entry and no existing exposure (no carrier
  at T10).
- **Execution evidence gap (first blocker):** the T10 capture persists best
  bid/ask only. `tick_size`, `ask_depth_relevant_usd`, `full_stake_executable_vwap`,
  `requested_stake_usd` and `execution_price_cap` columns already exist on
  `reservation_market_observations` but are **null for every T30/T10 row** (72h:
  0/1234 T30, 0/1130 T10). Only LIVE_GUARD populates depth/VWAP, after Queue
  creation. No fee carrier exists before execution.

## 22. Shadow proof (72h natural T10, aggregate-first, read-only)

`scripts/diagnostics/t10EconomicActionPolicyReplay.ts` on 2026-10-02 (24 reservations,
1056 candidate tokens across the four families):

| Measure | Value |
|---|---|
| Reference STRONG / WEAK / UNRESOLVED | 606 / 90 / 360 |
| Price authority available (all / in support band) | 618 / 11 |
| **STRICT** (persisted pre-Queue evidence only) actions | TAKER 0 · MAKER 0 · SKIP 24 reservations |
| **CONDITIONAL** (price proven; tick/ladder/fee resolved at execution) | TAKER 0 · MAKER_FIRST 9 · SKIP 15 reservations |
| Reservations with any conditional action | 9 / 24 |
| B-emulated family-priority pick actionable | 7 / 13 reservations with a pick |
| Reservations where all-sibling policy acts but B pick does not | 2 |
| Persisted T10 B selections (4) under policy | 2 UNRESOLVED → SKIP · 2 STRONG → MAKER |
| Real rank-4 (Under 0.02/0.51) | UNRESOLVED → **SKIP** |
| Raw rows read / ceiling | 59 / 200, SQL↔TS parity mismatches 0 |

All 4 SPREADS picks of the family-priority emulation were non-actionable; the policy
selected TOTALS 8× and MONEYLINE 1×.

## 23. Rollout stages and rollback

1. **SHADOW_POLICY_FREEZE (this)** — pure module + tests + replay + this doc.
2. **T10_EXACT_MARKET_MONEY_ACTIVATION_V1** — (a) persist tick size and full-stake
   ask-ladder VWAP for in-band candidates at T10 capture using the existing
   columns, or evaluate them at LIVE_GUARD before the order; (b) replace the B
   family-priority winner with this policy's single action; (c) freeze mode +
   `P_BUY_MAX` into the Queue target; (d) LIVE_GUARD re-checks
   `TAKER_EFFECTIVE_COST ≤ P_BUY_MAX` or the maker limit at the live book;
   (e) telemetry contract in §20.
3. Optional Ireland execution-mode adapter.
4. One natural-match runtime proof before any widening.

**Rollback**: the activation must be a single switch back to the current B
selector + LIVE_GUARD 0.03 path. Shadow telemetry keeps running either way.
Queue rows already created keep their frozen instruction.

## 24. Implementation and diagnostics

- `lib/executor/exactMarketReference.ts` — reference engine.
- `lib/executor/t10EconomicActionPolicy.ts` — shadow economic action policy.
- `tests/contur3/exactMarketReference.test.ts`, `tests/contur3/t10EconomicActionPolicy.test.ts`.
- `scripts/diagnostics/t10ExactMarketReferenceReplay.ts` — reference replay (exports
  the canonical candidate SQL).
- `scripts/diagnostics/t10EconomicActionPolicyReplay.ts` — counterfactual policy replay.
- Existing runtime touch points (unchanged): `lib/executor/reservationMarketBaseline.ts`
  (capture, B selector, support bands), `lib/executor/eventExecutionQueue.ts`
  (LIVE_GUARD, `fullStakeExecutableVwap`), `lib/executor/makerFallbackAuthorization.ts`
  (MAKER_FALLBACK_1), `lib/executor/executorQueueTypes.ts` (stake, 0.54 cap, 0.03).
