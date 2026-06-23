# Night Plan Email — Railway Action

## Статус кода

Маршрут `app/api/cron/night-plan-email/route.ts` **уже существует** и поддерживает:
- `mode=plan` — читает `night_event_reservations` (замороженный план), отправляет email.
- `mode=alert` — отправляет только если события не зарезервированы.
- Читает замороженные резервации, **не** stateless planner.
- Нужны env: `RESEND_API_KEY`, `EMAIL_FROM` (уже в PREMVP), `NIGHT_PLAN_EMAIL_TO` (опционально, дефолт alexgrushin@gmail.com).

**Патч не нужен.**

---

## Railway Action — добавить night plan email

### Вариант 1 — Добавить второй cron hit к существующему `ops-report-email-cron`

Railway позволяет одному сервису иметь одно расписание. Для второго хита создай отдельный cron-сервис (Вариант 2).

### Вариант 2 — Создать отдельный Railway Cron Service (рекомендуется)

1. Railway Dashboard → PREMVP project → **New Service** → **Cron Job**.
2. Имя: `contur3-night-plan-email-cron`.
3. Schedule: `40 13 * * *` (13:40 UTC = 16:40 Minsk — после создания резерваций в 17:00 Minsk / ~14:00 UTC).
4. Command:
   ```
   curl -f -X GET \
     "https://polypropicks.com/api/cron/night-plan-email?mode=plan&source=railway_night_plan_email" \
     -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET"
   ```
5. Environment Variables (reference existing PREMVP vars):
   - `EXECUTOR_CANDIDATES_SECRET` — уже есть в PREMVP
   - `RESEND_API_KEY` — уже есть в PREMVP (ops-report-email-cron)
   - `EMAIL_FROM` — уже есть в PREMVP
   - `NIGHT_PLAN_EMAIL_TO` — опционально, дефолт alexgrushin@gmail.com

**Это не блокирует живую торговлю.** Email — информационный. Ireland не зависит от него.

---

## Расписание (UTC / Minsk)

| Cron | UTC | Minsk | Описание |
|---|---|---|---|
| `contur3-night-reservations-cron` | 14:00 | 17:00 | Создаёт резервации |
| `contur3-night-plan-email-cron` | 13:40 | 16:40 | Email с планом на вечер |
| `contur3-event-rebalance-cron` | каждые 5-10 мин | — | Пополняет очередь |

Порядок важен: email cron должен срабатывать **после** создания резерваций.
Если Railway запускает cron по UTC, убедись что расписание `40 13 * * *` не раньше резерваций.
Если резервации создаются в 14:00 UTC, то email в 13:40 UTC будет до резерваций — сдвинь на `50 14 * * *` (14:50 UTC = 17:50 Minsk).

**Рекомендуемый финальный schedule**: `50 14 * * *` (через 50 минут после создания резерваций).
