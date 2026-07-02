# CONTUR3_RECOVERY_INVARIANTS.md

Статус: КАНОНИЧЕСКИЙ RECOVERY-КОНТРАКТ. Обязателен для любого агента/патча в Contur3.
Создан: 2026-07-02, ветка `claude/contur3-forensic-review-0ucu55`, HEAD `d8341ac9`.
База заморозки: тег `contur3-global-review-freeze-2026-06-26` → `10d1256`.
Execution-slice не менялся от freeze до текущего HEAD (проверено `git diff --stat` по
`lib/executor`, `scripts/contur3`, `app/api/executor`, cron-роутам — дифф пуст).

## 1. Purpose

Этот файл — необсуждаемый ремонтный контракт восстановления Contur3.
Любой будущий патч, тест, лог или prompt обязан соответствовать инвариантам ниже.
Патч, нарушающий хотя бы один инвариант без явного founder-решения, отклоняется на Gate 1.
Доктрина: freeze → inventory → reproduce → classify bugs → define invariants →
tests/logging first → patch smallest unit → verify → commit.

## 2. Current recovery status

- Режим: FROZEN FORENSIC REVIEW. База — freeze-тег `10d1256`.
- Live-исполнение, Ireland, ордера: ЗАПРЕЩЕНЫ до Live Gate (§13).
- Patch-loop («симптом → микропатч без теста»): ЗАПРЕЩЁН (§14).
- PR7 (`origin/claude/friendly-gauss-g1fisu` → `32cce27`): НЕ мержить as-is (§12).
- Любой поведенческий патч ЗАПРЕЩЁН до: (a) тестов по §11, (b) свежего канонического
  DB-backed лога по §10.

## 3. Pipeline contract

Канонический контур (каждый переход обязан быть наблюдаем в логе §10):

```
generated_signal_pairs / research snapshots
  → buildFireModelCandidates (lib/executor/buildFireModelCandidates.ts)
  → buildReservationPlan / persistReservationPlan (lib/executor/nightEventReservations.ts)
  → night_event_reservations
  → runEventRebalance (lib/executor/eventExecutionQueue.ts)
  → event_execution_queue
  → GET /api/executor/queue (app/api/executor/queue/route.ts)
  → Ireland executor
  → queue/mark + order-events + executor_audit_events
  → canonical live funnel log (scripts/contur3/lib/contur3LiveFunnelMonitor.mjs)
```

## 4. Business invariant

Каждый реальный предстоящий физический матч football/FIFA обязан:
- иметь как минимум один валидный live-allowed full-match путь
  candidate → reservation → queue,
ЛИБО
- иметь точную машиночитаемую причину блокировки на той стадии, где путь остановился.

Тихий дроп (ряд исчез между стадиями без причины) = P0-аномалия.
Контрольный симптом: `RAW_ALLOWED_FULLMATCH_GT0_BUILDER_FULLMATCH_EQ0` без трейса причин.

## 5. Taxonomy invariants

1. РОВНО ОДИН канонический источник таксономии рынков. Целевой модуль —
   извлечение `classifyMarket` из `scripts/contur3/lib/contur3LiveFunnelMonitor.mjs`
   в общий importable-модуль. Сейчас копий ЧЕТЫРЕ (нарушение, зафиксировано):
   - monitor `classifyMarket` (6 forbidden-классов);
   - `lib/executor/eventExecutionQueue.ts` `HALFTIME_MARKET_RE` (только halftime);
   - `app/api/executor/night-plan/route.ts` `HALFTIME_MARKET_RE` (только halftime);
   - PR7 `classifyFullmatchMarket` / `FM_*` (копия + esports).
2. Forbidden всегда побеждает allowed («halftime total» → forbidden).
3. Unknown — fail-closed: неклассифицированный рынок считается forbidden для live.
4. Forbidden-классы: halftime/first-half/second-half; corners; exact/correct score;
   goalscorer (any/first/last); player props / bookings / cards / BTTS;
   futures / outrights / winner-group.
5. Allowed только full-match moneyline / spread(handicap) / total — и только если
   не сработал ни один forbidden-класс.
6. Esports — явный отдельный policy-класс (не «unknown»), решение по нему — founder-policy.
7. Один и тот же классификатор обязаны использовать builder, reservation planner,
   queue builder и monitor. Расхождение классов между логом и поведением = P0.

## 6. Identity invariants

Текущая реализация: `deriveMatchFamilyKey` + `buildIdentityText` в
`lib/executor/buildFireModelCandidates.ts` (IdentityQuality: STRONG/MEDIUM/WEAK/INVALID).

1. Один физический матч → один и тот же `match_family_key`, детерминированно.
2. Разные рынки одного физического матча (moneyline/spread/total) → один family key.
3. Fallback на `condition_id` (`WEAK_MARKET_LEVEL_KEY:*`) — всегда quality=WEAK,
   всегда логируется; WEAK не может быть live-eligible
   (см. `WEAK_MATCH_FAMILY_KEY_LIVE_BLOCKED` там же).
4. Нормализация `event_slug` детерминирована (trim + lowercase, без скрытых вариаций).
5. Извлечение пары команд («A vs B») детерминировано и стабильно к порядку/регистру.
6. Смешение event-level и market-level ключей без диагностической причины запрещено;
   single-team spread не образует самостоятельную STRONG/MEDIUM семью
   (см. `SINGLE_TEAM_SPREAD_RE`, `WEAK_SINGLE_TEAM_SPREAD:*`).

## 7. Builder admission invariants

1. Каждый raw live-allowed full-match ряд из БД обязан стать admitted-кандидатом
   ИЛИ получить rejected-запись с точной причиной (модель учёта из PR7).
2. Баланс обязателен: `raw_allowed_fullmatch_rows === fullmatch_admitted_count +
   Σ fullmatch_rejected_by_reason`. Небаланс = тихий дроп = P0.
3. Forbidden-ряды никогда не становятся кандидатами.
4. Валидный кандидат обязан иметь: `condition_id`, `token_id`, side/outcome,
   entry price, game start time, market class, identity strength.
5. Диагностика учитывает ВСЕ ряды всех queried formula versions
   (`versions_queried` / `versions_with_zero_db_rows`).

## 8. Reservation invariants

Текущая реализация: `buildReservationPlan` / `persistReservationPlan` в
`lib/executor/nightEventReservations.ts`.

1. Никаких halftime-резерваций. Никаких forbidden-рынков в резервациях.
2. Tier1 выбирается первым; Tier2/Tier3 slot-fill ladder — только для канонических
   allowed full-match рынков.
3. Dedupe по `match_family_key`: один матч — не более одной активной резервации.
4. Underfill (слоты не заполнены) обязан иметь точную причину на каждый незанятый слот.
5. DB-записи — только в явных persist-функциях (`persistReservationPlan`,
   `persistReservationPlanDiagnostics`); план-функции обязаны быть чистыми
   относительно записи.

## 9. Queue invariants

Текущая реализация: `runEventRebalance` в `lib/executor/eventExecutionQueue.ts`.

1. Одна due-резервация → не более одного активного queue-ряда (идемпотентность).
2. Никаких halftime/forbidden queue-рядов.
3. Queue-ряд обязан содержать: `condition_id`, `token_id`, side, stake, window,
   `reservation_id`, `match_family_key`.
4. Dry-run НЕ МОЖЕТ писать. Сейчас граница — только флаг `opts.write === true`
   (строка `const write = opts.write === true`); целевое состояние — структурная
   граница (pure core без DB-клиента + отдельный writer). До рефактора любой вызов
   с write=true вне cron-роута запрещён.
5. Форма ответа `GET /api/executor/queue` — контракт Ireland; менять только с
   контракт-тестом и явным founder-решением.

## 10. Logging / observability invariants

Канонический лог (contur3:live-funnel-log) обязан показывать за окно 24h/72h:
source rows; research rows; raw full-match rows; raw forbidden rows (по классам);
builder candidates; admitted/rejected_by_reason; tier distribution;
reservations accepted/rejected_by_reason; active; due now; rebalance attempts;
queue rows (по статусам); executor API visible rows; audit/order rows;
deployment commit hash (Railway) + repo HEAD; stale jobs; hard anomalies;
machine verdict; machine next action.

Правила:
1. Отсутствующее измерение = `MEASUREMENT_MISSING` с точной причиной.
   Запрещено молча считать отсутствие нулём.
2. Лог без Supabase env обязан честно выдавать `STOPPED_DB_ENV_MISSING`
   (текущее поведение монитора — корректное), и такой скелет не является доказательством.
3. Лог старше 6 часов = STALE; STALE-лог не является доказательством для патча/live.
4. Диагностика, доступная только через secret-gated роут, не считается
   наблюдаемостью для оператора: всё критичное обязано попадать в канонический лог.
5. Генерируемые отчёты не должны пачкать отслеживаемое git-дерево
   (целевое место — git-ignored каталог; текущее `reports/contur3/` — нарушение).

## 11. Testing invariants

Обязательные группы тестов до любого поведенческого патча:
- taxonomy tests (корпус реальных названий, forbidden-wins, fail-closed);
- identity tests (family key, WEAK fallback, нормализация);
- builder admission tests (баланс admitted+rejected, ноль тихих дропов);
- reservation tests (no-forbidden, tier ladder, dedupe, underfill reasons);
- queue tests (идемпотентность, форма ряда, dry-run no-write);
- monitor/log tests (MEASUREMENT_MISSING, verdict-матрица, stale-метка);
- executor API contract tests (форма ответа queue/mark/order-events).

Первые пять тестов (порядок обязателен):
1. «halftime total» классифицируется как forbidden (forbidden wins).
2. Unknown-рынок — forbidden/fail-closed.
3. `raw_allowed_fullmatch_rows === admitted + Σ rejected_by_reason` (ноль тихих дропов).
4. Один физический матч → один `match_family_key` (moneyline+total одного матча — одна семья).
5. Dry-run queue builder физически не может писать.

Тест, требующий изменить прод-поведение, НЕ меняет прод: он фиксируется как
найденный баг в design brief и ждёт отдельного патч-решения.

## 12. PR7 policy

- PR7 (`32cce27`, +116/−0, 2 файла) содержит ценные диагностические концепции:
  поля diagnostics, учёт admitted/rejected-with-exact-reason,
  `missing_fullmatch_fixtures[]` trace.
- PR7 НЕ мержится as-is до taxonomy/logging/test review.
- Переиспользовать: схему полей, модель учёта, trace.
- НЕ переиспользовать без тестов: дублирующий regex-классификатор
  `classifyFullmatchMarket` / `FM_*` (найдены латентные дефекты: `\bdraw\b` и `\bou\b`
  мертвы после strip-нормализации; `/total|over|under/` матчит подстроки имён команд).
- Диагностика обязана доставляться в канонический live funnel log, а не только
  через secret-gated `GET /api/executor/night-plan`.

## 13. Live execution gate

Live/Ireland/ордера разрешаются ТОЛЬКО при одновременном выполнении:
1. Все группы тестов §11 зелёные в CI.
2. Свежий (< 6h) канонический DB-backed лог без `MEASUREMENT_MISSING` на critical-стадиях.
3. Deployment commit hash известен и совпадает с проверенным кодом.
4. Ноль необъяснённых hard anomalies за 72h.
5. Контракт executor API верифицирован read-only тестом.
6. Явное письменное одобрение фаундера.

## 14. Forbidden recovery patterns

Запрещены без исключений:
- «симптом → случайный патч» без падающего теста и трейса причин;
- merge диагностики, которую оператор не может потребить (только secret-роут);
- патч без предварительно падающего теста;
- запуск live до полной наблюдаемости;
- доверие STALE-логу как свежему доказательству;
- доверие кэшированной/недоступной диагностике;
- запись в БД во время инспекции (внимание: `GET /api/executor/night-plan`
  пишет `executor_order_events` и `executor_audit_events` — «читающий» вызов
  мутирует состояние; учитывать при любом аудите);
- широкий рефактор вместо smallest-unit патча;
- push/deploy без явной founder-авторизации.
