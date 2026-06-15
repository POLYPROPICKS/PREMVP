# FireModel1 — Next ROI Improvement Hypotheses
Date: 2026-06-15  Policy: battle-sm-guard-v1-20260615

## What Is Locked
- score>=72 + coverage>=50 = TIER1 entry gate
- max_entry_price = entry_price_num + 0.04, cap 0.99
- smart_money >= 75 = caution/fade = half stake
- bad bucket: cov 50–74 AND price 0.44–0.58 = SKIP
- eSports max stake $5
- global stake cap $10
- bank $300 / target exposure $160 / hard cap $220

## What Is Validated
- Ireland paper bridge: PASS (Spain vs Cabo Verde +2.5)
- Endpoint /api/executor/candidates: PASS, 46 candidates live
- Token/geoblock/orderbook checks: PASS
- FireModel1.1 lower-gate collection: wired (shadow-firemodel1_1_research_v0)

## What Failed / Was Missed Today
- No live order placed today (live window missed — this was intentional; executor paused)
- DB resolved corpus = 297 rows, all score>=72 — too small to evaluate FM1.1 gate
- realized_return_pct likely all null (no live orders yet) → ROI board will show NOT_AVAILABLE

## Top ROI Improvement Hypotheses (priority order)

### 1. Bad bucket exclusion (already implemented)
- Hypothesis: cov 50–74 + price 0.44–0.58 = market maker trap / low edge
- Action: run `firemodel1:roi` after first 20 resolved rows to confirm

### 2. Timing: wait-to-T-minus-60
- Hypothesis: orders placed >1h before start have higher adverse selection
- Experiment: split resolved cohort by hours_to_start at placement; compare ROI
- Script needed: add timing cohort to `firemodel1:roi` output (already implemented)

### 3. Spread/totals/BTTS cohort split
- Hypothesis: spread markets behave differently from moneyline
- Action: add market_type tag to diagnostics; split in ROI board
- Current state: market_type field exists in shadow rows, missing in v2-lite rows

### 4. WC2026 market-family cohorts
- Hypothesis: WC group-stage vs knockout vs winner outright have different edge profiles
- Action: tag WC rows with stage (group/knockout) from event slug
- Data source: Polymarket event titles already contain this info

### 5. eSports limited branch
- Hypothesis: eSports stake cap ($5) may still be too high if ROI < 0
- Action: check eSports sub-cohort ROI after 20+ resolved rows
- Current: isolated in both ROI and funnel scripts

### 6. Smart money as caution/half-stake (already implemented)
- Hypothesis: sm>=75 markets have professional counter-flow → reduce exposure
- Validation: need 10+ resolved sm>=75 rows to confirm ROI difference

### 7. Slippage stress guard
- Current: max_entry = entry + 0.04 buffer
- Hypothesis: 4c buffer may be insufficient at best_ask > 0.70
- Experiment: add best_ask check in live_test_order.mjs (already has spread check at 0.03)

### 8. Correlation guard
- Hypothesis: multiple same-event candidates amplify loss on correlated outcomes
- Status: live-readiness script warns on same condition_id prefix
- Next: implement correlation score using condition_id grouping before orders

### 9. Live vs prematch split
- Hypothesis: live markets (game_start < now, still trading) behave differently
- Current: SKIP_STARTED already excludes them
- Long-term: separate live-trading model with different gates

### 10. Data coverage stability
- Hypothesis: dataCoverage drifts during inplay — lock coverage at T-2h
- Action: store coverage_snapshot_at field when cron runs; compare to current

## Next Operational Steps
1. Place first controlled live test order ($5, Tier1 only)
2. Run `npm run firemodel1:roi` on server after 10 resolved rows → real ROI baseline
3. Add market_type to v2-lite diagnostics (small enrichment patch)
4. Run `npm run firemodel1:funnel` daily to track supply trend
5. After 50 resolved rows → evaluate bad-bucket rule with actual data
