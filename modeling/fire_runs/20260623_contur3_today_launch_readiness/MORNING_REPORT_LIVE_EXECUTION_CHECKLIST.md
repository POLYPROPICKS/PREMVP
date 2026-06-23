# Morning Report — Live Execution Checklist

## Таблицы для проверки после первого живого ордера

### 1. `event_execution_queue`
```sql
SELECT id, match_family_key, status, condition_id, token_id, side,
       stake_usd, tier, queued_at, plan_run_id, rebalance_run_id
FROM event_execution_queue
WHERE status IN ('SENT', 'CLAIMED', 'FAILED')
ORDER BY queued_at DESC
LIMIT 20;
```
**PASS**: есть строки с `status=SENT` или `CLAIMED`.
**STOP**: все строки `READY` — Ireland не забрал ордер.

### 2. `executor_order_events`
```sql
SELECT id, event_type, source, order_status, success, dry_run, live_confirm,
       created_at, executor_meta
FROM executor_order_events
WHERE event_type != 'night_plan_poll'
  AND dry_run = false
ORDER BY created_at DESC
LIMIT 20;
```
**PASS**: строки с `success=true`, `live_confirm=true`, `dry_run=false`.
**STOP**: только `night_plan_poll` строки — живые ордера не записывались.

### 3. `executor_audit_events`
```sql
SELECT run_id, stage, status, condition_id, token_id, side,
       stake_usd, tier, live_eligible, source, created_at
FROM executor_audit_events
WHERE stage = 'EXECUTED'
ORDER BY created_at DESC
LIMIT 20;
```
**PASS**: строки со `stage=EXECUTED`, `live_eligible=true`.
**STOP**: нет строк `EXECUTED` — проверь Ireland watcher logs.

---

## Поля отчёта — что ожидать

| Поле | Ожидаемое значение | PASS/STOP |
|---|---|---|
| `source` | `event_execution_queue` | PASS если так |
| `dry_run` | `false` | PASS если false |
| `live_confirm` | `true` | PASS если true |
| `order_status` | `SENT` / `FILLED` / `OPEN` | PASS |
| `stake_usd` | ≤ 7 | PASS если ≤ 7 |
| `tier` | `TIER1` | PASS если TIER1 |

---

## NO_REAL_EXECUTOR_ROWS — что это

Если после ночи в `executor_order_events` нет строк с `dry_run=false AND live_confirm=true`:
- Значит Ireland watcher не отправил ни одного ордера.
- Проверь: hard-stop был ли снят, watcher был ли запущен, логи Ireland.
- Это **не** скрытая ошибка — это явная индикация `NO_REAL_EXECUTOR_ROWS`.

---

## Что не трогать

- Не меняй Excel шаблоны отчётов (styling и формулы — вне скоупа).
- Не запускай retroactive resolver без явного решения основателя.
- Supabase schema — только если доказана блокирующая проблема.

---

## Когда проверять

- **T+5 мин** после первого ожидаемого входа (см. `preferred_entry_iso` в очереди).
- **T+30 мин** — если строк всё ещё нет, это STOP, разбирай Ireland logs.
