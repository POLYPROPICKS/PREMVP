# OPERATOR NEXT STEPS — Contur3 Phase 3

## После Railway деплоя этого коммита

### 1. Запустить doctor (убедиться ALL_PASS)

```bash
BASE=https://polypropicks.com PPP_SECRET=<секрет> bash scripts/contur3_premvp_doctor.sh
```

Ожидаемый финальный вывод: `ALL_PASS_PHASE3_PREMVP_AUTOMATION`

---

### 2. Проверить статус текущего плана (read-only)

```bash
curl -s \
  "https://polypropicks.com/api/cron/night-event-reservations?mode=status" \
  -H "x-executor-secret: $PPP_SECRET" | jq '{plan_run_id, plan_health, in_creation_window}'
```

Если `plan_health.is_expired_only = true` — план нужно пересоздать.

---

### 3. Если план expired — форс-ребилд (только после 16:30 Minsk / 13:30 UTC)

```bash
curl -X POST \
  "https://polypropicks.com/api/cron/night-event-reservations?forceRebuild=CEO_APPROVED" \
  -H "x-executor-secret: $PPP_SECRET" | jq '{ok, force_rebuild, reserved_count, deleted_queue_count, deleted_reservation_count, plan_health}'
```

Или дождаться автоматического Railway cron в 17:00 Minsk (14:00 UTC).

---

### 4. Убедиться что Railway cron настроен правильно

| Cron job | Schedule (UTC) | Endpoint |
|----------|----------------|---------|
| Night reservations | `0 14 * * *` (17:00 Minsk) | POST `/api/cron/night-event-reservations` |
| Night email | `5 14 * * *` (17:05 Minsk) | GET `/api/cron/night-plan-email?mode=plan` |
| Alert email | `45 14 * * *` (17:45 Minsk) | GET `/api/cron/night-plan-email?mode=alert` |
| Event rebalance | `*/5 * * * *` | POST `/api/cron/event-rebalance` |

Все запросы с header: `x-executor-secret: <EXECUTOR_CANDIDATES_SECRET>`

---

### 5. Ночной цикл — ожидаемая последовательность

```
14:00 UTC  →  reservation cron создаёт ночной план (in_creation_window=true)
14:05 UTC  →  email отправляется founder
~T-60m     →  rebalance cron видит due_count>0, пишет в event_execution_queue
~T-45m     →  Ireland watcher: candidate_count>0, WOULD_EXECUTE (hard-stop ON)
```

---

### 6. Если Ireland watcher показывает `WOULD_EXECUTE` корректно

→ Переходим к Phase 4 (CEO audit) → Phase 5 (first live order)

---

## GO/NO-GO

| | |
|---|---|
| PREMVP code | **GO** — патч задеплоен |
| PREMVP runtime | **PENDING** — проверить doctor после Railway deploy |
| Ireland | **GO** — queue-only watcher в log-mode |
| First live order | **NO-GO** — нужен Phase 4 CEO audit + explicit approval |
