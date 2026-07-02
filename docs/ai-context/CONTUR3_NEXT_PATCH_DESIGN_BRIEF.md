# CONTUR3_NEXT_PATCH_DESIGN_BRIEF.md

Статус: design-brief для следующего overnight repair prompt. РЕАЛИЗАЦИИ НЕ СОДЕРЖИТ.
Создан: 2026-07-02, ветка `claude/contur3-forensic-review-0ucu55`, HEAD `d8341ac9`.
Парный документ: `docs/ai-context/CONTUR3_RECOVERY_INVARIANTS.md` (ремонтный контракт).

## 1. Purpose

Этот бриф готовит следующий высокоценный ремонтный prompt, но сам ничего не реализует.
Он фиксирует: доказанные факты с цитатами файл/функция, доказанные и подозреваемые
проблемы, целевую архитектуру, план тестов/логирования и ранжированные кандидаты
следующего патча. Ремонт по этому брифу возможен только после founder-решений (§11).

## 2. Current known facts (только факты, с уликами)

1. **Freeze/source state.** Тег `contur3-global-review-freeze-2026-06-26` → `10d1256`.
   Дифф freeze→HEAD (`d8341ac9`) по `lib/executor`, `scripts/contur3`,
   `app/api/executor`, cron-роутам — пуст. Slice не дрейфовал.
2. **Тестов нет.** `tests/` содержит analytics/liquidity/signals; ни одного файла
   по executor/contur3/taxonomy/reservations/queue (проверено glob по `*test*`).
3. **Канонический лог мёртв как улика.** `reports/contur3/live_funnel_latest.md`:
   `MACHINE VERDICT: STOPPED_DB_ENV_MISSING`, дата 2026-06-25, сгенерирован с ветки
   `f886053` (не freeze-коммит). Свежего DB-backed лога в репо нет.
4. **Таксономия в 4 копиях.**
   - `scripts/contur3/lib/contur3LiveFunnelMonitor.mjs` → `classifyMarket`,
     `FORBIDDEN_HALFTIME_RE`…`FORBIDDEN_FUTURES_RE` (6 forbidden-классов, forbidden wins);
   - `lib/executor/eventExecutionQueue.ts` → `HALFTIME_MARKET_RE` + `isHalftime()`
     (только halftime, другой regex-стиль, ненормализованный вход);
   - `app/api/executor/night-plan/route.ts` → свой `HALFTIME_MARKET_RE`
     (P0E_BLOCK_HALFTIME_MARKETS_V1, только halftime);
   - PR7 `lib/executor/buildFireModelCandidates.ts` (в ветке) →
     `classifyFullmatchMarket` + `FM_*` (копия монитора + `esports_non_policy`).
5. **PR7 (`32cce27`).** +116/−0 в 2 файлах; все вставки под `if (rawDiag)` —
   решения admission не изменены; добавляет учёт admitted/rejected-with-reason и
   `missing_fullmatch_fixtures[]`; доставка — только через secret-gated
   `GET /api/executor/night-plan` (`x-executor-secret` / `EXECUTOR_CANDIDATES_SECRET`);
   в canonical `contur3:live-funnel-log` диагностика не попадает.
6. **Identity-слой существует и структурирован** (важное уточнение нарратива):
   `deriveMatchFamilyKey` в `lib/executor/buildFireModelCandidates.ts` даёт
   quality STRONG/MEDIUM/WEAK/INVALID, приоритет event_slug → team_pair →
   condition_id(WEAK); WEAK блокируется от live
   (`WEAK_IDENTITY_LIVE_BLOCKED`, `WEAK_MATCH_FAMILY_KEY_LIVE_BLOCKED`).
   Проблема не в отсутствии логики, а в том, что она inline в ~1200-строчном
   файле и не покрыта тестами.
7. **Plan/persist граница в reservations существует**:
   `buildReservationPlan` (план) отделён от `persistReservationPlan` /
   `persistReservationPlanDiagnostics` (insert в `night_event_reservations`)
   в `lib/executor/nightEventReservations.ts`.
8. **Dry-run в rebalance — только флаг**: `runEventRebalance(opts)` →
   `const write = opts.write === true`; insert/update в `event_execution_queue`
   гейтятся `if (write)` в том же коде (`lib/executor/eventExecutionQueue.ts`).
   Структурной невозможности записи в dry-run нет.
9. **«Читающий» роут пишет в БД**: `GET /api/executor/night-plan` делает insert в
   `executor_order_events` (строка ~46) и `executor_audit_events` (строка ~193).
10. **Монитор-файл детектится как binary**: в
    `scripts/contur3/lib/contur3LiveFunnelMonitor.mjs` есть NUL-байт
    (~offset 19993); `file` → «binary data», ripgrep пропускает файл без флага `-a`.
11. **Отчёты пишутся в отслеживаемое дерево**: артефакты монитора лежат в
    `reports/contur3/*` (tracked), diagnostics rebalance пишутся через
    `writeFile` (`persistRebalanceDiagnostics`).
12. **Лог знает repo HEAD, но не деплой**: шапка live_funnel содержит Branch/HEAD
    локального репо; Railway deployment hash нигде не подтверждается.

## 3. Proven problems

| Категория | Улики | Почему важно | Что докажет починку |
|---|---|---|---|
| LOGGING_GAP | Факты 3, 5, 11, 12: stale-лог; PR7-диагностика только за секретом; отчёты в tracked-дереве; нет deploy-hash | Диагноз ставится вслепую → patch-loop; «чистый git status» ломается диагностикой | Свежий DB-backed лог со всеми стадиями §10 инвариантов + deploy hash; тест MEASUREMENT_MISSING |
| TEST_COVERAGE_GAP | Факт 2: ноль тестов на slice | Любой патч непроверяем; регрессии невидимы | Зелёный `tests/contur3/*` в CI, первые 5 тестов из инвариантов §11 |
| SOURCE_TAXONOMY_BUG (дрейф копий) | Факт 4: монитор запрещает 6 классов, queue/night-plan — только halftime | Монитор может считать ряд forbidden, а queue его пропустить (corners/props/futures) → лог не соответствует поведению → ложные P0 | Corpus-diff тест: один набор названий через все классификаторы, расхождения = 0 после унификации |
| MARKET_CLASSIFICATION_BUG (латентный, PR7) | `classifyFullmatchMarket`: `\bdraw\b`, `\bou\b` неработоспособны после `replace(/[^a-z0-9]+/g,"")`; `/total\|over\|under/` матчит подстроки («Sunderland»→`under`) | Диагностика PR7 будет систематически искажать классы → неверная цель следующего патча | Юнит-тесты классификатора на корпусе с этими кейсами |
| DOC_CONTEXT_DRIFT | Нарратив описывал identity как «scattered/weak», источник показывает структурированный `deriveMatchFamilyKey` с quality-гейтами (факт 6) | Агенты патчат по устаревшей карте → лишние «фиксы» рабочего кода | Данный бриф + refresh-ai-context после ремонта |

## 4. Suspected but unproven problems

| Категория | Почему подозревается | Какие улики нужны | Куда смотреть дальше |
|---|---|---|---|
| BUILDER_ADMISSION_BUG | Симптом `RAW_ALLOWED_FULLMATCH_GT0_BUILDER_FULLMATCH_EQ0` наблюдался (PR7 писался под него) | Свежий прогон с учётом admitted/rejected; баланс рядов | `buildFireModelCandidates`: цепочка `rejectReason()` вокруг score/coverage/tier (`TIER_BELOW_THRESHOLD`, `WEAK_EVENT_IDENTITY`) |
| IDENTITY_MAPPING_BUG | Inline-логика без тестов; team-pair extraction чувствительна к формату заголовков | Identity-тесты на фикстурах реальных slug/названий | `deriveMatchFamilyKey`, `buildIdentityText`, `SINGLE_TEAM_SPREAD_RE` |
| RESERVATION_PLANNER_BUG | Нет свежего лога accepted/rejected по слотам | DB-backed лог + тесты ladder | `buildReservationPlan` slot-fill, dedupe |
| QUEUE_BUILDER_BUG | Нет свежего лога due→queue переходов | DB-backed лог + идемпотентность-тест | `runEventRebalance` ветки EXPIRED/SKIPPED/QUEUED |
| DEPLOYMENT_MISMATCH | Stale-лог сгенерирован с ветки `f886053`; deploy hash нигде не фиксируется (факт 12) | Railway commit hash в логе + сверка с репо | Шапка монитора; Railway env |
| EXECUTOR_VISIBILITY_BUG | Диагностика за секретом; контракт queue не зафиксирован тестом | Контракт-тест формы `GET /api/executor/queue` | `app/api/executor/queue/route.ts` |
| IRELAND_EXECUTOR_BUG | Вне зоны текущей ревизии; сводкам исполнителя доверяли без сверки | Read-only статус Ireland; сверка order-events с queue | `ops/ireland/*`, `docs/ops/IRELAND_*` |

Ни одна из категорий §4 НЕ помечается как доказанная до свежего DB-backed лога.

## 5. Ideal architecture target

| Модуль | Ответственность | Текущее место | Целевое место | Граница side-effects |
|---|---|---|---|---|
| Taxonomy | classifyMarket, forbidden wins, fail-closed unknown, esports policy | monitor `classifyMarket` + 3 копии (факт 4) | общий pure-модуль (напр. `lib/contur3/taxonomy.ts`), импортируется всеми четырьмя потребителями | pure, ноль side-effects |
| Identity | family key, quality, slug-нормализация, team-pair | `deriveMatchFamilyKey`/`buildIdentityText` inline в `buildFireModelCandidates.ts` | извлечение в `lib/contur3/identity.ts` byte-эквивалентно | pure |
| Builder admission | raw row → candidate \| reject(reason), баланс рядов | тело цикла `buildFireModelCandidates` | pure-функция «ряд→решение», DB-fetch отдельно | pure core; fetch снаружи |
| Reservation planner | план слотов, ladder, dedupe | `buildReservationPlan` (уже отделён от persist) | сохранить; сузить план-функцию до pure над переданными данными | запись только `persistReservationPlan*` |
| Queue builder | due→queue row, идемпотентность | `runEventRebalance` с флагом `write` | pure core (расчёт рядов) + отдельный writer; dry-run без DB-клиента структурно | запись только writer’ом |
| Executor API contract | форма queue/mark/order-events для Ireland | `app/api/executor/*/route.ts` | заморозить контракт снапшот-тестом | audit-append документирован явно |
| Canonical monitor/log | все стадии, verdict, next action, deploy hash | `contur3LiveFunnelMonitor.mjs` (binary-байт, отчёты в tracked-дерево) | ядро-модуль + CLI; вывод в git-ignored каталог; санировать NUL | read-only к БД; пишет только отчёт-файлы вне tracked-дерева |
| Operator-safe CLI | одна команда → MD/JSON/NDJSON, verdict в первых строках | `npm run contur3:live-funnel-log` (падает в скелет без env) | та же команда, честный STOPPED без env, полный лог с env | read-only |

## 6. Code-review findings with improvement opportunities

| # | Finding | Файл/функция | Проблема | Риск | Будущее улучшение | Приоритет |
|---|---|---|---|---|---|---|
| 1 | 4 копии таксономии | факт 4 | монитор строже queue/night-plan (corners/props/futures не блокируются в queue-пути) | лог ≠ поведение; forbidden-рынок в очереди | единый pure-модуль + corpus-тест | **P0** |
| 2 | Латентные regex-баги PR7 | `classifyFullmatchMarket` (ветка PR7) | `\b` мертвы после strip-нормализации; over/under перематч | лгущая диагностика | переписать allowed-регексы под нормализованный вход + тесты | **P0** (до любого reuse PR7) |
| 3 | Диагностика только за секретом | `GET /api/executor/night-plan` | оператор не может получить доказательство без секрета/Railway | ручной CMD-луп | дублировать учёт в canonical live-funnel-log | **P0** |
| 4 | Stale/absent DB-backed лог | `reports/contur3/live_funnel_latest.md` | нет свежей улики ни по одной стадии | слепые патчи | свежий read-only прогон с env (founder-запуск) | **P0** |
| 5 | Ноль тестов на slice | `tests/` | непроверяемость любого патча | регрессии | tests-only фаза, первые 5 тестов из инвариантов | **P0** |
| 6 | GET-роут пишет в БД | `night-plan/route.ts`: insert `executor_order_events` (~46), `executor_audit_events` (~193) | «читающая» диагностика мутирует состояние | аудиты искажают картину; ложные order-events | verified: вынести запись за явный POST/флаг (будущая фаза) | P1 |
| 7 | Dry-run — только флаг | `runEventRebalance`: `opts.write === true` | одна ошибка вызова = запись из «диагностики» | случайные queue-ряды | структурный pure core + writer | P1 |
| 8 | Отчёты в tracked-дереве | `reports/contur3/*`, `persistRebalanceDiagnostics` (writeFile) | диагностика пачкает git status → ложный hard-stop | заблокированные сессии агентов | git-ignored `var/reports/` | P1 |
| 9 | Нет deploy hash в логе | шапка монитора: только локальные Branch/HEAD | нельзя доказать, что чиним задеплоенный код | deployment mismatch невидим | поле `deployment.railway_commit_hash` | P1 |
| 10 | NUL-байт в мониторе | `contur3LiveFunnelMonitor.mjs` (~offset 19993) | grep/rg видят файл как binary и молча пропускают | канонический файл невидим для поиска/ревью | санация байта (1-строчный фикс, отдельная микрозадача) | P2 |
| 11 | HYPOTHESIS: allowed-регексы монитора могут иметь те же `\b`-дефекты, что PR7 (PR7 заявлен как «mirror») | monitor `classifyMarket` allowed-ветки | не проверено построчно в этой сессии | недоклассификация allowed | включить в corpus-тест | P2 |
| 12 | Identity-логика без тестов, но структурно зрелая | `deriveMatchFamilyKey` | сильный код без страховки | случайная регрессия при extraction | byte-эквивалентное извлечение + тесты | P1 |

## 7. Logging attributes to add later

Все поля — read-only по отношению к БД (SELECT-only), если не указано иное.

| Поле | Стадия | Где собирать | Зачем |
|---|---|---|---|
| `git.branch`, `git.head` | шапка | уже есть в мониторе | связь лога с кодом |
| `deployment.railway_commit_hash`, `deployment.matches_repo` | шапка | env Railway (напр. `RAILWAY_GIT_COMMIT_SHA`) | исключить DEPLOYMENT_MISMATCH |
| `window.from/to` (24h/72h) | шапка | монитор | воспроизводимость |
| `source_rows`, `research_rows` | source | монитор (paginated counts, уже есть таблица Tables) | вход воронки |
| `raw_fullmatch_rows`, `raw_forbidden_rows{by_class}` | classification | единый taxonomy-модуль поверх source-рядов | видимость запрещённого потока |
| `builder.admitted`, `builder.rejected_by_reason{}` | builder | модель учёта PR7 (`fullmatch_admitted_count`, `fullmatch_rejected_by_reason`) — перенести в canonical лог | ноль тихих дропов |
| `builder.missing_fullmatch_fixtures[]` | builder | PR7 trace | точечный P0-трейс |
| `identity.strength_distribution{STRONG,MEDIUM,WEAK}` | builder | `deriveMatchFamilyKey` quality | здоровье identity |
| `market_class_distribution{}` | builder | PR7 `fullmatch_market_class_counts` | дрейф корпуса рынков |
| `reservations.accepted/rejected_by_reason{}/active/due_now` | reservations | `buildReservationPlan` diagnostics + таблица `night_event_reservations` | покрытие матчей |
| `queue.created/skipped_by_reason{}/by_status{}` | queue | ветки `runEventRebalance` (QUEUED/SKIPPED/EXPIRED + `selection_reason`) | судьба каждой due-резервации |
| `executor_api.visible_rows` | API | тот же SELECT, что `GET /api/executor/queue` | что реально видит Ireland |
| `audit_rows`, `order_rows` | ledger | `executor_audit_events`, `executor_order_events` | замыкание контура |
| `stale_jobs[]` | health | сравнение last-run таймстампов с расписанием | мёртвые кроны |
| `hard_anomalies[]`, `machine_verdict`, `machine_next_action` | вердикт | ядро монитора (уже есть verdict-логика) | оператор читает 10 строк |

## 8. Test plan for next overnight patch (тесты НЕ создавать сейчас)

| Тест | Target | Фикстуры | Ожидаемый провал/пробел | Почему до поведенческого патча |
|---|---|---|---|---|
| Taxonomy corpus/diff | все 4 классификатора (факт 4) на одном корпусе | ~40 реальных названий рынков (halftime total, corners, exact score, goalscorer, props, futures, esports, moneyline/spread/total, «Sunderland» и «draw»-кейсы) | расхождения монитор↔queue↔night-plan↔PR7; `\b`-кейсы | превращает «дрейф LIKELY» в построчно доказанный и даёт фикстуры для единого модуля |
| Builder admission accounting | `buildFireModelCandidates` c инъекцией рядов | 5–10 синтетических raw-рядов (allowed/forbidden/битые) | пробел: баланс не проверяется нигде | это главный инвариант против тихого дропа |
| Identity family key | `deriveMatchFamilyKey`, `buildIdentityText` | slug-пары, «A vs B» заголовки, single-team spread | пробел: детерминизм не зафиксирован | страхует byte-эквивалентное извлечение identity |
| Reservation no-forbidden/no-halftime | `buildReservationPlan` | план с halftime/corners-кандидатом в input | пробел: планировщик полагается на upstream-фильтры | закрывает дыру «forbidden просочился мимо builder» |
| Queue dry-run no-write | `runEventRebalance({write:false})` c mock-клиентом | mock supabase, счётчик вызовов insert/update | пробел: гарантия только флагом | защита от случайной записи из диагностики |
| Canonical log MEASUREMENT_MISSING | ядро монитора | окружение без env / без одной таблицы | текущее поведение: скелет есть, но per-stage MEASUREMENT_MISSING семантика не тестирована | запрет «missing = 0» |

## 9. Ranked candidate next patches

**1. Taxonomy corpus + единый канонический классификатор (extraction).**
Классификация: tests + exact-patch (extraction без изменения поведения).
Allowed: новый pure-модуль, corpus-тест, замена 3–4 call-sites на импорт.
Forbidden: любые decision-пороги, reservations/queue-логика, роуты сверх импорта, supabase/.
Ценность: убирает P0-дрейф №1, даёт фундамент всем остальным патчам.
Риск: низкий при byte-эквивалентном диффе поведения (corpus-тест это доказывает).
Prerequisites: founder-решения §11.3.
Приёмка: corpus-тест зелёный; поведенческий дифф старый-vs-новый классификатор = задокументированные различия; build PASS.
Не слишком широк: один модуль + механическая замена call-sites.

**2. PR7-диагностика → канонический live-funnel-log (extraction, supersede PR7).**
Классификация: backend-API (логирование), без decision-изменений.
Allowed: монитор + лог-скрипт + (перенос учёта из PR7-ветки).
Forbidden: admission/reservation/queue решения.
Ценность: делает баланс admitted/rejected видимым оператору без секрета.
Риск: низкий; зависит от патча 1 (иначе тащит FM_*-копию с багами).
Приёмка: лог показывает admitted/rejected_by_reason; PR7 закрывается как superseded.

**3. Builder admission accounting + tests (инвариант баланса).**
Классификация: tests-first + минимальный интеграционный хук.
Ценность: главный анти-тихий-дроп инвариант.
Риск: средний (нужна инъекция рядов в 1200-строчную функцию).
Prerequisites: патчи 1–2.
Приёмка: тест баланса зелёный на фикстурах; ноль изменений decision-путей.

**4. Гигиена вывода логов (git-ignored `var/reports/`) + deploy hash в шапке.**
Классификация: env-deploy-смежный, но код-only (пути + env-чтение).
Ценность: чистый git status при диагностике; исключение DEPLOYMENT_MISMATCH.
Риск: низкий; требует founder-решения §11.4.
Приёмка: прогон монитора не меняет `git status --short`; в шапке deploy hash.

**5. Санация NUL-байта монитора (микропатч).**
Ценность: файл снова видим grep/CI. Риск: минимальный (проверка diff = 1 байт).
Может ехать пассажиром в патче 2.

**Вне списка сознательно:** любые изменения reservations/queue-поведения — до свежего DB-лога цель не доказана.

## 10. Recommended next overnight prompt direction

**Рекомендация: Патч-кандидат 1 + 2 как один bounded overnight-промпт
(«единая таксономия с corpus-тестом → доставка учёта admitted/rejected в канонический лог»),
с пассажиром 5 (NUL-байт).**

Почему максимальная ценность: одним ограниченным заходом закрываются три из пяти
доказанных проблем (§3: SOURCE_TAXONOMY_BUG, MARKET_CLASSIFICATION_BUG, половина
LOGGING_GAP) и создаётся фундамент (модуль+фикстуры) для всех последующих патчей;
при этом ни одно admission/reservation/queue-решение не меняется — поведенческий
риск близок к нулю и полностью доказуем corpus-diff-тестом.

Что НЕ включать: изменения порогов tier/score/coverage; reservations/queue логику;
merge PR7; любые DB-записи; git-ignored миграцию отчётов (отдельное founder-решение);
live/Ireland.

Какие улики должен произвести: corpus-diff таблицу «до» (расхождения 4 копий);
зелёный corpus-тест «после»; git diff --stat; build PASS; пример канонического лога
с новыми полями (или честный STOPPED_DB_ENV_MISSING без env).

Когда остановиться: любой кейс, где унификация МЕНЯЕТ прод-решение
(например, queue начнёт блокировать corners, которые раньше пропускал) —
это поведенческое изменение: зафиксировать в отчёте, НЕ применять без
отдельного founder-решения; STOP также при недоступности call-site для
механической замены.

## 11. Open questions for founder (только решения)

1. Разрешить свежий DB-backed read-only прогон канонического лога (на окружении с env)?
2. Разрешить tests-only ветку (`tests/contur3/*` + фикстуры)?
3. Разрешить извлечение единого taxonomy-модуля (механическая замена call-sites)?
4. Разрешить перенос генерируемых отчётов в git-ignored путь (напр. `var/reports/`)?
5. Разрешить закрытие PR7 как superseded после переноса его диагностики в канонический лог?
6. (Связанное) Если унификация таксономии выявит, что queue сейчас ПРОПУСКАЕТ
   corners/props/futures — считать ли блокировку этих классов одобренной политикой
   или отдельным решением?

## 12. Final recommendation

Мы находимся в конце инвентарной фазы: статическая картина полная и подтверждена
источниками (slice заморожен, PR7 аддитивен, тестов ноль, таксономия в 4 копиях,
канонический лог мёртв как улика), но динамика (БД/деплой/Ireland) не наблюдалась —
поэтому все builder/reservation/queue-баги остаются недоказанными подозрениями.
Следующий безопасный высокоценный патч должен готовить доказательства, а не менять
поведение: единый протестированный классификатор + доставка admitted/rejected-учёта
в канонический лог (направление §10) при параллельном founder-запуске свежего
read-only DB-лога. Это ломает старую петлю смерти ровно в её механизме: вместо
«симптом → слепой микропатч» каждый следующий шаг будет опираться на corpus-тест
и полный баланс рядов, где тихий дроп невозможен по построению.

## 13. (Architect discretion) How to judge the overnight patch

Критерии оценки будущего overnight-патча (Gate-чеклист для ревью его результата):
1. `git diff --stat` — только заявленные файлы; ни одной строки в decision-путях
   сверх механической замены классификатора.
2. Corpus-diff таблица «до» приложена; corpus-тест «после» зелёный.
3. Поведенческие расхождения унификации перечислены поимённо и НЕ применены
   без founder-решения (§11.6).
4. `npm run build` PASS; `npm test` PASS; git status чист после прогона диагностики.
5. Канонический лог (или его skeleton без env) содержит новые поля учёта.
6. Ни одного нового секрет-gated канала доставки диагностики.
7. Ни одного DB-write вне существующих persist-функций; ни одного merge PR7.
Патч, не проходящий любой пункт, откатывается целиком (ветка удаляется), а не «дочинивается» — это анти-patch-loop правило.
