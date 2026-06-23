# Remaining Roadmap — Contur3 Post-Phase-2

## Текущий статус

- **Phase 1 COMPLETE** (commit `2b5a5da`, pushed, Railway deploy pending)
- **Phase 2 COMPLETE** (этот коммит — runbook готов, Ireland ещё не тронут)

---

## Оставшиеся риски (production)

| # | Риск | Серьёзность | Митигация |
|---|------|-------------|-----------|
| R1 | `night_event_reservations` пуста к моменту rebalance (нет футбольных матчей в окне) | MEDIUM | Watcher логирует next_due_iso, email алерт при shortage |
| R2 | Railway cron jobs не настроены → reservations и rebalance не запускаются автоматически | HIGH | **Оператор должен настроить крон в Railway UI** |
| R3 | Ireland тянет `/api/executor/night-plan` через старый скрипт параллельно с queue-watcher | HIGH | Карантин старых скриптов в Phase 2 setup |
| R4 | `event_execution_queue` строки expired до входа в окно (Ireland не смотрит) | MEDIUM | `latest_entry_iso` → watcher логирует expired кандидатов |
| R5 | RESEND env vars отсутствуют → night email не уходит, но Ireland работает без него | LOW | Фаундер проверяет Railway env RESEND_API_KEY + EMAIL_FROM |
| R6 | Polymarket spread/price изменился к моменту входа | MEDIUM | Phase 5 — sender должен проверять spread перед ордером |
| R7 | Ireland server reboot → hard-stop `/tmp/PPP_LIVE_HARD_STOP` исчезает (tmpfs) | HIGH | `data/PPP_LIVE_HARD_STOP` персистентен; watcher проверяет оба |

---

## Phase 3: Первая ночь в log-mode

**Оператор:** SSH на Ireland → запустить watcher → наблюдать логи.

```bash
# На Ireland сервере
cd /home/ubuntu/polymarket-executor

# Запустить watcher
read -rsp 'Enter executor secret: ' PPP_SECRET && echo
nohup python3 live/contur3_queue_only_watcher.py \
  --secret="$PPP_SECRET" \
  > logs/queue_watcher_$(date -u +%Y%m%d_%H%M%SZ).log 2>&1 &
echo "Watcher PID: $!"

# Следить за логом
tail -f logs/queue_watcher_*.log
```

Ожидаемые лог-строки к ~T-60 перед матчем:
```
[queue-watcher] INFO candidate_count=1  source=event_execution_queue  schema=executor-queue-v1
[queue-watcher] INFO CANDIDATE VALID [1/1] pair:team-a-vs-team-b:2026-06-23 side=YES ...
[queue-watcher] INFO HARD_STOP GATE: 1 valid candidate(s) ready. Execution blocked by hard-stop.
[queue-watcher] INFO   WOULD_EXECUTE: pair:team-a-vs-team-b:2026-06-23 side=YES stake=$7 ...
```

---

## Phase 4: CEO Queue Contract Audit

Аналог `CONTUR2_V4_AUDIT_20260622.md` но для Contur3 queue контракта.

Проверить:
- schema = `executor-queue-v1`
- source = `event_execution_queue`
- ireland_contract все флаги = true
- Все WOULD_EXECUTE кандидаты выглядят корректно
- Нет CONTRACT VIOLATION в логах
- Нет CANDIDATE REJECTED в логах

---

## Phase 5: First Live Order

**Требует явного CEO approval и ручного действия.**

1. CEO подтверждает Phase 4 аудит.
2. Founder добавляет `--remove-hard-stop=CEO_APPROVED` в команду запуска watcher.
3. Sender (Polymarket) wirings добавляются в watcher (Phase 5 TODO в коде).
4. `max_live_orders=1`, `stake_usd=7`, один матч.
5. После ордера — восстановить hard-stop, проверить исполнение.

---

## Railway Cron Jobs (настроить вручную в Railway UI)

| Cron job | Schedule | Endpoint |
|----------|----------|---------|
| Night reservations | `0 14 * * *` (17:00 Minsk = 14:00 UTC) | POST `/api/cron/night-event-reservations` |
| Night email | `5 14 * * *` (17:05 Minsk) | GET `/api/cron/night-plan-email?mode=plan` |
| Alert email | `45 14 * * *` (17:45 Minsk) | GET `/api/cron/night-plan-email?mode=alert` |
| Event rebalance | `*/5 * * * *` (every 5 min) | POST `/api/cron/event-rebalance` |

Все крон-запросы требуют header: `x-executor-secret: <EXECUTOR_CANDIDATES_SECRET>`.
