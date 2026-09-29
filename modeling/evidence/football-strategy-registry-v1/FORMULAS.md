# Frozen economic formulas — football strategy registry v1.0.0

Contract: BETTING_ECONOMICS_CONTRACT_V2 / SELECTION_BEFORE_SETTLEMENT_V1. REFERENCE_PNL / NOT_EXECUTION_AUTHORITY.

- Flat stake: 1u per settled bet.
- decimal_odds = 1 / entry_price
- WIN: pnl_u = 1 / entry_price - 1
- LOSS: pnl_u = -1
- OPEN / nonterminal (OPEN, VOID, NO_MATCH, AMBIGUOUS) / invalid identity: NOT a loss; no settled-P&L contribution; excluded from SETTLED_N.
- SETTLED_N = WINS + LOSSES
- ROI_PCT = 100 * PNL_U / SETTLED_N (every settled bet stakes 1u)
- MaxDD: chronological (decisionTimestamp, then physicalEventKey) cumulative settled-P&L drawdown, reported negative.
- Bets/day = SELECTED_N / calendar days in the common window (2026-08-04..2026-09-24).
- Selection: the predicate is applied BEFORE settlement; rows are processed chronologically; the first qualifying row claims the physicalEventKey, so one physical event yields at most one economic bet per strategy; exact condition/token identity; no settlement or result information influences membership.
- Price bands use entry_price: lower bound inclusive, upper bound exclusive unless stated; odds-bucket strategies use [min, max) on 1/entry_price.
- Common settlement: research_model_ready_rows.settlement_label attached by exact (condition_id, selected_token_id, decision_at), identical for every strategy. No strategy-specific backfill.

Implementation: `scripts/modeling/football-strategy-registry.ts` (reuses runStandaloneStrict, settledBetsOnly, metricsFor, settleBetU, aggregateMetrics).
