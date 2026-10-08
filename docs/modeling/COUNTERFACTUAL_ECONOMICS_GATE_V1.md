# COUNTERFACTUAL_ECONOMICS_GATE_V1

Read-only business economics gate. **Not** a model, not alpha proof, not a live-policy change.
Machine-readable twin: `evidence/modeling/counterfactual_economics_gate_v1.json`.

- Generated 2026-10-08T18:45Z · main `eaab6b788811a3ab456cc33a37b876839916bdfa`
- Authority: DBClone `nppznoujvnyjargjkmnv`, read-only SELECT via the Management API. 0 DB writes, production not queried, 0 network settlement calls.
- Snapshot: `reservation_market_observations.created_at <= 2026-10-08T14:00Z` (frozen 216-event corpus).
- Inputs: `RESEARCH_CORPUS_AUTHORITY_V1`, `SHADOW_SETTLEMENT_LABEL_AUTHORITY_V1` (READY_PARTIAL_COVERAGE, 5.29% identity coverage).

## Verdict

```
QUALIFYING_CELL_N = 0
SUFFICIENT_CELL_N = 0
COUNTERFACTUAL_ECONOMICS_VERDICT = INSUFFICIENT_SETTLED_EXECUTABLE_SAMPLE
PREMATCH_FORWARD_SHADOW_READY = NO
MAKER_COUNTERFACTUAL_STATUS = NOT_EVALUABLE_FILL_AUTHORITY_ABSENT
T30_EXECUTABLE_ECONOMICS = NOT_EVALUABLE_HISTORICAL_EXECUTION_EVIDENCE_ABSENT
NEXT = INPLAY_MULTI_DAY_MECHANISM_GATE_V1
```

No frozen cell reaches the sufficiency gate (best cell: 8 terminal events, 2 settled dates, 19.5% coverage; gate needs 20 / 4 / 30%). The economic gate is therefore not evaluated. The signed PnL in the table is descriptive only; it is **not** evidence for or against an edge. No settlement ingestion, Gamma backfill or telemetry table is proposed; the roadmap moves to in-play.

## Selection contract (selection before settlement)

1. Enumerate every decision-time executable candidate: soccer (`research_evidence_page_rows.provider_sport_family`), `canonical_market_type` MONEYLINE/TOTAL, `T_MINUS_10`, `T10_EXECUTABLE_SIBLING_TELEMETRY_V1`, fetch SUCCESS, `executable_full_stake`, stake > 0, VWAP/shares/fee non-null, `taker_fee_state=KNOWN`. No best-ask/mid substitution.
2. Bucket by actual `minutes_to_start` (T_09_15, T_15_21) and `full_stake_executable_vwap` (P_05_20 … P_80_95).
3. Rank per physical_event × family × time × price bucket by `spread_abs` ASC NULLS LAST, `ask_depth_relevant_usd` DESC NULLS LAST, `condition_id`, `token_id`, `side` (then `observed_at`, `id` as pure tie-break); freeze rank 1.
4. Only then LEFT JOIN the settlement label (condition winner / exact-token terminal; OPEN and UNRESOLVED stay in the denominator) and the actual-execution lineage (no-bet slice).

Economics: WIN net = shares − stake − fee; LOSS net = −stake − fee; ROI = net / requested stake × 100. VOID = 0 selected, so no refund semantics were needed.

## Secondary totals (non-gating)

| | N |
|---|---:|
| SOCCER_T10_EXECUTABLE_CANDIDATE_EVENT_N | 52 |
| MONEYLINE / TOTAL events | 52 / 52 |
| Candidate rows before selection | 610 (0 outside time buckets; 149 below 0.05, 0 above 0.95) |
| Selected candidates | 246 over 52 events (MONEYLINE 96, TOTAL 150) |
| Terminal selected | 16 candidates / 15 events |
| Selected settlement coverage | 6.5% candidate-level · 28.85% event-level |
| Open / unresolved / void | 21 / 209 / 0 |
| No-bet selected candidates | 137 |

Candidate rows by price bucket: {"P_20_40": 200, "OUT": 149, "P_05_20": 183, "P_40_60": 78} · by time bucket: {"T_15_21": 514, "T_09_15": 96}. P_60_80 and P_80_95 have no candidates (every in-range executable VWAP is below 0.60).

## Primary cells (populated 12 of 20; the other 8 have zero candidates)

Dates are Europe/Minsk. "Dates" = positive/negative/settled. No MONEYLINE/TOTAL pooling.

| Family | Time | Price | Cand ev | Term ev | Open | Unres | Cov % | W/L | Stake $ | Fee $ | Net $ | ROI % | Median $ | Dates +/−/settled | NB cand | NB term | NB net $ | NB ROI % | Gate |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|
| MONEYLINE | T_09_15 | P_05_20 | 1 | 0 | 0 | 1 | 0.0 | 0/0 | 0.0 | 0.0 | – | – | – | 0/0/0 | 1 | 0 | – | – | INSUFFICIENT |
| MONEYLINE | T_09_15 | P_20_40 | 8 | 0 | 0 | 8 | 0.0 | 0/0 | 0.0 | 0.0 | – | – | – | 0/0/0 | 8 | 0 | – | – | INSUFFICIENT |
| MONEYLINE | T_09_15 | P_40_60 | 6 | 1 | 0 | 5 | 16.67 | 0/1 | 2.5 | 0.0625 | -2.5625 | -102.5 | -2.5625 | 0/1/1 | 6 | 1 | -2.5625 | -102.5 | INSUFFICIENT |
| MONEYLINE | T_15_21 | P_05_20 | 19 | 0 | 1 | 18 | 0.0 | 0/0 | 0.0 | 0.0 | – | – | – | 0/0/0 | 7 | 0 | – | – | INSUFFICIENT |
| MONEYLINE | T_15_21 | P_20_40 | 39 | 1 | 3 | 35 | 2.56 | 0/1 | 2.5 | 0.0862 | -2.5863 | -103.45 | -2.5863 | 0/1/1 | 20 | 0 | – | – | INSUFFICIENT |
| MONEYLINE | T_15_21 | P_40_60 | 23 | 2 | 4 | 17 | 8.7 | 1/1 | 5.0 | 0.112 | 0.5698 | 11.4 | 0.2849 | 1/0/1 | 12 | 1 | 3.1118 | 124.47 | INSUFFICIENT |
| TOTAL | T_09_15 | P_05_20 | 8 | 0 | 0 | 8 | 0.0 | 0/0 | 0.0 | 0.0 | – | – | – | 0/0/0 | 8 | 0 | – | – | INSUFFICIENT |
| TOTAL | T_09_15 | P_20_40 | 8 | 1 | 1 | 6 | 12.5 | 0/1 | 2.5 | 0.0775 | -2.5775 | -103.1 | -2.5775 | 0/1/1 | 8 | 1 | -2.5775 | -103.1 | INSUFFICIENT |
| TOTAL | T_09_15 | P_40_60 | 6 | 2 | 0 | 4 | 33.33 | 1/1 | 5.0 | 0.13 | 0.0783 | 1.57 | 0.0392 | 1/0/1 | 6 | 2 | 0.0783 | 1.57 | INSUFFICIENT |
| TOTAL | T_15_21 | P_05_20 | 43 | 1 | 1 | 41 | 2.33 | 0/1 | 2.5 | 0.1025 | -2.6025 | -104.1 | -2.6025 | 0/1/1 | 20 | 0 | – | – | INSUFFICIENT |
| TOTAL | T_15_21 | P_20_40 | 44 | 0 | 3 | 41 | 0.0 | 0/0 | 0.0 | 0.0 | – | – | – | 0/0/0 | 21 | 0 | – | – | INSUFFICIENT |
| TOTAL | T_15_21 | P_40_60 | 41 | 8 | 8 | 25 | 19.51 | 1/7 | 20.0 | 0.545 | -15.545 | -77.72 | -2.5669 | 1/1/2 | 20 | 1 | -2.575 | -103.0 | INSUFFICIENT |

All cells are `INSUFFICIENT` (terminal < 20, settled dates < 4, and coverage < 30% in all but one cell). The no-bet columns are a robustness slice only; no cell has the ≥10 no-bet terminal events the signal gate needs.

## Validation

- Selection before settlement: PASS. The ranking window contains no label or PnL column, and settlement/ledger joins read the frozen selection.
- One physical event maximum per cell: PASS (0 duplicate groups).
- terminal + open + unresolved (+ void) = candidate_event_n, and wins + losses = terminal_event_n: PASS in all 12 cells.
- no-bet terminal ≤ terminal: PASS. No SPREAD / TOTAL_CORNERS in primary cells: PASS.
- Label reimplementation check: re-deriving labels over all 9,722 observed identities reproduces the frozen authority exactly (WIN 225 / LOSS 289 / VOID 0 / OPEN 294 / UNRESOLVED 8,914).
- Arithmetic reconciled (net = wins·(shares−stake) − losses·stake − fees).

## Limitations

- Only 52 soccer events carry T10 full-stake fee-complete telemetry (first seen 2026-10-05, 4 event days); the executable lane is the binding constraint, not the price buckets.
- Selected-candidate settlement coverage is 6.50% (16/246) and 28.8% at event level; 209 of 246 selected candidates are UNRESOLVED because their conditions are absent from research_model_ready_rows. Settlement ingestion is deliberately NOT proposed by this mission.
- No cell reaches 20 terminal events (max 8); no cell has >=4 settled dates (max 2). The economics gate is therefore not evaluated; the small signed PnL numbers in insufficient cells are descriptive only and not evidence of edge or lack of edge.
- P_60_80 and P_80_95 have zero decision-time candidates: every in-range executable VWAP is below 0.60, and 149 rows fall below 0.05 (outside the declared range).
- LOSS labels include 64-identity exact-token LOSS-only authority inherited from the settlement authority; VOID_N=0 is absence of persisted evidence.
- Taker only; MAKER and T30 are not evaluable. A passing cell would never have meant proven alpha or live authorization.
