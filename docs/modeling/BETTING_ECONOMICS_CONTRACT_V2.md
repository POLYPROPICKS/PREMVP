# BETTING_ECONOMICS_CONTRACT_V2.md

Status: **FOUNDER-APPROVED METHODOLOGY FREEZE — DRAFT FOR GIT COMMIT**
Date: **2026-09-24**
Repository target: `POLYPROPICKS/PREMVP`
Current verified main baseline at freeze preparation: `6c52980a51c78815d6b0faccbd7b14e093934d94`

## 0. Purpose

This contract resets the business interpretation of odds, execution, PnL and model validation after the discovery that historical `entry_price_num/currentPrice` was frequently derived from provider display/mark pricing and was incorrectly treated as if it were an executable entry quote.

This document does **not** change production code, live money policy, database schema, Ireland execution, or current runtime behavior.

Primary business goal:

> Determine whether PolyProPicks has repeatable predictive alpha, and then measure each distinct way of monetizing that alpha without conflating reference odds, executable odds, fills, or trading exits.

Football is the first sport used to prove the methodology.

---

## 1. Founder-facing odds terminology

All Founder / CEO / business reporting uses **decimal odds only**: `1.50`, `1.80`, `2.00`, `3.50`, `10.00`.

Do not report 0.xx share prices as the primary business representation.

### DISPLAY_ODDS

Decimal odds implied by the market's displayed/reference price.

Temporary PREMVP assumption:

> Until an external sportsbook odds feed exists, `DISPLAY_ODDS` is used as a **sportsbook-reference proxy**.

This is a Founder-approved working assumption, not a proven claim that display odds equal bookmaker odds in 95–97% of cases.

For zero-volume / zero-liquidity markets, display odds remain a reference quote only. They are not proof that a bet was executable.

Allowed uses: market reference, model comparison, legacy reconstruction, maker target design, descriptive research.

Not allowed: proof of realized or immediately executable PnL.

### AVAILABLE_ODDS

The best decimal odds at which the required stake can be bought **now** from actual available order-book liquidity.

This is stake-sensitive. Top-of-book is insufficient when it cannot fill the target stake.

### MAKER_ODDS

The decimal odds PolyProPicks itself offers through a resting limit order.

If the order is not matched before the safe deadline: `NO_FILL`, not a losing bet.

### FILL_ODDS

The actual stake-weighted decimal odds obtained by a matched bet.

This is the primary authority for realized betting PnL.

### NET_ODDS

`FILL_ODDS` after venue fees and other execution costs actually charged.

This is the final odds authority for realized ROI.

### CLOSING_ODDS

The executable market odds observed at the approved closing comparison point before event start.

Purpose: CLV and independent market validation.

### MODEL_FAIR_ODDS

Odds implied by the model's independently estimated outcome probability.

If model probability is `p`: `MODEL_FAIR_ODDS = 1 / p`.

---

## 2. PnL classes — never mix them

### REFERENCE_PNL

Counterfactual PnL using `DISPLAY_ODDS`.

Mandatory label: `NOT_EXECUTION_AUTHORITY`.

### TAKER_PNL

PnL from bets that could be bought immediately using actual available order-book depth and executable odds.

### MAKER_PNL

PnL only from actually matched maker orders.

Unfilled orders contribute zero stake, zero PnL, status `NO_FILL`.

### TRADING_PNL

PnL from positions exited before final settlement.

Never combine with hold-to-settlement PnL without an explicit portfolio layer.

---

## 3. Execution strategies — separate models

### S1 — TAKER_HOLD

`signal -> acceptable AVAILABLE_ODDS + sufficient depth -> BUY NOW -> HOLD TO SETTLEMENT`

Required evidence: ask/depth, executable stake, fill/VWAP, fee, settlement.

This is the first and most pessimistic monetization strategy.

### S2 — FIXED_MAKER_HOLD

`signal -> choose MAKER_ODDS -> resting limit BUY -> matched or NO_FILL -> HOLD TO SETTLEMENT`

Maker odds may use the display/sportsbook-reference proxy as a target.

Report: signals, orders offered, full fills, partial fills, no fills, time to fill, W/L of all signals, W/L of fills only, maker PnL, adverse selection.

### S3 — MAKER_DEVIATION_HOLD

`signal -> initial target odds -> controlled concession ladder -> never cross minimum acceptable odds -> matched or NO_FILL -> HOLD`

Example: `2.05 -> 2.00 -> 1.95 -> 1.90`, floor `1.85`.

Deviation policy must be predeclared before evaluation.

Purpose: optimize trade-off between odds quality, fill rate and realized PnL.

### S4 — TRADE_OUT

`BUY -> favorable probability/price move -> executable SELL -> realized trading PnL`

Different strategy from predicting final outcome.

Required: actual entry fill, executable exit bid/depth, exit fill, realized trading PnL, partial-position accounting.

Do not infer exitability from display price alone.

### Deferred sleeve — LONGSHOT_OPTIONALITY

Future research sleeve: very high decimal odds, very small fixed risk, rare settlement wins and/or large favorable pre-settlement moves, optional early exit.

Not part of core football rescue until the main methodology is proven.

---

## 4. Historical price-semantic correction

Historical fields such as `entry_price_num`, `currentPrice`, provider `outcomePrices`, and derived `selected_european_odds_num` must not automatically be interpreted as executable entry odds.

Unless independent execution evidence proves otherwise, historical `entry_price_num` is classified as:

`DISPLAY / MARK REFERENCE`

not:

`FILL / EXECUTABLE QUOTE`.

Existing historical ROI derived from these fields is retained but relabeled:

`LEGACY_DISPLAY_ODDS_ROI / NOT_EXECUTION_AUTHORITY`.

This applies across sports, not only tennis.

---

## 5. Model / execution separation

### Alpha

Question: `Can we predict the outcome better than chance / market reference?`

Evaluate hit rate, calibration, Brier/log-loss where possible, time stability, sport/league/market/lead time and frozen out-of-sample validation.

### Betting value

Question: `Is model probability sufficiently better than reference / executable odds?`

Concept: `EV = model_probability * net_decimal_odds - 1`.

Do not estimate model probability from the same market odds and then claim independent predictive edge without labeling that dependency.

### Execution

Question: `Can we actually obtain acceptable odds at useful stake?`

Evaluate depth, spread, fill rate, VWAP/FILL_ODDS, fees, time-to-fill, no-fill, CLV and exitability when relevant.

---

## 6. Signal Score status

Current production Signal Confidence is frozen as `LEGACY_SIGNAL_SCORE`.

It remains valid as a historical feature and production behavior to audit, but it is **not accepted as an independent probability model**.

Known structural issue to test:

- current score heavily uses odds bands as its base;
- outcome selection has price/odds corridor preferences;
- trust metrics are largely offsets from the same primary score.

Therefore odds may influence side selection, Signal Confidence and historical PnL, creating possible circularity.

Future `ALPHA_SCORE_V2` must separate predictive features from market odds. Candidate dimensions include score level, score trajectory, directional flow, large trades, volume/liquidity where valid, sport, league, market type and lead time.

No live implementation change is authorized by this methodology freeze.

---

## 7. Legacy model rescue rules

Before inventing new models, preserve and re-evaluate frozen hypotheses including:

- `C5`
- `C4`
- `C1`
- `BASELINE_V1_CONTROL`
- `PRIMARY_V1_AVOID_NBA_NHL_COV_CAP`
- `ALT1_ONE_PER_EVENT_BEST_COVERAGE`
- `ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH`
- `ALT3_*`
- `ALT4_*`
- `EXPANDED_50_COV25`
- `STRICT_72_COV50`
- `ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS`
- `B2_TIMING_WITHIN_120M`
- other frozen June/July high-odds models recovered from repository evidence.

Price-driven strategies are retained but tagged `PRICE_CONTAMINATED_RETEST` until re-proven.

Do not delete historical models because old ROI is no longer execution-authoritative.

---

## 8. Validation chronology

Do not optimize and validate on the same period.

Preferred chronology:

- frozen June/July hypothesis definitions = discovery/prior;
- August = validation 1;
- September = validation 2/later tail.

For hypotheses first created in August:

- August = discovery;
- September = validation.

Always report August and September separately before pooled results.

A positive pooled result does not override failed later-period replication.

Small samples are diagnostic, not core strategies.

---

## 9. Football-first research sequence

### F1 — FOOTBALL_LEGACY_ALPHA_RESCUE

No new hypotheses.

Reconstruct frozen legacy model predicates and evaluate August, September and Aug+Sep.

Report unique physical events, W/L, calibration/hit rate, legacy reference PnL/ROI, MaxDD, league mix, market mix, lead-time mix and Signal Score distribution.

Primary question:

`Did the model select useful outcomes independent of execution-price mistakes?`

### F2 — FOOTBALL_EXECUTION_MATRIX

For surviving signals, separately assess:

- `S1 TAKER_HOLD`
- `S2 FIXED_MAKER_HOLD`
- `S3 MAKER_DEVIATION_HOLD`

Historical claims only where required execution evidence exists.

Missing ask/depth/fill evidence is `UNPROVEN`, never reconstructed from display odds.

### F3 — FOOTBALL_SIGNAL_SCORE_RESEARCH

Evaluate score level, score trajectory, trade flow, volume/liquidity, league, market and lead time.

Design future `ALPHA_SCORE_V2`.

### F4 — FORWARD_EXECUTION_SHADOW

For each eligible future signal record in parallel:

- Display Odds
- Available Odds
- depth
- maker target odds
- deviation ladder
- fill/no-fill
- VWAP / Fill Odds
- fees / Net Odds
- Closing Odds
- settlement

No real-money expansion is implied.

### F5 — TRADE_OUT / LONGSHOT

Only after hold strategies are understood.

---

## 10. Sport rollout after football

After football methodology passes:

1. Baseball
2. Tennis
3. Cricket
4. Esports
5. Basketball
6. Hockey
7. remaining sports

Preserve tennis semantic findings: `moneyline` and `tennis_completed_match` are different products; `Completed Match YES` is a hold-to-settlement hypothesis; historical 0.50-like marks are not executable-odds proof.

---

## 11. Founder / CEO scoreboard

Every result clearly separates:

### MODEL QUALITY
model ID, period, N signals, settled N, wins, losses, hit rate, calibration, sport/league/market/lead-time mix.

### REFERENCE ECONOMICS
Display Odds source, Reference PnL, Reference ROI, label `NOT_EXECUTION_AUTHORITY`.

### EXECUTION ECONOMICS
Where evidence exists: Available Odds, Fill Odds, Net Odds, filled stake, fill rate, PnL, ROI, fees, spread/slippage, MaxDD.

### MARKET VALIDATION
Closing Odds, CLV, no-fill rate, adverse selection.

Do not present one unlabeled ROI column when several economic definitions are possible.

---

## 12. Hard prohibitions

1. No 0.xx price ladders in Founder-facing conclusions.
2. Do not call display/mark odds executable odds.
3. Do not call historical display-odds ROI realized ROI.
4. Do not infer a fill from volume alone.
5. Do not infer no-fill from volume=0 alone.
6. Do not count unmatched maker orders as bets.
7. Do not ignore no-fill or partial-fill populations.
8. Do not mix hold PnL and trade-out PnL.
9. Do not retune frozen legacy models before Aug/Sep validation.
10. Do not change live money policy as part of research unless separately approved.
11. Do not let bankroll/compounding substitute for alpha proof.
12. Do not promote narrow small-N segments to production models.

---

## 13. Stage-0 completion gate

This methodology freeze is complete when:

- this contract is committed to Git;
- no production/runtime behavior changes;
- historical artifacts are not deleted;
- old ROI is explicitly treated as display-odds/reference ROI unless fill evidence exists;
- next research task is exactly `FOOTBALL_LEGACY_ALPHA_RESCUE_V1`.

Next transition:

`FOOTBALL_LEGACY_ALPHA_RESCUE_V1`

Business purpose:

> Determine whether the strongest pre-existing football model logic retained predictive value in August and September before rebuilding execution or inventing new hypotheses.
