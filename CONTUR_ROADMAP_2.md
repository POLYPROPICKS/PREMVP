# Contur_Roadmap_2

This is the current canonical source of truth for Contur3 recovery, Contract A migration, controlled live validation, and the later Dynamic Protected integration. It supersedes the incorrect simplified assumption:

> final Contract A T−90 decision → daily reservation.

## 1. Canonical two-stage lifecycle

### Stage A — Daily planning and event reservation

At approximately 17:00 Minsk:

- Load the broad planning-eligible Signal PR universe.
- Cover the next 18 hours.
- Group markets into unique physical events.
- Apply the existing score, coverage, tier, and slot rules.
- Reserve eligible physical events in `night_event_reservations`.
- Do not require an event to already be within T−90.
- Do not prematurely persist a final market winner that does not yet exist.

### Stage B — Due-event final selection

In the existing T−70…T−3 window:

- Load current markets for each reserved physical event.
- Run the final Contract A decision stage.
- Preserve exact `condition_id`, `token_id`, and `side`.
- Create one READY execution payload.
- Never replace a missing or non-executable authoritative market with an alternate.
- Fail closed when the exact authoritative market cannot be executed.

### Stage C — Ireland execution boundary

- PREMVP writes the READY intent.
- Ireland reads the queue.
- Ireland validates current time, price, liquidity, and units.
- Ireland executes no more than the PREMVP USD cap.
- Ireland returns execution facts.
- PREMVP owns derived PnL and later capital-policy calculations.

## 2. Proven defect

The July 2026 defect is proven:

- Contract A was wired using final T−90 one-per-event decisions at the daily planning boundary.
- The production daily reservation entry remained `CONTUR3_CURRENT`.
- The accepted preview runner did not reproduce the canonical 17:00/18-hour night plan.
- Therefore the prior `19 accepted → 0 reserved` preview was invalid evidence about the real daily reservation lifecycle.

Required repair:

> broad Contract A planning stage → event reservation → later final Contract A decision at rebalance.

## 3. Corrected delivery roadmap

1. Implement the canonical two-stage Contract A integration.
2. Add RED-first regression coverage for:
   - planning beyond T−90 but inside 18 hours;
   - production daily-entry activation;
   - final exact identity at T−70;
   - no alternate substitution;
   - unchanged `CONTUR3_CURRENT` behavior;
   - read-only preview parity.
3. Independent acceptance.
4. Release and Railway deployment.
5. Inspect current reservation, queue, and order state.
6. Perform a controlled force rebuild only when no `CLAIMED`, `SENT`, or `EXECUTED` state makes deletion unsafe.
7. Produce a real READY payload.
8. Perform Ireland connected dry-run with submission disabled.
9. Perform the CEO-approved controlled live batch.
10. Collect real execution facts and reconcile every order.
11. Only after fixed-stake E2E evidence, begin Dynamic Protected shadow.
12. Physical Vault remains a much later optional phase.

## 4. CEO-approved controlled live rule

Hard rule: after the two-stage repair, independent acceptance, deployment, safe plan-state check, and connected Ireland dry-run, prioritize real bounded execution evidence over repeated token-heavy theoretical audits.

Authorized controlled batch:

- Maximum five real orders.
- Each order has a hard PREMVP USD cap from $1 to $3.
- No order may exceed $3.
- No dynamic sizing, stake escalation, martingale, recovery sizing, or automatic overnight scaling.
- No Virtual or Physical Vault controls money.
- Stop the entire batch immediately after the first unexplained anomaly.

Mandatory stop anomalies include:

- USD cap and actual CLOB notional do not reconcile.
- Submitted units are ambiguous.
- Duplicate submission.
- Accepted order has unknown fill state.
- Unexpected partial-fill handling.
- Callback missing or duplicated.
- Order-events and queue state disagree.
- Position cannot be reconciled.
- Fee or average fill is unavailable.
- PREMVP cannot calculate actual PnL deterministically.
- Ireland restarts without recovering the active order safely.

CEO rationale: it is more valuable to obtain real bounded evidence from up to five $1–$3 orders than to spend substantially more money and operator time on model tokens while still not proving the production contour works.

## 5. Execution facts required now

Ireland must expose, and PREMVP/Supabase must preserve where applicable:

- Execution intent or queue identifier; idempotency key; `condition_id`; `token_id`; and side.
- Requested USD cap; submitted CLOB units/size; and submitted price.
- Accepted/rejected state; CLOB order ID; filled size; average fill price; fee amount and currency.
- Partial/full-fill state; remaining open size.
- Submitted, acknowledged, first-fill, final-fill, cancel, and failure timestamps.
- Callback delivery state; queue state; and final market-resolution facts.

Ireland owns execution facts. PREMVP owns the intended USD cap and future capital policy, and calculates actual PnL from fills, fees, and market resolution. Order accepted is not order filled; requested stake is not filled notional. Wallet, open orders, positions, and claimable funds belong to reconciliation, not Dynamic policy itself.

## 6. Deferred scope

Explicitly deferred:

- Dynamic Protected live stake sizing.
- Active/Vault/openPrincipal production state.
- Virtual Vault controlling live stake.
- Physical Vault or separate wallet.
- Automatic portfolio exposure scaling.
- Overnight automated live expansion.

Dynamic Protected may begin only as shadow/replay after the controlled fixed-$1–$3 batch, deterministic fills/fees/results storage, zero unresolved reconciliation errors, and a trustworthy forward execution dataset.

## 7. Ownership boundary

PREMVP owns:

- Model and selector; daily planning policy; reservation policy; and final signal identity.
- USD stake cap; future capital policy; PnL calculation; and reconciliation truth in Supabase.

Ireland owns:

- Queue consumption; execution-time market validation; and USD-to-CLOB-unit conversion.
- Order submission; order/fill/fee facts; execution journaling; retry/recovery behavior; and callback delivery.

Ireland must never independently choose the next stake or Dynamic/Vault policy.

## 8. Current next action

The immediate next implementation is the two-stage Contract A repair on branch:

`codex/contract-a-canonical-night-plan-v1`

No Dynamic Protected, Vault, or live-batch implementation starts before that repair passes independent acceptance and produces a real READY payload.
