# Phase 5 — CEO GO/NO-GO для Ireland Live Unlock

## Когда запускать

Запускай `IRELAND_PHASE5_CEO_UNLOCK_COMMAND.sh` только после того, как:

1. Команда Phase 4 (`PHASE4_DUE_WINDOW_ONE_COMMAND_WINDOWS.cmd`) вернула **RESULT: GO**.
2. `candidate_count > 0` в ответе очереди.
3. Ты принял решение о старте торговли сегодня.

**Ни в коем случае не запускай до появления кандидатов в очереди.**
Очередь пополняется ребалансом примерно за 60 минут до старта каждого матча.

---

## Как запускать

### Шаг 1 — Валидация (без удаления стопа)
```bash
cd /home/ubuntu/polymarket-executor
bash IRELAND_PHASE5_CEO_UNLOCK_COMMAND.sh
```
Смотри вывод. Все проверки должны быть `PASS`.

### Шаг 2 — Реальный unlock (если Шаг 1 прошёл)
```bash
cd /home/ubuntu/polymarket-executor
bash IRELAND_PHASE5_CEO_UNLOCK_COMMAND.sh --remove-hard-stop=CEO_APPROVED
```

---

## Что означает GO

Скрипт напечатал `ALL VALIDATION PASSED` и `IRELAND LIVE UNLOCK COMPLETE`.

Финальное доказательство должно показывать:
- `hardstop_absent: true`
- `queue_source: event_execution_queue`
- `candidate_count > 0`
- Процесс `contur3_queue_watcher` запущен и виден в `pgrep`
- Последние строки лога не содержат `ERROR` или `HARD_STOP`

---

## Что означает STOP

Любой `FAIL` в выводе — **не запускай**. Типичные причины:

| Сообщение | Действие |
|---|---|
| `candidate_count=0` | Жди реbalance — очередь ещё не пополнена |
| `queue source != event_execution_queue` | Критично — проверь PREMVP Railway logs |
| `bad_market_level_count > 0` | Запусти `forceRebuild=CEO_APPROVED` на PREMVP |
| `plan is EXPIRED_ONLY` | Зарезервируй план заново (`forceRebuild=CEO_APPROVED`) |
| `Old wrapper is executable` | `chmod -x scripts/run_ireland_trusted_live.sh` и т.д. |
| `Existing live-order process` | `kill` старый процесс перед стартом |
| Candidate `stake_usd > 7` | Стоп — нарушение политики ставок, не запускай |
| Candidate не TIER1 | Стоп — Tier2/Tier3 никогда не должны попасть в очередь |

---

## Что не трогать

- Не меняй `config/executor-source.env` вручную.
- Не запускай старые враперы (`run_ireland_trusted_live.sh`, `ireland_trusted_pull_loop.py` и т.д.).
- Не удаляй hard-stop вручную без прохождения скрипта.
- Не вызывай `/api/executor/night-plan` напрямую с Ireland — это diagnostic-only.

---

## Rollback (экстренная остановка)

```bash
# 1. Восстанови hard-stop
touch /tmp/PPP_LIVE_HARD_STOP
touch /home/ubuntu/polymarket-executor/data/PPP_LIVE_HARD_STOP
echo "Hard-stop restored"

# 2. Убей watcher
pkill -f contur3_queue_watcher || true
echo "Watcher killed"

# 3. Проверь
pgrep -fa contur3 || echo "No contur3 processes — OK"
ls /tmp/PPP_LIVE_HARD_STOP && echo "Hard-stop active"
```

После rollback — позвони / напиши оператору, не трогай ничего до разбора.
