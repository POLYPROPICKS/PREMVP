# GO/NO-GO Checklist — Contur3 Ireland Queue-Only

## Статус на 2026-06-23

| # | Проверка | Статус |
|---|----------|--------|
| 1 | PREMVP doctor ALL PASS на production | ✅ PASS (Phase 1 подтверждён) |
| 2 | `/api/executor/queue` возвращает 401 без секрета | ✅ PASS |
| 3 | `/api/executor/queue` source=event_execution_queue | ✅ PASS |
| 4 | ireland_contract: do_not_rank/broad/tier2_tier3 = true | ✅ PASS |
| 5 | `/api/executor/night-plan` candidates=[] diagnostic_only=true | ✅ PASS |
| 6 | max_stake_usd=7 в queue контракте | ✅ PASS |
| 7 | Contur3 Phase 1 запатчен и задеплоен | ✅ PASS (commit 2b5a5da) |

---

## GO для Phase 2 (Queue-Only Setup на Ireland)

**GO**, если все пункты ниже выполнены:

- [ ] PREMVP Phase 1 задеплоен на Railway (commit `2b5a5da`)
- [ ] `IRELAND_VERIFY_ONLY_COMMANDS.sh` запущен на Ireland и показал ALL PASS
- [ ] Hard-stop `/tmp/PPP_LIVE_HARD_STOP` присутствует на Ireland
- [ ] Нет запущенных старых процессов (`night_live_loop`, `pull_night_plan_candidates`)
- [ ] Есть доступ к Ireland серверу по SSH

**NO-GO**, если:
- PREMVP doctor не прошёл на production
- Hard-stop отсутствует на Ireland
- Старые процессы ещё работают

---

## GO для Phase 3 (первая ночь с активными резервациями)

- [ ] Watcher в log-mode работает хотя бы 1 ночной цикл без ошибок
- [ ] Reservations cron (~17:00 Minsk) создал строки в `night_event_reservations`
- [ ] Rebalance cron выписал строки в `event_execution_queue`
- [ ] Queue показал candidate_count > 0 с IN_WINDOW кандидатами
- [ ] Watcher залогировал `WOULD_EXECUTE` строки (не ошибки)
- [ ] Лог не содержит CONTRACT VIOLATION или CANDIDATE REJECTED

---

## GO для Phase 4 (Queue-Only CEO Audit)

- [ ] Phase 3 прошла успешно как минимум 2 ночи подряд
- [ ] Founder просмотрел логи watcher — нет аномалий
- [ ] Founder подтвердил что WOULD_EXECUTE кандидаты выглядят корректно
- [ ] CEO проведён аудит queue контракта (аналогично Contur2 V4 Audit)

---

## GO для Phase 5 (First Live Order — Pilot)

**Требует явного CEO-approved action. НЕ может быть выполнена автоматически.**

- [ ] Phase 4 аудит пройден
- [ ] CEO explicitly approves: `--remove-hard-stop=CEO_APPROVED` flag
- [ ] max_live_orders = 1, stake_usd = 7 (Tier1 only)
- [ ] Founder готов наблюдать в реальном времени
- [ ] Резервный стоп-план сформирован (как восстановить hard-stop)

---

## Счётчик до первого живого ордера

| Фаза | Действие | Готовность |
|------|---------|------------|
| Phase 1 | PREMVP automation complete | ✅ DONE |
| Phase 2 | Ireland queue-only runbook | ✅ DONE (этот коммит) |
| Phase 2 exec | Founder запускает IRELAND_QUEUE_ONLY_COMMANDS.sh | ⏳ Operator action |
| Phase 3 | Первая полная ночь watcher в log-mode | ⏳ Next night cycle |
| Phase 4 | CEO audit queue contract | ⏳ After Phase 3 |
| Phase 5 | First live order (CEO approved) | ⏳ After Phase 4 |

**Минимум ещё 3 оператор-действия + 1 ночной цикл до первого живого ордера.**
