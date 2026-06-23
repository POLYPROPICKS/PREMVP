# Next Operator Steps — Contur3 PREMVP Phase 1

## Для завершения Phase 1 (после деплоя этого коммита)

1. **Дождаться Railway PREMVP деплоя**
   - Проверить что коммит `Executor: complete Contur3 PREMVP automation diagnostics` задеплоен
   - Railway PREMVP: `Deployment successful` для этого хэша

2. **Запустить doctor-скрипт против production:**
   ```bash
   BASE=https://polypropicks.com PPP_SECRET=<твой_секрет> bash scripts/contur3_premvp_doctor.sh
   ```
   Ожидаемый результат: ALL PASS

3. **Верифицировать reservations cron:**
   Если сегодня ещё не запускался (~17:00 минск):
   ```bash
   curl -s -H "x-executor-secret: $PPP_SECRET" \
     "https://polypropicks.com/api/cron/night-event-reservations" | jq '{ok,plan_run_id,reserved_count,already_exists}'
   ```

4. **Верифицировать rebalance dryRun:**
   ```bash
   curl -s -H "x-executor-secret: $PPP_SECRET" \
     "https://polypropicks.com/api/cron/event-rebalance?dryRun=1" | jq '{ok,due_count,queued_count,next_due_iso,ireland_autostart_expected}'
   ```

5. **Верифицировать queue:**
   ```bash
   curl -s -H "x-executor-secret: $PPP_SECRET" \
     "https://polypropicks.com/api/executor/queue?includeUpcoming=1" | jq '{ok,source,candidate_count,next_due_iso}'
   ```

---

## Для завершения всего Roadmap

| # | Действие | Кто |
|---|---------|-----|
| R1 | Убедиться что Railway cron jobs настроены: reservations ~17:00 Minsk, rebalance каждые 5-10 мин | Founder (Railway UI) |
| R2 | Убедиться что Ireland читает только `/api/executor/queue` и не вызывает night-plan | Founder (проверить ireland config) |
| R3 | Night email — проверить что RESEND_API_KEY и EMAIL_FROM выставлены в Railway env | Founder (Railway env vars) |
| R4 | После первой успешной ночи с реальными резервациями: проверить утренний отчёт CEO | Founder |
| R5 | Phase 2: ROI мониторинг + автоматическая отмена позиций — планировать отдельно | Founder + Claude Code |

---

## GO/NO-GO для Phase 2

**GO** если doctor-скрипт возвращает ALL PASS на production.  
**NO-GO** если doctor показывает FAIL по любому пункту — сначала починить.
