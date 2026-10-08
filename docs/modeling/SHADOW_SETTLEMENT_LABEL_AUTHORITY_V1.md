# SHADOW_SETTLEMENT_LABEL_AUTHORITY_V1

Read-only settlement-authority proof. **Not** ROI, not a model, not a strategy ranking.
Machine-readable twin: `evidence/modeling/shadow_settlement_label_authority_v1.json`.

- Generated 2026-10-08T15:43Z · main `c9d2d28b6976e90d66f30bd28d7f4af583151ead`
- Authority: DBClone `nppznoujvnyjargjkmnv`, read-only SELECT via the Management API. 0 DB writes, production not queried, 0 network settlement calls.
- Observation snapshot: `reservation_market_observations.created_at <= 2026-10-08T14:00Z` = 20,384 rows / 216 events, identical to the frozen `RESEARCH_CORPUS_AUTHORITY_V1`.

## Verdict

**`SHADOW_SETTLEMENT_LABEL_AUTHORITY = READY_PARTIAL_COVERAGE`**

The label semantics are trustworthy and bet/no-bet-independent. Coverage is low because the persisted terminal source mostly does not reach the observation corpus.

| Gate | Result |
|---|---|
| Settlement source proven | PASS |
| Latest-state rule deterministic | PASS |
| `AMBIGUOUS_WINNER_CONDITION_N = 0` | PASS |
| Executed cross-check, zero mismatch | PASS (9/9) |
| `NO_SETTLEMENT_LEAKAGE` | PASS |
| No network needed for persisted resolved conditions | PASS |

## 1. Label source (code trace)

- **Creator**: `scripts/modeling/materialize-research-model-ready.ts` writes `research_model_ready_rows` via `lib/research-clone/modelReady.ts` (`settlement_label = row.labelAsOf`).
- **Per-row label**: `deriveLabel()` in `lib/modeling/forward-rich/materializeForwardRichResearch.ts` — Gamma terminal state WIN/LOSS/VOID, absent state = OPEN, broken identity = NO_MATCH. Clone `signal_result` is never consulted.
- **Cross-partition**: `asOfLabel()` in `lib/modeling/research-corpus/rollingCorpus.ts` — a fresh terminal label replaces anything; a terminal frozen label is never replaced by a non-terminal one. `applyMonotonicSettlementGuard` (materializer) refuses terminal → non-terminal on rerun.
- **Underlying terminal truth**: Gamma terminal event state (`RESEARCH_CORPUS_CONTRACT.md` §5.2), persisted before this mission.
- **Selection frozen before settlement**: yes. Features, `decisionAt` and `frozenLabel` are immutable; only `labelAsOf` moves (rollingCorpus `ScorecardReadyRow` doc, contract §5.1).
- **Meanings**: WIN/LOSS = selected token wins/loses at terminal; VOID = explicit cancelled/refund (none persisted); OPEN = no terminal state persisted.

```
SETTLEMENT_SOURCE = Gamma terminal event state, persisted as research_model_ready_rows.settlement_label (labelAsOf)
LATEST_AUTHORITY_ORDER = per (provider_event_id, condition_id, token): terminal WIN/LOSS/VOID is sticky over OPEN; terminal ties by model_date, decision_at, created_at desc
SELECTION_BEFORE_SETTLEMENT = PASS
```

## 2. Condition-level authority (key: provider_event_id + condition_id)

No token has conflicting terminal labels (0), so the rule is order-independent.

| Condition status | N |
|---|---:|
| Conditions | 45,936 |
| `UNIQUE_WINNER` | 20,820 |
| `OPEN` | 13,201 |
| `VOID` | 0 |
| `AMBIGUOUS` | **0** |
| `LOSS_ONLY` (terminal LOSS token, no persisted winner) | 11,915 |

Naive exact-token latest-wins would be wrong in one respect: 964 tokens have a terminal row followed by a later OPEN row. The sticky rule handles them; none touches the observed corpus.

## 3. Observed identities

Identity = distinct `physical_event_id + provider_event_id + condition_id + token_id + canonical_market_type`. T30/T10/T3/LIVE_GUARD repeats are collapsed.

| | N |
|---|---:|
| Physical events | 216 |
| **Identities** | **9,722** |
| WIN | 225 |
| LOSS | 289 (225 via condition winner + 64 via the exact token's own terminal LOSS in LOSS_ONLY conditions) |
| VOID | 0 |
| OPEN | 294 |
| UNRESOLVED | 8,914 (8,708 condition not in model_ready · 142 null provider_event_id · 64 other tokens of LOSS_ONLY conditions) |
| **Terminal-labelable identities** | **514 (5.29%)** |

Events (best status, hierarchy terminal > open > unresolved): 152 terminal / 33 open / 31 unresolved = 216. **No event is fully labelled**; "terminal event" means ≥1 labelled identity.

## 4. Market-family coverage

| Family | Events | Identities | Terminal events | Terminal identities | Open events | Unresolved events | Coverage % |
|---|---:|---:|---:|---:|---:|---:|---:|
| MONEYLINE | 198 | 1,188 | 39 | 74 | 17 | 142 | 6.23 |
| TOTAL | 197 | 3,546 | 72 | 131 | 30 | 95 | 3.69 |
| SPREAD (**SETTLEMENT_ANALYTICALLY_QUARANTINED**, not lifted) | 197 | 3,940 | 104 | 301 | 31 | 62 | 7.64 |
| OTHER_STRUCTURED | 6 | 272 | 0 | 0 | 0 | 6 | 0 |
| UNKNOWN (null type) | 142 | 776 | 2 | 8 | 2 | 138 | 1.03 |

`TOTAL_CORNERS_STATUS = SOURCE_SAMPLE_ABSENT`. Identities sum to 9,722; terminal identities to 514.

## 5. No-bet coverage (main business result)

Actual execution = ledger row with `exchange_order_id` and status FILLED/WON/LOST, joined by exact `(condition_id, token_id)` → queue → reservation → `physical_event_id` (never inferred from SELECTED or reservations). 29 events executed, **187 not**.

| | Events |
|---|---:|
| `NO_BET_OBSERVED_EVENT_N` | 187 |
| `NO_BET_TERMINAL_LABELABLE_EVENT_N` | **131** |
| `NO_BET_OPEN_EVENT_N` | 29 |
| `NO_BET_UNRESOLVED_EVENT_N` | 27 |
| `NO_BET_TERMINAL_LABEL_COVERAGE_PCT` | **70.05** |
| `NO_BET_MONEYLINE_LABELABLE_EVENT_N` | 33 (of 170) |
| `NO_BET_TOTAL_LABELABLE_EVENT_N` | 60 (of 169) |

So the no-bet population is labelable (131 events), but at the identity level the labelled share is ~5%. Economics must work per labelled identity.

## 6. Executed-bet witness

Ledger `raw_order.settlement_v1.winning_token_id` vs the derived condition winner:

```
EXECUTED_SETTLED_COMPARABLE_N = 9
WINNER_MATCH_N = 9
WINNER_MISMATCH_N = 0
EXECUTED_SETTLEMENT_CONSISTENCY = PASS
```

Additional: 0 persisted LOSS tokens equal a ledger winner, 0 persisted WIN tokens differ from one. Of 27 settled executed bets, 18 are not comparable (5 LOSS_ONLY, 2 OPEN in model_ready, 11 conditions absent from model_ready). The comparable set is small; the 0 mismatch is strong but not large-sample.

## 7. Temporal safety — `NO_SETTLEMENT_LEAKAGE = PASS`

- Identities are enumerated from `reservation_market_observations` alone; labels are LEFT-joined afterwards (9,722 identities in, 9,722 labelled rows out; OPEN/UNRESOLVED stay in the denominator).
- No selection, eligibility, phase or timing predicate reads a label.
- Executed bets are a witness, never a label source.
- Downstream `SELECTION_BEFORE_SETTLEMENT_V1`: decision-time candidate → decision-time-only filter → join label → OPEN stays in sample accounting.

## 8. Known limitations

- **Coverage is a data limitation**: 8,708 identities sit in conditions `research_model_ready_rows` never materialized (its `model_date` ends 2026-10-07 and it is the legacy signal-population space). `generated_signal_pairs.signal_result` adds 0 labels for them, so only new settlement ingestion would raise coverage.
- **OPEN is an upper bound**: model_ready lags the ledger (both executed bets in OPEN conditions are already settled in the ledger: 1 WON, 1 LOST).
- VOID = 0 is absence of persisted evidence, not proof that none occurred.
- 64 LOSS labels rely on exact-token terminal LOSS without a persisted winner. Strict winner-only reading: LOSS 225, terminal 450 (4.63%).
- 142 identities (LIVE_GUARD / null `provider_event_id`) cannot be keyed; 34,555 of 114,026 model_ready rows have null `provider_event_id`.
- SPREAD quarantine is unchanged.

## Next

`NEXT = COUNTERFACTUAL_ECONOMICS_GATE_V1` · `NEXT_2 = INPLAY_MULTI_DAY_MECHANISM_GATE_V1`
