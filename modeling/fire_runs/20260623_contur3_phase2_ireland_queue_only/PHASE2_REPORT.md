# PHASE 2 / STEP 2.1 — Ireland Queue-Only Runbook — Report

**Date:** 2026-06-23  
**Phase 1 HEAD:** `2b5a5da` (deployed)  
**Phase 2 artifacts:** this folder

---

## Статус Phase 1 (подтверждён)

| Проверка | Результат |
|----------|-----------|
| PREMVP doctor ALL PASS | ✅ |
| queue 401 без секрета | ✅ |
| queue source=event_execution_queue | ✅ |
| queue ireland_contract intact | ✅ |
| night-plan candidates=[] diagnostic_only | ✅ |
| Hard-stop ON (Ireland) | ✅ (из Contur2 V4 Audit) |

---

## Что создано в Phase 2

| Файл | Назначение |
|------|-----------|
| `IRELAND_VERIFY_ONLY_COMMANDS.sh` | Безопасная проверка состояния Ireland перед setup |
| `IRELAND_QUEUE_ONLY_COMMANDS.sh` | Setup: карантин, hard-stop, конфиг, деплой watcher, старт |
| `GO_NO_GO_CHECKLIST.md` | Чеклист GO/NO-GO для Phase 2-5 |
| `REMAINING_ROADMAP.md` | Roadmap: риски, Railway cron, Phase 3-5 инструкции |
| `PHASE2_REPORT.md` | Этот отчёт |

---

## Ключевые свойства watcher (contur3_queue_only_watcher.py)

**Источник:** только `https://polypropicks.com/api/executor/queue`  
**Запрещённые источники:** ни один другой — night-plan, candidates, cron endpoints  
**Hard-stop:** проверяется КАЖДУЮ итерацию — `/tmp/PPP_LIVE_HARD_STOP` + `data/PPP_LIVE_HARD_STOP`  
**Режим по умолчанию:** LOG-ONLY (WOULD_EXECUTE, не выполняет ордера)  
**Разблокировка:** только `--remove-hard-stop=CEO_APPROVED` (Phase 5)  

Валидация каждого кандидата:
- `is_executable = true`
- `tier = TIER1`
- `stake_usd = 7`
- `condition_id` + `token_id` + `side` — все присутствуют
- `preferred_entry_iso` + `latest_entry_iso` — присутствуют
- Halftime/first-half рынок — REJECT

Контрактная валидация:
- `schema = executor-queue-v1`
- `source = event_execution_queue`
- `ireland_contract.do_not_rank = true`
- `ireland_contract.do_not_pull_broad_candidates = true`
- `ireland_contract.do_not_apply_tier2_tier3 = true`

---

## Gate 1

| Проверка | Результат |
|----------|-----------|
| Build PASS | ✅ (только proof artifacts) |
| bash -n IRELAND_VERIFY_ONLY_COMMANDS.sh | ✅ |
| bash -n IRELAND_QUEUE_ONLY_COMMANDS.sh | ✅ |
| Только разрешённые файлы | ✅ (только modeling/fire_runs/) |
| Запрещённые файлы не тронуты | ✅ |

**Gate 1: PASS**
