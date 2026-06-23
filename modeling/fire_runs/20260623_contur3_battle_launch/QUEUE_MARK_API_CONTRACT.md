# Queue Mark API Contract — Contur3 Battle 2026-06-23

## Endpoint

```
POST /api/executor/queue/mark
Header: x-executor-secret: <EXECUTOR_CANDIDATES_SECRET>
Content-Type: application/json
```

## Request Schema

```json
{
  "queue_id": "uuid",
  "order_key": "string",
  "status": "CLAIMED|EXECUTED|SKIPPED|FAILED|EXPIRED",
  "source": "ireland_queue_only",
  "reason": "string (optional)",
  "live_order_confirmed": true,
  "polymarket_order_id": "optional string",
  "tx_hash": "optional string",
  "sent_at_iso": "optional ISO",
  "executed_at_iso": "optional ISO",
  "diagnostics": {}
}
```

## Status Transition Rules

| From       | To       | Allowed? | Condition                     |
|------------|----------|----------|-------------------------------|
| READY      | CLAIMED  | YES      | any                           |
| READY/CLAIMED | EXECUTED | YES  | live_order_confirmed=true     |
| READY/CLAIMED | SKIPPED | YES  | with reason                   |
| READY/CLAIMED | FAILED  | YES  | with reason                   |
| READY/CLAIMED | EXPIRED | YES  | with reason                   |
| EXECUTED   | any non-EXECUTED | NO | 409 Conflict              |

## Response

```json
{
  "ok": true,
  "queue_id": "uuid",
  "updated": {
    "id": "uuid",
    "status": "EXECUTED",
    "order_key": "...",
    "match_family_key": "...",
    "stake_usd": 7,
    "updated_at": "ISO"
  }
}
```

## Error Responses

| HTTP | Reason                                |
|------|---------------------------------------|
| 401  | Missing or invalid x-executor-secret  |
| 400  | Missing queue_id / invalid source / invalid status / EXECUTED without confirmed |
| 404  | Queue row not found                   |
| 409  | Attempted to overwrite EXECUTED       |
| 500  | DB error                              |

## Notes

- `source` must be exactly `"ireland_queue_only"` — any other value is rejected.
- Extra metadata (order IDs, tx hashes, diagnostics) is stored in the `diagnostics` JSONB column under `mark_history` array — no schema migration needed.
- No live order side effects — this is a status callback only.
- No broad candidate logic.
- If the `event_execution_queue` table does not have `updated_at`, the endpoint falls back to updating only `status` + `diagnostics`.
