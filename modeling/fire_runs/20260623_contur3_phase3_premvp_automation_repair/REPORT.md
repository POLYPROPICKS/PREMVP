# PHASE 3 / STEP 3.2 — PREMVP Reservation Automation Repair

**Date:** 2026-06-23  
**Build:** PASS (✓ Compiled successfully)

---

## Корневая причина

`buildPlanRunId(nowMs)` использует только **Minsk calendar date**, без учёта часа. Любой вызов
`/api/cron/night-event-reservations` в 10:00 Minsk генерирует тот же `plan_run_id`
`night-plan:2026-06-23:1700-minsk`, что и в 17:00. При этом:

- `isWithinHorizon` от 10:00 включает матчи `now → now+18h`, т.е. события в 11:00–13:00 UTC,
  которые стартуют до открытия операционного окна (17:00 Minsk = 14:00 UTC).
- Эти строки сохраняются в `night_event_reservations`.
- К 17:00 Minsk эти строки уже истекли/неактивны.
- `already_exists=true` → `persistReservationPlan` возвращает старые строки без пересоздания.
- Rebalance видит `due=0, next=None` — пустая очередь, Ireland ждёт вечно.

**Дополнительно:** `force=1` очищал только `night_event_reservations`, не затрагивая 
`event_execution_queue` — несогласованное состояние.

---

## Изменённые файлы

| Файл | Что изменено |
|------|-------------|
| `lib/executor/nightWindow.ts` | +`minskHourOf`, +`isInReservationCreationWindow`, +константы окна создания |
| `lib/executor/nightEventReservations.ts` | +`PlanHealth` интерфейс, +`loadPlanStatus`, +`executeForceRebuild`, +`ForceRebuildResult` |
| `app/api/cron/night-event-reservations/route.ts` | `mode=status`, creation window guard, `forceRebuild=CEO_APPROVED`, `plan_health` в ответе |
| `scripts/contur3_premvp_doctor.sh` | Phase 3 checks: expired-only, bad keys, cross-check rebalance, ALL_PASS_PHASE3 |

---

## Goals

| Goal | Описание | Статус |
|------|---------|--------|
| A | `plan_health` объект в ответе | ✅ |
| B | Гард раннего создания (08:00–16:30 Minsk) | ✅ |
| C | `forceRebuild=CEO_APPROVED` (очистка queue + reservations + rebuild) | ✅ |
| D | Doctor: expired-only, bad keys, cross-check, ALL_PASS_PHASE3 | ✅ |
| E | Proof artifacts | ✅ |

---

## Было ли возможно раннее создание устаревшего плана?

**ДА.** До патча: вызов в любое время дня создавал `plan_run_id` с датой сегодня,
включал матчи от текущего момента до +18h, они истекали до окна.
После патча: вне окна 16:30–08:00 Minsk — только статус, без записи.

---

## Как вызвать force rebuild

```bash
curl -X POST \
  "https://polypropicks.com/api/cron/night-event-reservations?forceRebuild=CEO_APPROVED" \
  -H "x-executor-secret: $PPP_SECRET"
```

Что делает:
1. Удаляет `event_execution_queue` WHERE `plan_run_id = current`
2. Удаляет `night_event_reservations` WHERE `plan_run_id = current`
3. Пересоздаёт план из текущей вселенной
4. Возвращает `force_rebuild: true`, `deleted_queue_count`, `deleted_reservation_count`, `plan_health`

---

## Gate 1

| Проверка | Результат |
|----------|-----------|
| `git status` tracked dirty | CLEAN |
| Build | PASS |
| Только разрешённые файлы | PASS |
| bash -n doctor.sh | PASS |
| Запрещённые файлы не тронуты | PASS |

**Gate 1: PASS**
