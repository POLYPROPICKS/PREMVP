# PolyProPicks Contur2 Battle Mode Execution Algorithm

_Last updated: 2026-06-22_
_Mode described: producer-authoritative `NIGHT_LIVE_EXECUTION`_
_Primary rule: PREMVP decides; Ireland validates and executes/fail-closes; Polymarket settles; Ireland records._

---

## 1. Purpose

This document describes the current production execution contour for PolyProPicks battle-mode execution. It is written for LLM operators, human operators, reviewers, and future maintainers.

The contour is not a strategy engine on the Ireland server. The Ireland server is an execution and safety layer. All strategy choices, candidate selection, tiers, fallback logic, and stake sizes must come from PREMVP/Railway through the versioned API contract.

---

## 2. System responsibilities

### 2.1 PREMVP / Railway / `polypropicks.com`

PREMVP is the producer and decision engine.

PREMVP is responsible for:

- discovering eligible markets and events;
- ranking candidates through the model/planner;
- selecting tiers and fallbacks;
- deciding the executable candidate pool size;
- deciding `stake_usd` for each candidate;
- deciding caps:
  - `max_live_orders`,
  - `max_candidate_count`,
  - `max_stake_usd`,
  - `per_token_side_cap_usd`;
- setting `execution_mode`;
- exposing a versioned execution contract via `/api/executor/night-plan`.

PREMVP does **not** place orders on Polymarket directly.

### 2.2 Ireland Lightsail executor

Ireland is the execution safety layer.

Ireland is responsible for:

- pulling the PREMVP API contract;
- validating schema, mode, TTL, caps, and candidates;
- writing a normalized local execution queue to `data/candidates.json`;
- checking hard-stop and process isolation;
- checking candidate-level contract before send;
- checking entry-window timing;
- checking duplicate / idempotency / order-key state;
- checking CLAIMED/SENT recovery state;
- checking stake, price, spread, and exposure guards;
- calling the Node sender only after all guards pass;
- writing durable ledger/log evidence;
- fail-closing on invalid or ambiguous state.

Ireland must not choose strategy, reduce the candidate pool by its own strategy, change tiers, or invent stake policy. It may only reject/fail-close for safety reasons.

### 2.3 Polymarket / CLOB

Polymarket/CLOB is the venue.

It is responsible for:

- accepting or rejecting posted orders;
- returning order response data;
- reflecting final open order / position state through exchange/data APIs.

Ireland records an order as `SENT` only when structured confirmed success is parsed from the Node sender output.

---

## 3. Current battle-mode contract

Endpoint:

```txt
/api/executor/night-plan
```

Current active producer-authoritative mode:

```txt
api_schema_version = executor-night-plan-v1
execution_mode = NIGHT_LIVE_EXECUTION
```

Recent verified contract shape:

```txt
candidate_count = 13
max_live_orders = 13
max_candidate_count = 13
max_stake_usd = 10
per_token_side_cap_usd = 10
total_planned_notional_usd = 71
expired = 0
duplicate_order_keys = 0
duplicate_token_side = 0
missing_core_ids = 0
```

The executable source is **top-level `candidates[]` only**.

Old diagnostic arrays such as `diagnostics.selected_event_candidates` must not be used as executable order source.

---

## 4. Required candidate fields

Each executable candidate must include, at minimum:

```txt
api_schema_version
execution_mode
valid_until_iso
order_key
condition_id
token_id
side
stake_usd
max_stake_usd
per_token_side_cap_usd
preferred_entry_iso and/or entry_window_start_iso when available
latest_entry_iso and/or entry_window_end_iso when available
market_slug / event_title / market_title for logs and review
```

Candidate rejection is required if any core identity field is missing:

```txt
condition_id
token_id
side
order_key
```

---

## 5. Ireland puller flow

Script:

```txt
scripts/pull_night_plan_candidates.py
```

Flow:

1. Call PREMVP `/api/executor/night-plan` with executor auth.
2. Read the top-level contract.
3. Validate:
   - `api_schema_version == executor-night-plan-v1`;
   - `execution_mode` is supported;
   - `valid_until_iso` is present and not expired;
   - caps are positive and internally consistent;
   - candidate count is not above producer cap;
   - every candidate has core identity;
   - every candidate has stake and stake is not above cap.
4. Normalize candidates into local queue.
5. Write `data/candidates.json`.
6. If validation fails, write an empty safe queue or fail with no order execution.

Expected successful pull output example:

```json
{
  "written": 13,
  "schema": "executor-night-plan-v1",
  "execution_mode": "NIGHT_LIVE_EXECUTION",
  "max_candidate_count": 13,
  "max_stake_usd": 10.0,
  "source": "top_level_candidates_contract_v1"
}
```

---

## 6. Local queue ordering and timing

Local queue file:

```txt
data/candidates.json
```

The execution order is the array order in `data/candidates.json`. Candidate `n=1` is evaluated before candidate `n=2`, and so on.

The live loop does not send all candidates instantly simply because they exist in the queue. Each candidate is evaluated against entry-window timing before real send.

Current timing guard evidence in `live/night_live_loop.py` includes:

```txt
contur1_entry_window_ok
CONTUR1_F1_ENTRY_WINDOW_GUARD_V1
CONTUR1_F1_BEFORE_SEND_WINDOW_CHECK_V1
SKIP_BEFORE_ENTRY_WINDOW
SKIP_AFTER_ENTRY_WINDOW
SLEEP_SECONDS = 300
```

Meaning:

- if the candidate is before its allowed entry window, it is skipped/waited for a later cycle;
- if the candidate is after its latest entry window, it is skipped;
- the loop sleeps between cycles, currently around 300 seconds unless overridden by env.

Recent queue timing examples from current pool:

```txt
19:15 Minsk — Argentina vs Austria candidates
22:15 Minsk — Dota 2 / esports candidate
23:15 Minsk — France vs Iraq halftime candidates
01:45 Minsk — Valorant candidate
02:15 Minsk — Norway vs Senegal candidates
03:53 Minsk — Baltimore Orioles vs Los Angeles Angels candidate
05:15 Minsk — Jordan vs Algeria candidates
```

These are expected candidate attempt windows, not guaranteed final orders. Orders are still subject to price, spread, stake, exposure, hard-stop, and exchange response checks.

---

## 7. Hard-stop and approval layer

Hard-stop files:

```txt
/tmp/PPP_LIVE_HARD_STOP
data/PPP_LIVE_HARD_STOP
```

Default state before approved live execution:

```txt
both files present
no live process running
```

The contour must not start live execution unless CEO approval is explicit and operationally recorded.

Recommended approval wording:

```txt
CEO APPROVES NIGHT_LIVE_EXECUTION:
execute PREMVP-authorized candidates from current contract,
respect max_live_orders, max_candidate_count, max_stake_usd,
with Ireland safety guards active and monitoring running.
```

Hard-stop removal/disablement must be recorded in a battle launch report directory before start.

---

## 8. Pre-send safety gates on Ireland

Before each real order send, the live loop must check:

1. Candidate contract guard:
   - schema;
   - mode;
   - TTL;
   - core fields;
   - stake/caps.
2. Entry-window timing:
   - not before entry window;
   - not after latest entry window.
3. Claim/recovery state:
   - no unsafe existing CLAIMED state;
   - no duplicate SENT/RECOVERED state;
   - retry only if explicitly marked safe.
4. Exposure/cap state:
   - candidate stake within cap;
   - per-token-side cap respected;
   - existing/pending exposure considered where implemented.
5. Node sender readiness:
   - required env values are pinned;
   - `ORDER_KEY`, `TOKEN_ID`, `SIDE`, `MAX_ENTRY_PRICE`, `STAKE_USD`, and contract caps are passed.

---

## 9. CLAIMED/SENT recovery logic

The prior duplicate-buy risk was centered on crash windows between `CLAIMED` and `SENT`.

Current expected behavior:

```txt
SENT / RECOVERED -> do not retry
NEEDS_MANUAL_RECOVERY -> do not retry
SAFE_TO_RETRY -> retry allowed only if explicit
plain CLAIMED -> do not retry
NO_PRIOR_CLAIM -> candidate may proceed
```

Key markers / functions:

```txt
contur1_claim_is_safe_to_retry(...)
contur1_startup_reconcile_claims(...)
CONTUR1_P0C1_BLOCK_UNRECONCILED_CLAIM_BEFORE_SEND_V1
CONTUR1_P0C2_MAIN_STARTUP_RECONCILE_BEFORE_LOOP_V1
SKIP_UNRECONCILED_CLAIM
```

This logic must remain fail-closed.

---

## 10. Node sender and success detection

Node sender file:

```txt
live/live_test_order.mjs
```

Expected sender behavior:

1. Validate hard-stop/approval where implemented.
2. Validate stake and notional caps.
3. Validate max entry price and spread.
4. Call `createAndPostOrder`.
5. Emit structured response:

```txt
LIVE_ORDER_RESPONSE_JSON=...
```

6. Emit confirmed success only when all are true:

```txt
resp.success === true
orderID/orderId/id/hash/orderHash exists
no error
no errorMsg
status is not error
```

Confirmed success line:

```txt
LIVE_ORDER_CONFIRMED_JSON=...
```

On non-success:

```txt
LIVE_ORDER_SENT=NO
```

There may still be a legacy `LIVE_ORDER_SENT=YES` line. It is non-authoritative. Python must ignore bare legacy text and only accept `LIVE_ORDER_CONFIRMED_JSON`.

---

## 11. Python success parser

The Python parser in `live/night_live_loop.py` must:

- scan only lines starting with `LIVE_ORDER_CONFIRMED_JSON=`;
- parse the JSON payload;
- return True only if:
  - `success is True`;
  - order id exists;
  - no `error`;
  - no `errorMsg`.

Recent parser fixture passed:

```txt
good confirmed JSON -> True
bad/error confirmed JSON -> False
legacy LIVE_ORDER_SENT=YES -> False
PARSER_FIXTURE_PASS
```

Ledger `SENT` must only be written if parser returns True.

---

## 12. Logging and evidence

Important files:

```txt
data/candidates.json
data/live_ledger.jsonl
reports/night_live_ledger.jsonl
logs/live-executor.jsonl
reports/battle_launch_<timestamp>/launch_report.txt
reports/battle_launch_<timestamp>/live_start.log
reports/battle_launch_<timestamp>/candidates.before_start.json
reports/battle_launch_<timestamp>/open_orders.json
reports/battle_launch_<timestamp>/open_orders.err
```

Every real order attempt should preserve:

```txt
order_key
condition_id
token_id
side
stake_usd
max_entry_price
market_slug/event_title
CLAIMED ledger event
Node raw response
LIVE_ORDER_RESPONSE_JSON
LIVE_ORDER_CONFIRMED_JSON if success
SENT ledger event if success
skip/failure reason if not sent
```

Post-order evidence should include positions/open-orders snapshots where available.

---

## 13. Monitoring during battle mode

Minimum manual monitoring loop:

1. Process status:

```txt
night_live_loop.py
live_test_order.mjs
```

2. Live start log:

```txt
reports/battle_launch_<timestamp>/live_start.log
```

3. Ledgers:

```txt
data/live_ledger.jsonl
reports/night_live_ledger.jsonl
```

4. Node executor log:

```txt
logs/live-executor.jsonl
```

5. Watch for:

```txt
CLAIMED
SENT
LIVE_ORDER_CONFIRMED_JSON
SKIP_BEFORE_ENTRY_WINDOW
SKIP_AFTER_ENTRY_WINDOW
SKIP_UNRECONCILED_CLAIM
STAKE_INVALID_OR_TOO_HIGH
ORDER_NOTIONAL_CAP_BREACH
PRICE_TOO_HIGH
SPREAD_TOO_WIDE
INSUFFICIENT_BALANCE
error / errorMsg
```

Manual monitor cadence during launch window:

```txt
every 30-60 seconds immediately after start
every 5 minutes during waiting windows
immediately at each known preferred entry time
```

---

## 14. Kill-stop conditions

Immediately restore hard-stop and stop processes if any occurs:

```txt
unexpected second live process
candidate_count exceeds producer caps
stake exceeds contract cap
duplicate token-side exposure appears
unreconciled CLAIMED appears
Node emits ambiguous response
order sent but no confirmed JSON / no SENT ledger
ledger parse errors
repeated exchange errors
balance/allowance errors block multiple candidates
unexpected market/token/side mismatch
operator sees wrong event/order in Polymarket UI
```

Kill-stop action must:

1. recreate hard-stop files;
2. kill live loop and sender processes;
3. preserve latest logs/ledger;
4. record reason and timestamp.

---

## 15. Current known state before start

Recent verified current state:

```txt
candidate_count = 13
execution_mode = NIGHT_LIVE_EXECUTION
max_live_orders = 13
max_candidate_count = 13
max_stake_usd = 10
per_token_side_cap_usd = 10
total_planned_notional_usd = 71
max_single_stake_usd = 10
expired = 0
duplicate_order_keys = 0
duplicate_token_side = 0
missing_core_ids = 0
QUEUE_READY_PASS
PARSER_FIXTURE_PASS
compile checks PASS
Node checks PASS
ledger sanity previously PASS
```

Balance note:

```txt
If available USDC buying power is greater than total planned notional plus existing open-order reservations, balance below 300 is not itself a blocker.
Current planned notional is about 71 USD.
```

Actual available balance/open-order reservation should be checked through available CLOB/helper commands immediately before start.

---

## 16. Expected battle-mode happy path

1. PREMVP produces a fresh `NIGHT_LIVE_EXECUTION` contract.
2. Ireland pulls the contract.
3. Ireland writes `data/candidates.json`.
4. Operator verifies queue readiness.
5. Operator verifies hard-stop, no process, compile, parser, and candidate summary.
6. CEO approves battle-mode execution.
7. Ireland launch report directory is created.
8. Current candidates and ledger are copied into the report directory.
9. Hard-stop is disabled/removed only for approved run and recorded.
10. Live loop starts.
11. On each cycle, live loop evaluates candidates in queue order.
12. If a candidate is before its entry window, it is skipped/waited until a later cycle.
13. If a candidate is inside its entry window, guards run.
14. If all guards pass, Python writes CLAIMED and calls Node sender.
15. Node sends order to Polymarket/CLOB.
16. Node emits structured response.
17. Python parses `LIVE_ORDER_CONFIRMED_JSON`.
18. If success, Python writes SENT to ledger.
19. Monitor watches logs, ledgers, process, and exchange state.
20. Any kill-stop condition restores hard-stop and terminates processes.

---

## 17. Reviewer checklist

A reviewer should answer:

1. Is PREMVP clearly producer-authoritative?
2. Does Ireland only validate/execute/fail-close?
3. Is old diagnostic candidate execution impossible?
4. Are entry-window checks applied before real send?
5. Is CLAIMED-without-SENT recovery fail-closed?
6. Is success detection structured and not based on legacy text?
7. Are caps passed from PREMVP and enforced locally?
8. Are logs sufficient to reconstruct every attempted order?
9. Are kill-stop conditions explicit enough?
10. Is open-order/positions exposure checking sufficient for multi-order mode?

---

## 18. Final operational principle

The correct mental model is:

```txt
PREMVP decides.
Ireland validates and executes or fail-closes.
Polymarket settles.
Ireland records.
Operator monitors and kill-stops.
```

Ireland must never silently become the strategy layer.
