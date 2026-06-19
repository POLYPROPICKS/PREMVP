# Live Contour Monitoring Contract

Status: permanent P0 observability contract.

## Live Execution Policy

Canonical live policy is `TIER_FALLBACK_TO_15`: Tier1 first, then Tier2, then
Tier3 until 15 executable slots are filled or no safe candidates remain.
Tier1-only live execution is deprecated. Hard safety gates still apply:
token/condition/side, non-ended event, duplicate prevention, bankroll/notional
caps, max live order cap, and CLOB/auth/region safety.

## Stage Diagram

```text
PREMVP /api/executor/night-plan
-> Ireland updater
-> data/candidates.json
-> live loop
-> Polymarket CLOB
-> night_live_ledger.jsonl
-> resolver
-> morning report/modeling
```

Every candidate must be traceable by `trace_id`:

```text
condition_id::token_id::event_slug
```

## Supabase Audit Table

`public.executor_audit_events` is the durable trace table. Apply migration:

```text
supabase/migrations/20260619_executor_audit_events.sql
```

Required stages:

- `NIGHT_PLAN_API_RUN`
- `DISCOVERED`
- `PLANNED`
- `EXPOSED_BY_API`
- `PULLED_BY_IRELAND`
- `WRITTEN_TO_CANDIDATES_JSON`
- `DROPPED_BY_IRELAND`
- `SEEN_BY_LIVE_LOOP`
- `ORDER_ATTEMPTED`
- `ORDER_SENT`
- `ORDER_REJECTED`
- `ORDER_FILLED`
- `LEDGER_WRITTEN`
- `RESOLVER_UPDATED`
- `REPORT_INCLUDED`
- `EXPIRED_NO_ATTEMPT`

The PREMVP night-plan route currently writes:

- one `NIGHT_PLAN_API_RUN` summary per authenticated call;
- one `EXPOSED_BY_API` event per selected event candidate.

Audit payloads must include the selected candidate tier, `live_eligible`, stake,
rejection reason when present, and fallback policy diagnostics.

If the audit table is missing or unavailable, `/api/executor/night-plan` still
returns the plan and sets `diagnostics.auditWriteFailed=true`.

## Required Ireland JSONL Logs

Ireland must write:

- `logs/night_plan_polls.jsonl`
- `logs/candidate_decisions.jsonl`
- `logs/live_loop_decisions.jsonl`
- `logs/order_attempts.jsonl`

Poll log fields:

- timestamp
- url
- http_status
- raw_count
- written_count
- drop_token
- drop_side
- drop_ineligible
- candidate trace_id list
- first 10 reject reasons

Candidate decision fields:

- stage: `PULLED_BY_IRELAND`, `WRITTEN_TO_CANDIDATES_JSON`, or `DROPPED_BY_IRELAND`
- trace_id
- condition_id
- token_id
- event_slug
- market_slug
- reason

Live loop fields:

- `SEEN_BY_LIVE_LOOP`
- `ORDER_ATTEMPTED`
- `ORDER_SENT` or `ORDER_REJECTED`
- `LEDGER_WRITTEN`

## Daily Checks

Run:

```bash
npm run verify:live-contour
npm run verify:resolver-pipeline
```

Healthy state:

- recent `NIGHT_PLAN_API_RUN` exists;
- live eligible candidates have downstream Ireland proof;
- no unresolved executed live bets remain.

## Incident Response

1. Run `npm run verify:live-contour`.
2. Query `executor_audit_events` by `trace_id`.
3. Inspect Ireland JSONL logs by the same `trace_id`.
4. Inspect `reports/night_live_ledger.jsonl`.
5. Run `npm run verify:resolver-pipeline`.

## Operator Commands

Production endpoint check from Ireland:

```bash
cd /home/ubuntu/polymarket-executor
set -a; . config/executor-source.env; set +a
curl -sS -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET" \
  "https://polypropicks.com/api/executor/night-plan?bankroll=95&cash=95&windowMinutes=720&limit=50"
```

Ireland log check:

```bash
cd /home/ubuntu/polymarket-executor
tail -80 logs/night_plan_polls.jsonl
tail -80 logs/candidate_decisions.jsonl
tail -80 logs/live_loop_decisions.jsonl
tail -80 logs/order_attempts.jsonl
```
