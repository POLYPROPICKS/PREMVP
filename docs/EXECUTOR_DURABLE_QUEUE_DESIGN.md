# Executor Durable Queue Design

Status: recommended next reliability upgrade; not implemented in this patch.

## Why Endpoint-Only Polling Is Fragile

The current contour depends on Ireland polling `/api/executor/night-plan` at the
right time. If the updater misses the pre-match window, restarts, polls after
kickoff, or drops fields before writing `data/candidates.json`, PREMVP has no
authoritative execution-state record.

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
2. Ireland atomically claims rows: `PENDING -> CLAIMED`.
3. Ireland writes every adapter/live-loop decision.
4. Order attempt transitions: `CLAIMED -> ORDER_ATTEMPTED`.
5. CLOB result transitions to `ORDER_SENT` or `ORDER_REJECTED`.
6. Ledger confirmation transitions to `ORDER_FILLED`.
7. A scheduled cleanup transitions stale `PENDING/CLAIMED` rows to `EXPIRED`.

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
