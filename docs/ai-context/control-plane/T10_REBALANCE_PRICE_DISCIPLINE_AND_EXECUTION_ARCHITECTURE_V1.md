# T10_REBALANCE_PRICE_DISCIPLINE_AND_EXECUTION_ARCHITECTURE_V1

**Status: DESIGN_SHADOW — MONEY_PATH_ACTIVE=NO.**
Nothing in Queue, TAKER, MAKER, maker fallback, LIVE_GUARD, Ireland, Reservation, stake (`$2.50`) or the `0.54` cap reads the policy described here. This document freezes the design that one later, separately authorised mission (`T10_EXACT_MARKET_MONEY_ACTIVATION_V1`) may activate.

Evidence class of every number below: **shadow replay on recorded data, not runtime money proof.**

## 0. Statistical honesty (frozen)

- There is **no calibrated internal live win-probability model** in V1.
- The Polymarket CLOB is **price evidence, not oracle truth**.
- T30 and T10 observations are the **same venue at different times**. They are not independent venues, and two agreeing T30/T10 books are not a second opinion.
- The Founder 40–45% win-rate hypothesis is **not an execution input** anywhere.
- If the future settled win rate for entries around 0.50–0.54 is truly 40–45%, the selection policy is **structurally negative** (break-even needs roughly 50–54%) and no amount of execution optimisation can repair it. Execution discipline can only stop paying more than a defensible anchor; it cannot create edge.

## 1. Physical-event Reservation semantics

One `night_event_reservations` row is one **physical event** (`physical_event_id`). One physical event may carry **at most one economic exposure** (section 17). Everything below is evaluated inside one Reservation's capture lineage. A policy input that spans two `physical_event_id`s is refused (`T10_POLICY_MULTIPLE_PHYSICAL_EVENTS`).

## 2. T30 / T10 capture semantics

`reservation_market_capture_runs` + `reservation_market_observations`, written by `lib/executor/reservationMarketBaseline.ts`:

| Phase | Window (minutes before start) | Role |
|---|---|---|
| `T_MINUS_30` | (20, 30] | **Temporal anchor** evidence (section 8) |
| `T_MINUS_10` (`FINAL_REBALANCE_PHASE`) | (9, 15] | **Current** book at decision time |
| `LIVE_GUARD` | after Queue | Post-Queue; carries `full_stake_executable_vwap` and `ask_depth_relevant_usd`. **Not** available pre-Queue |

A capture counts only if the run is complete (`capture_complete` and `capture_status = COMPLETE`), the fetch is `SUCCESS`, and the observation falls in its phase window (`classifyReservationMarketPhase`).

**Gap that blocks activation (section 25):** `T10` and `T30` observation rows persist `best_bid`, `best_ask`, `spread_abs`, but `ask_depth_relevant_usd = NULL`, `tick_size = NULL`, `minimum_order_size = NULL`, and no ask ladder and no fee.

## 3. Supported full-match sibling universe

Families: `SPREADS`, `TOTAL_CORNERS`, `MONEYLINE`, `TOTALS`. The full complete T10 sibling universe of the reserved physical event competes. A candidate is one exact token: `(physical_event_id, condition_id, token_id, side)`.

## 4. Support bands (unchanged V1 boundaries)

Bands live in `bStrategySupportRegion` (`reservationMarketBaseline.ts`) and are expressed on `ask_decimal_odds`:

| Family | Odds band | Price equivalent |
|---|---|---|
| SPREADS | 1.85–2.00 | ≈ 0.50–0.54 |
| TOTAL_CORNERS | 2.25–2.50 | ≈ 0.40–0.444 |
| MONEYLINE | 1.85–2.00 | ≈ 0.50–0.54 |
| TOTALS | 1.85–2.00 | ≈ 0.50–0.54 |

This only answers **candidate authority** ("may this token compete?"). It is not price authority.

## 5. Family priority is not the economic winner

The current B selector walks `SPREADS → TOTAL_CORNERS → MONEYLINE → TOTALS` and takes the first family with any qualifying token, then one token, then applies a raw spread veto. That ordering is **no longer intended to decide the economic winner**. In the shadow policy all eligible siblings compete on price discipline and execution evidence (section 16); family is not a ranking key.

## 6. STRONG / WEAK / UNRESOLVED (from `exactMarketReference`, PR #453)

| Status | Meaning (frozen) |
|---|---|
| STRONG | ≥ 2 usable, non-duplicate, identity-exact temporal book witnesses (T30 and T10) whose `[best_bid, best_ask]` intervals overlap |
| WEAK | exactly 1 usable exact witness |
| UNRESOLVED | no defensible exact-market price evidence (0 witnesses, identity inconsistency, or conflicting witnesses) |

A usable witness is a complete run, `SUCCESS` fetch, in-window, two-sided, spread ≤ `LIVE_EXECUTION_MAX_SPREAD` (0.03). **That 0.03 is a source-quality label inside the reference engine** — it is not introduced as a new business threshold. These statuses are **never** win probabilities.

## 7. Binary complement mirror rule

The other token of the same `condition_id` is the mirror of the same CLOB. It is **diagnostic only**: never a witness, never upgrades WEAK→STRONG, never a price source. Planning prices of a sibling market, and other lines or families, are not point-price authority either. Recent trade data has no authoritative carrier today (`SOURCE_UNAVAILABLE`); no ingestion is built here.

## 8. T30 temporal exact-token evidence

The price authority uses exactly one thing: an identity-exact, usable **T30 book of the same token** (checked by calling the canonical engine on that single witness, so the same capture/window/quality rules apply). A mirror, a sibling, or an unusable T30 book yields **no** anchor. No anchor means no price and therefore no action.

## 9. Chosen price authority version

`PRICE_AUTHORITY_VERSION = T30_EXACT_BID_ANCHOR_V1`

Rationale: "at T30, a real market participant was bidding this exact token at this price." It is non-circular: it does not derive a price from the current T10 ask or from the current CLOB mid.

## 10. P_BUY_MAX meaning and exact formula

```
P_BUY_MAX_RAW = T30 exact-token best_bid        (identity-exact, usable T30 witness only)
P_BUY_MAX     = min(P_BUY_MAX_RAW, 0.54)         (0.54 = QUEUE_MAX_ENTRY_PRICE)
```

No further margin or constant is subtracted in V1. Using the prior best bid already gives a conservative, executable-side anchor.

## 11. P_BUY_MAX is NOT true probability

`P_BUY_MAX != true probability`. It is also **not** +EV proof, **not** second-venue consensus, and **not** a fair value. It is the highest price this policy will pay for that exact token, anchored on earlier same-venue bid evidence.

## 12. TAKER target semantics (full-stake VWAP and fee)

For a STRONG candidate with a valid `P_BUY_MAX`, simulate the full ordinary stake (`$2.50`, `QUEUE_DEFAULT_STAKE_USD`):

- walk the **cap-eligible ask ladder** (levels ≤ 0.54) for the whole stake → `rawVwap`; never approximate with `bestAsk`;
- `netShares = stake / rawVwap`; `effectiveCost = (stake + feeUsd) / netShares`;
- fee must be **authoritative evidence**, never assumed zero (`TAKER_FEE_EVIDENCE_MISSING`);
- safe TAKER only if exact identity, fresh T10 book, `rawVwap ≤ 0.54`, full-stake depth, before latest-entry, no exposure, and `effectiveCost ≤ P_BUY_MAX`;
- `EXECUTION_PRICE_ADVANTAGE_VS_ANCHOR = P_BUY_MAX − effectiveCost` (**not** EV).

Missing ladder → `TAKER_EXECUTION_EVIDENCE_MISSING`. WEAK is never TAKER.

## 13. MAKER_FIRST price formula

```
maker_limit = floor_to_valid_tick( min( P_BUY_MAX, current_T10_ask - tick, 0.54 ) )
```

Required: `maker_limit > 0`, `maker_limit < current ask`, `maker_limit ≤ 0.54`, valid tick, before latest-entry, no exposure, exact identity frozen. Eligible: STRONG, or WEAK with a valid prior exact-token anchor. If an authoritative "meaningful best bid" is supplied, `maker_limit ≥ meaningful_best_bid` is required; **if it cannot be proven the guard is recorded as `NOT_PROVEN`** (no dust threshold is invented). Unknown tick → `TICK_UNKNOWN`, never an assumed tick.

## 14. Old `bestBid + tick` is a semantic defect

The existing maker fallback derivation (`lib/executor/makerFallbackAuthorization.ts`, `deriveMakerLimitPrice`) prices a BUY at `best_bid + one valid tick`. That is bettor-queue-jumping semantics: its price is whatever the current book bid is, so it has **no price authority at all** — a bid collapsed to 0.02 yields a 0.03 order, a stale or manipulated bid yields whatever follows. It must not be the price authority. In the shadow policy the limit is bounded by `P_BUY_MAX` (prior exact evidence) and by `ask − tick`. The existing module is not edited by this mission.

## 15. Spread: future role (design only; runtime untouched)

The runtime spread guard is unchanged. Frozen future intent: a spread above 0.03 is **not** a universal business veto once usable reference and price authority exist.

| Reference | Wide current spread |
|---|---|
| STRONG | economic price/execution rules decide |
| WEAK | MAKER_ONLY |
| UNRESOLVED | SKIP |

0.03 remains source-quality semantics inside `exactMarketReference`. No 0.05 / 0.08 / 0.10 is introduced.

## 16. Token and action ranking

Per physical event, one final action:

```
IF any SAFE_TAKER  -> best SAFE_TAKER   (TAKER_FIRST)
ELSE IF any SAFE_MAKER -> best SAFE_MAKER (MAKER_FIRST)
ELSE SKIP
```

- **TAKER ranking:** larger positive `EXECUTION_PRICE_ADVANTAGE_VS_ANCHOR` → stronger execution evidence (more witnesses, tighter reference uncertainty) → depth → freshness → deterministic identity (`condition_id|token_id|side`).
- **MAKER ranking:** STRONG before WEAK → larger cushion vs anchor (`P_BUY_MAX − maker_limit`) → fewer ticks to current ask → depth → freshness → identity. Fillability never outranks price discipline.
- No P(fill), no `phi = 0.5`, no synthetic fill probability anywhere.
- Even when TAKER wins, the best shadow Maker alternative is retained for later calibration.

## 17. One physical event = one economic exposure

A candidate set is one `physical_event_id`; exactly one action (or SKIP) comes out. Existing exposure on the event forces SKIP.

## 18. Immutable future Queue contract (not implemented here)

Once selected, the Queue row must freeze: **exact token** (`condition_id`, `token_id`), **side**, **execution mode** (`TAKER_FIRST` | `MAKER_FIRST`), **price authority** (version, source, `P_BUY_MAX`, T30 observation id), **stake**, **deadline** (latest-entry). Nothing downstream may re-select a different token or silently change mode.

## 19. Ireland is execution-only

Ireland executes the frozen Queue contract. It does not choose tokens, price authority or mode. An Ireland adapter is needed only if the released Queue contract carries an explicit execution mode Ireland cannot already consume.

## 20. TAKER partial / positive / UNKNOWN → no second bet

If a TAKER attempt ends with a partial fill, any positive fill, or an UNKNOWN outcome, there is **no second bet** on that physical event.

## 21. Terminal ZERO → one same-token MAKER_FALLBACK_1 only

Only an **authoritative terminal ZERO** fill permits one `MAKER_FALLBACK_1`, on the **same token**, priced by the same Maker formula (never a new token, never `bestBid + tick`).

## 22. No MAKER_FALLBACK_2

There is no second maker fallback.

## 23. Markout plan (selected token only, after Queue)

Record the selected token's price at **1 min, 5 min and 15 min** after the decision/fill, where feasible. Not collected for non-selected candidates.

## 24. Telemetry contract frozen for the next mission

The activation mission must keep enough data to reconstruct: authorized physical event → all candidates → support eligibility → reference grade and reasons → price authority source → `P_BUY_MAX` → TAKER simulation → MAKER simulation → selected token → selected mode → Queue frozen identity → Ireland attempt → full/partial/zero/unknown → fees/rebate → selected-token 1m/5m/15m markouts → settlement → gross and net PnL. Fee, rebate, fill and settlement must be recorded so net PnL is computable.

## 25. Unproven assumptions and the first remaining blocker

1. **T10 persists no ask ladder, depth, fee or tick.** Consequence on recorded data: 100% of STRONG candidates with an anchor are `TAKER_EXECUTION_EVIDENCE_MISSING`; Maker is `TICK_UNKNOWN` unless a tick is supplied. The tick exists at order time (the maker fallback reads `tick_size` from the live book) but is not persisted at T10. **Activation needs an authoritative pre-Queue tick, ladder and fee carrier, or a decision to read them live inside the activation mission.**
2. "Meaningful best bid" semantics are not proven (`NOT_PROVEN`).
3. Latest-entry and exposure state are not in the T10 tables; the replay assumes `beforeLatestEntry = true`, `exposureExists = false`.
4. The anchor equals the T30 bid, which is close to the T10 bid, so in every simulated Maker case the limit equalled the anchor (cushion 0). The Maker therefore rests **at the bid**, and the policy has no evidence about its fill rate. Fill rate is unknown by design; it is the reason maker alternatives are retained for calibration.
5. TAKER is structurally rare under this anchor: it needs the ask to fall to or below the prior bid. On the 72h replay 0 reservations had `best_ask ≤ P_BUY_MAX` for any STRONG candidate.
6. Only 27 reservations / 3 days were available; the coverage numbers below are small-sample.
7. The anchor is not +EV evidence (section 0).

## 26. Rollout sequence

1. This mission: shadow module, tests, replay, document (merged first, no behavior change).
2. `T10_EXACT_MARKET_MONEY_ACTIVATION_V1`: one bounded PREMVP mission — resolve the evidence-carrier gap (item 25.1), wire the policy, freeze the Queue contract (section 18), still gated.
3. `IRELAND_EXPLICIT_EXECUTION_MODE_COMPATIBILITY_V1` only if the released Queue contract needs it.
4. One natural-match live proof.

## 27. Rollback semantics

Until activation nothing needs rollback: this change adds files only, and reverting the merge commit removes it. After activation the policy must sit behind a single switch that restores the previous selector and the existing LIVE_GUARD path, with no schema rollback required for the shadow telemetry.

## 28. Relevant paths

| Role | Path |
|---|---|
| Reference engine (PR #453) | `lib/executor/exactMarketReference.ts` |
| Economic action policy (this mission) | `lib/executor/t10EconomicActionPolicy.ts` |
| Reference tests | `tests/contur3/exactMarketReference.test.ts` |
| Policy tests | `tests/contur3/t10EconomicActionPolicy.test.ts` |
| Reference replay | `scripts/diagnostics/t10ExactMarketReferenceReplay.ts` |
| Policy replay | `scripts/diagnostics/t10EconomicActionPolicyReplay.ts` |
| Support bands, capture, B selector | `lib/executor/reservationMarketBaseline.ts` |
| Stake / cap / spread constants | `lib/executor/executorQueueTypes.ts` |
| Old maker price derivation (defect, not edited) | `lib/executor/makerFallbackAuthorization.ts` |
| State pointer | `docs/ai-context/control-plane/CURRENT_STATE.yaml` → `rebalance_execution_architecture` |

## 29. SHA and PR lineage known at this stage

| Item | SHA / ref |
|---|---|
| main before PR #453 | `5a2e78eb0090741ae363e242cf4cdd3e9ce11642` |
| PR #453 head (reference shadow engine) | `8c6e9c2fe865022d846c40e3e7e910eb2ae8a4f2` |
| main after PR #453 (merge commit) | `ef6ad01c783de306ae1b3010312a573a10dbff08` |
| This mission's base | `ef6ad01c783de306ae1b3010312a573a10dbff08` |
| This mission's result SHA | recorded in the PR / completion envelope (a commit cannot embed its own SHA) |

## Appendix A — shadow replay result (72h natural T10, recorded data)

Window: 27 reservations, 27 complete T10 runs, 27 matched T30 runs. All numbers are from `scripts/diagnostics/t10EconomicActionPolicyReplay.ts` (read-only, aggregate-first). Cumulative raw rows read across all runs of this mission: **189 of the 200 ceiling** (the script's own per-run counter is shown in each run).

| Measure | Value |
|---|---|
| All four-family candidates: STRONG / WEAK / UNRESOLVED | 606 / 90 / 360 |
| Support-eligible candidates (in band): STRONG / WEAK / UNRESOLVED | 11 / 1 / 6 |
| Price authority available / missing (support-eligible) | 12 / 6 |
| Missing-anchor reasons | T30 spread above source quality 3, T30 one-sided 2, no T30 witness 1 |
| Authoritative-evidence run (tick unknown): TAKER / MAKER / SKIP per reservation | 0 / 0 / 27 (Maker `TICK_UNKNOWN` on 11 tokens) |
| Sensitivity, tick 0.01 **(assumed, not authoritative)**: TAKER / MAKER / SKIP | 0 / 9 / 18 |
| Sensitivity, tick 0.001 **(assumed, not authoritative)**: TAKER / MAKER / SKIP | 0 / 9 / 18 |
| Reservations with a safe action vs. current B selected nothing | 7 of 9 |
| Current B selected tokens / UNRESOLVED / safe under this policy | 4 / 2 / 2 |
| Event winners by family (sensitivity) | TOTALS 8, MONEYLINE 1, SPREADS 0, TOTAL_CORNERS 0 (no corners token in band) |
| Taker upper bound (STRONG, `best_ask ≤ P_BUY_MAX`) | 0 |
| SQL ↔ TypeScript policy parity on detail rows | 0 mismatches |

**Rank-4 case** (`clf-twe-svw-2026-10-02-total-2pt5`, Under): T10 0.02/0.51, T30 0.02/0.52, Over mirror 0.49/0.98 → reference UNRESOLVED, price authority unavailable (`T30_WITNESS_REJECTED:BOOK_SPREAD_ABOVE_SOURCE_QUALITY`), `P_BUY_MAX = null`, **SKIP**. An ask ≤ 0.54 alone does not make it an action.

Interpretation: price authority creates real action coverage (about a third of reservations) and finds actions on events where the old B priority selected nothing, but the coverage is conditional on a tick the data does not carry, and the TAKER branch is unsimulable on current data. Do not read the 9/27 figure as QueueRate or PnL.
