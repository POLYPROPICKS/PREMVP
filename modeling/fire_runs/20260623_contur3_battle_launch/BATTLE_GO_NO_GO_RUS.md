# Contur3 Battle — GO/NO-GO Инструкция (Минск, 23 июня 2026)

## Что такое "battle" (бой)

Contur3 Battle — это режим, при котором Ирландский исполнитель в период
**с 22:00 до 07:00 по Минску** отправляет ставки **по всем** валидным
кандидатам из очереди `event_execution_queue`, **а не один пилотный ордер**.

Каждый кандидат — отдельное событие, предварительно зарезервированное
план-раном ≈17:00. Не один контроль, не пилот — все события до 07:00.

## Условия для UNLOCK (разрешение отправки)

| Условие | Проверка |
|---------|----------|
| Хард-стоп снят основателем | `--remove-hard-stop=CEO_APPROVED` |
| Источник очереди = `event_execution_queue` | `queue.source` |
| Контракт Ирландии не нарушен | `ireland_contract.do_not_rank=true` |
| Все кандидаты прошли валидацию | `RESULT_GO_READY_FOR_CEO_UNLOCK` |
| Старые обёртки не активны | quarantine-check |
| `/api/executor/night-plan` не используется | verify-скрипт |

## Процесс

1. Запустить `PHASE4_BATTLE_DUE_WINDOW_WINDOWS.cmd` (на Windows) → убедиться в `RESULT_GO_READY_FOR_CEO_UNLOCK`
2. На Ireland-сервере: `bash IRELAND_BATTLE_QUEUE_ONLY_VERIFY.sh` → `ALL_PASS_IRELAND_BATTLE_QUEUE_ONLY_VERIFY`
3. Основатель даёт команду: `bash IRELAND_BATTLE_QUEUE_ONLY_INSTALL_AND_UNLOCK.sh --remove-hard-stop=CEO_APPROVED`
4. Запустить watcher: `python3 scripts/contur3_battle_queue_only_watcher.py --remove-hard-stop=CEO_APPROVED`
5. Следить за `logs/contur3_battle_watcher.log`

## Когда ОСТАНОВИТЬ

| Сигнал | Действие |
|--------|----------|
| Кандидаты без `condition_id` / `token_id` | СТОП, не разблокировать |
| `queue.source` ≠ `event_execution_queue` | СТОП немедленно |
| Исполнение отправляет через `/night-plan` | СТОП немедленно |
| Unexplained orders в Polymarket | СТОП, rollback |
| `bad_market_level_count > 0` | СТОП, rebuild резерваций |

## Откат (Rollback)

**Скопировать и выполнить на Ireland-сервере:**

```bash
touch /tmp/PPP_LIVE_HARD_STOP data/PPP_LIVE_HARD_STOP
pkill -f "[c]ontur3_battle_queue_only_watcher.py" || true
```

Затем проверить: `ls /tmp/PPP_LIVE_HARD_STOP` — должен существовать.

## Ключевые факты

- Ставка на кандидата: **$7** (Tier1, зафиксировано)
- Источник: только `event_execution_queue` (не `night-plan`, не `candidates`)
- Ирландия: не ранжирует, не тянет широкий пул, не применяет Tier2/3
- Кандидаты: все READY с `latest_entry_iso` > now, упорядочены по `preferred_entry_iso`
- Исполнение: последовательное (не параллельное)
- Дублей: нет (проверка `order_key`)
