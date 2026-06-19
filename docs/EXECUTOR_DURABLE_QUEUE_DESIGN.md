# Executor Durable Queue Design

Status: recommended next P0/P1 reliability upgrade; not implemented in this
patch.

## Why Endpoint-Only Polling Is Fragile

The current contour depends on Ireland polling `/api/executor/night-plan` at the
right time. This endpoint-only polling contour is fragile and caused missed
execution uncertainty: after Canada/Qatar and Mexico/Korea, the available
evidence could not immediately prove whether PREMVP failed to expose candidates,
Ireland missed the poll, the adapter dropped rows, `candidates.json` was stale,
or the live loop failed to attempt orders.

The recommended next step is a Supabase-backed `executor_candidate_queue`.
Ireland should consume this queue first and use the endpoint second as a backup
or preview. The queue should become the execution source of truth.

## Proposed Table

`public.executor_candidate_queue`

Key fields:

- `id uuid`
- `created_at timestamptz`
- `updated_at timestamptz`
- `expires_at timestamptz`
- `trace_id text unique`
- `idempotency_key text unique`
- `state text`
- candidate fields: condition/token/event/market/side/score/coverage/tier/stake
- `claimed_by text`
- `claimed_at timestamptz`
- `attempted_at timestamptz`
- `payload_json jsonb`

## States

- `PENDING`
- `CLAIMED`
- `DROPPED`
- `ORDER_ATTEMPTED`
- `ORDER_SENT`
- `ORDER_REJECTED`
- `ORDER_FILLED`
- `EXPIRED`

## Transition Rules

1. PREMVP inserts or upserts eligible candidates as `PENDING`.
2. Ireland consumes queue rows first, before endpoint fallback.
3. Ireland atomically claims rows: `PENDING -> CLAIMED`.
4. Ireland writes every adapter/live-loop decision.
5. Order attempt transitions: `CLAIMED -> ORDER_ATTEMPTED`.
6. CLOB result transitions to `ORDER_SENT` or `ORDER_REJECTED`.
7. Ledger confirmation transitions to `ORDER_FILLED`.
8. A scheduled cleanup transitions stale `PENDING/CLAIMED` rows to `EXPIRED`.

## Duplicate Prevention

Use both:

- `trace_id = condition_id::token_id::event_slug`
- `idempotency_key = live_policy_version::condition_id::token_id::side`

Ireland must never place an order if the queue row is not successfully claimed.

## Monitoring

Alert on:

- `PENDING` rows within 10 minutes of `expires_at`;
- `CLAIMED` rows older than 5 minutes;
- `ORDER_ATTEMPTED` without terminal CLOB result;
- `ORDER_SENT` without ledger write;
- live eligible API exposure without queue insert.

## Migration Path

1. Keep `/api/executor/night-plan` as preview and backup.
2. Add queue writes for live eligible candidates.
3. Update Ireland updater to consume queue first, endpoint second.
4. Once stable, make queue the execution source of truth.
