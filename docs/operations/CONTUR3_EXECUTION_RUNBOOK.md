# Contur3 Execution Runbook (post-PR57)

Operational reference for the PREMVP → Ireland execution contour after PR #57
(fail-closed order-events contract). Read-only reference — does not authorize
any action by itself; live/order commands still require explicit founder
approval each time.

## 1. Contour architecture

- **PREMVP is the source of truth for candidate selection, stake, and price
  cap.** It writes `night_event_reservations` (~17:00 Minsk) and
  `event_execution_queue` (at T-70..T-3 rebalance). Stake is dynamic
  (`computeBaseStake`/`computeStake` in `lib/executor/buildFireModelCandidates.ts`,
  capped at $10), and `max_entry_price` is computed by PREMVP and exposed via
  `diagnostics.max_entry_price` / `IrelandQueueCandidate.max_entry_price`.
- **Ireland only validates and executes** what PREMVP already selected. It
  reads the queue via `/api/executor/queue` and must not recompute stake or
  independently pick a different candidate/market.
- **PR #57 order-events contract is fail-closed**
  (`app/api/executor/order-events/route.ts` +
  `lib/executor/executorQueueTypes.ts:validateOrderEventAgainstQueueRow`):
  - requires `idempotency_key` to look up the queue row (no key → reject);
  - `stake_usd` is accepted as a fallback for `submitted_size`
    (`submitted_size: num(raw.submitted_size ?? raw.stake_usd)`);
  - `submitted_price` is mandatory;
  - stake and price are rejected if they exceed the queue row's
    `stake_usd` / `max_entry_price` (`STAKE_EXCEEDS_QUEUE_MAX`,
    `PRICE_EXCEEDS_QUEUE_MAX`);
  - missing `max_entry_price` on the queue row fails closed
    (`QUEUE_MAX_ENTRY_PRICE_MISSING`) rather than silently passing.
- **The one-shot runner is the only approved Ireland execution path**
  (`live/contur3_one_shot_queue_runner.py` on the Ireland host). It targets
  exactly one event/market per invocation via `--event-contains` filters and
  `--max-one`, and must be run manually per approved match — it is not a
  standing service.

## 2. Forbidden commands / paths

- `live/night_live_loop.py` — legacy all-candidates production loop. Not the
  approved path; do not run for live execution.
- Any persistent/nohup/background listener process for order execution.
- Manual `curl`/POST calls directly against `/api/executor/order-events` or
  any executor endpoint outside the one-shot runner.
- Any "all candidates" / broad-universe execution mode.
- `railway up` — deploys are via GitHub main auto-deploy only, never manual
  Railway pushes from an agent session.

## 3. Railway-side PREMVP commands (read-only monitoring)

```bash
cd /app
node scripts/contur3/live-funnel-log.mjs
EXECUTOR_BASE_URL="https://polypropicks.com" node scripts/contur3/contur3-executor-queue-probe.mjs
```

## 4. Ireland-side commands (one-shot runner only)

Dry-run (no order sent):

```bash
cd /home/ubuntu/polymarket-executor
python3 live/contur3_one_shot_queue_runner.py \
  --event-contains "<team1>" \
  --event-contains "<team2>" \
  --max-one \
  --dry-run
```

Live (requires explicit founder go, per match):

```bash
python3 live/contur3_one_shot_queue_runner.py \
  --event-contains "<team1>" \
  --event-contains "<team2>" \
  --max-one \
  --live \
  --confirm-live-order
```

## 5. Stop / kill commands (Ireland host)

```bash
ps aux | grep -Ei "contur3_one_shot|night_live_loop|live_test_order|queue|executor" | grep -v grep || true
pkill -f "contur3_one_shot_queue_runner.py" || true
pkill -f "night_live_loop.py" || true
```

## 6. Logs to inspect when auditing a match

- Ireland: `logs/order_attempts.jsonl`
- Ireland: `logs/live-executor.jsonl`
- Ireland: `reports/night_live_ledger.jsonl`
- Railway: `live_funnel_latest.json` / `.md`
- PREMVP: `executor_order_events` table (via `/api/executor/order-events` GET,
  or direct read-only SQL — see `reports/contur3/runtime_extraction_2026-07-07.sql`)

## 7. Fee/fill fields expected on a completed order-event

`app/api/executor/order-events/route.ts` accepts and persists:
`fee_usd`, `slippage_usd`, `cost_model_version`, `fee_notes`, plus
`clob_order_id` (order id/hash), `submitted_price`
(closest available to filled price at fail-closed validation time),
`submitted_size`/`stake_usd` (executed size). `fee_usd` is read back and used
for profit accounting in `scripts/morning-model-report.ts`
(`feeSlippagePct`). **If a live fill produces no `executor_order_events` row
at all (see July 7 postmortem), there is no fee data to reconcile — treat
that as a P0 accounting gap, not just a missed bet.**

## 8. Next-match checklist

1. Confirm `event_execution_queue` has a `READY` row for the target match
   with `idempotency_key`, `stake_usd`, and `diagnostics.max_entry_price` set.
2. Run the one-shot runner in `--dry-run` first; confirm it reports the
   correct event/market/side/stake/price cap before doing a live run.
3. Get explicit founder go for the live run.
4. Run the one-shot runner with `--live --confirm-live-order` for exactly
   that one match.
5. Immediately verify `executor_order_events` has exactly one row for that
   `idempotency_key`, with `success`, `fee_usd`, `submitted_price` populated.
6. If no order-event row appears, do not retry blindly — check Ireland logs
   first (section 6) to see whether the runner ran at all.
