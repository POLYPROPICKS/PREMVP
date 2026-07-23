# CONTOUR ROADMAP 3

**Canonical project name:** Contour Roadmap 3
**Project:** PolyProPicks / PREMVP / Contur3 / Ireland
**Status:** Founder-fixed architecture and execution roadmap; repository integration pending nearest operational milestone commit
**Commit policy:** Do not commit this document separately. Add it to the nearest operational R0 milestone commit together with the corresponding source/tests/evidence changes.
**Source document:** `POLYPROPICKS_GLOBAL_ARCHITECTURE_AUTOMATION_OPERATOR_MASTER_ROADMAP_2026-07-23.md`

---

# PolyProPicks — Global Architecture, Automation and Operator Development Master Roadmap
## Единая архитектура Runtime, Control Plane, Visual Control, Agent Automation и развития навыков Founder

**Дата:** 23 июля 2026
**Статус:** MASTER REVIEW CANDIDATE / NOT YET IMPLEMENTED
**Проект:** PolyProPicks / PREMVP / Contur3 / Ireland
**Основной repo:** `C:\WORK\KalshiProPulse\sipropicks-premvp1-1`
**Production:** `https://polypropicks.com`
**Ireland runtime:** `~/polymarket-executor`
**Founder:** финальный владелец бизнес-решений, live-разрешений и визуального acceptance
**ChatGPT / Claude Chat:** архитектор, scope controller, prompt writer, reviewer
**Claude Code / Codex / OneTopic Cloud:** bounded executors
**Главный принцип:** сначала доказанная вертикаль и измеримые артефакты, затем автоматизация; не наоборот

---

# 0. Как пользоваться этим документом

Этот файл является единым master-roadmap. Он объединяет:

- текущую точку PolyProPicks;
- глобальный vision;
- шестиуровневую архитектуру;
- границы Data / Model / Orchestrator / Ireland / Settlement / Control Plane;
- visual control и dashboards;
- monitoring и alerting;
- автоматизацию разработки;
- последовательное подключение агентов;
- обучение Founder/Operator;
- требования к Skills и instruction layer;
- критерии перехода между уровнями автономности;
- ограничения по токенам, стоимости и риску;
- текущий R0 incident;
- DEV RULE 2;
- точный порядок ближайших работ.

Документ должен использоваться четырьмя способами.

## 0.1 Founder

Founder открывает:

1. раздел 1 — простое объяснение;
2. раздел 5 — текущая точка;
3. раздел 18 — дорожная карта;
4. раздел 21 — развитие навыков;
5. раздел 30 — ближайший шаг.

Founder не обязан читать весь архитектурный слой перед каждым решением.

## 0.2 Architect

Architect использует файл для:

- классификации задач;
- ограничения scope;
- построения executor prompts;
- определения Gate;
- контроля roadmap;
- отделения runtime bugfix от platform work;
- проверки, не автоматизируется ли ещё не понятый процесс.

## 0.3 Executor

Executor получает не весь файл, а bounded specification:

- обязательные instruction files;
- конкретный milestone;
- allowed/forbidden files;
- tests;
- stop conditions;
- required artifacts;
- commit/push/deploy mode.

## 0.4 Independent reviewer

Reviewer проверяет:

- соответствует ли roadmap реальным source/runtime evidence;
- не превращена ли гипотеза в факт;
- не построена ли платформа раньше первой единицы ценности;
- достаточно ли изолированы модули;
- снижает ли автоматизация Founder active time;
- надёжны ли Gate и validators.

---

# 1. Простыми словами: что такое Visual Control Layer

## 1.1 Что это

Visual Control Layer — это автоматически создаваемый понятный отчёт о состоянии всей цепочки.

Он отвечает на вопросы:

```text
Сколько было исходных возможностей?
Сколько прошло каждый фильтр?
Где исчезли сигналы?
Почему они исчезли?
Был ли создан READY?
Дошёл ли ордер до Ireland и CLOB?
Разрешился ли он?
Какой PnL доказан?
Что сломано?
Что разрешено делать дальше?
Нужно ли решение Founder?
```

Это не «красивый dashboard ради dashboard».

Это перевод технических артефактов в форму, которую занятый Founder понимает за 1–10 минут.

## 1.2 Что он даёт

Без visual control Founder вынужден:

- читать длинный чат;
- искать SQL-вывод;
- сопоставлять Git SHA;
- читать executor summary;
- смотреть Railway;
- смотреть Ireland logs;
- вручную восстанавливать, где потерялась строка;
- спрашивать ChatGPT, что всё это означает.

С visual control Founder открывает один отчёт и видит:

```text
STATUS: RED
FIRST FAILING STAGE: authoritative_universe
TARGETS LOST: 4
REJECTION: exact code
MONEY AT RISK: $0
NEXT ALLOWED ACTION: instrument candidate conversion
```

## 1.3 Как им пользоваться

На первом этапе:

1. Runtime генерирует `stage-trace`.
2. Validator проверяет trace.
3. Генератор строит Markdown + Plotly HTML.
4. Founder открывает один HTML.
5. Founder называет:
   - первый failing stage;
   - точный rejection code;
   - затронутые targets;
   - следующее разрешённое действие.
6. Architect сверяет решение с `verification-gate`.

Отчёт read-only. Он ничего не запускает и не меняет.

## 1.4 Когда он появится

### D0 — во время текущего R0

После того как real loader→READY pipeline начнёт эмитить stage trace.

D0 является частью доказательства текущей вертикали, а не поздним продуктом.

### D1 — после трёх сопоставимых runs

Сравнение ночей:

- реальный denominator;
- тренды;
- распределение rejection codes;
- Founder minutes;
- Time to Gate.

### Persistent web dashboard — только после измеренной необходимости

Он появляется только если static reports становятся реальным bottleneck.

Не по желанию «иметь красивый control panel», а по Gate:

- несколько contours;
- десятки run packages;
- медленная реакция;
- высокий Founder time;
- необходимость exception queue.

## 1.5 Что это не является

Visual Control Layer:

- не новая база истины;
- не ручной статус-трекер;
- не admin-панель;
- не CLOB terminal;
- не место изменения stake;
- не место изменения модели;
- не orchestration framework;
- не отдельный седьмой слой;
- не разрешение строить web UI до instrumentation.

---

# 2. Executive summary

PolyProPicks строится как повторяемая система:

```text
Dataset
→ Model
→ Decision Orchestration
→ Execution
→ Settlement
→ Evaluation
→ Controlled Improvement
```

Текущая sports-вертикаль должна стать первым reference implementation.

В будущем должны подключаться:

- другая sports model;
- другой dataset;
- Weather Domain Pack;
- другие prediction-market domains;
- новые venue adapters.

Это возможно только если:

1. Dataset заканчивается canonical observation.
2. Model заканчивается decision/rejection artifacts.
3. Orchestrator не пересчитывает модель.
4. Ireland не выбирает рынок и не ранжирует.
5. Settlement связывает order с исходным decision.
6. Control Plane хранит evidence, а не бизнес-логику.
7. Visual layer показывает artifacts, но не создаёт truth.
8. Agents работают через permissions и typed outputs.
9. Founder управляет Gate и исключениями.
10. Любая автоматизация доказывает экономию времени и отсутствие роста false PASS.

Текущая точка:

```text
Ireland execution capability: доказана
Canonical source→READY: FAILED IN PRODUCTION
Canonical forward PnL: NOT ESTABLISHED
Full live readiness: NO
Automation maturity: Level 1
```

Главная задача R0:

```text
объяснить opportunity denominator
+
доказать первый failing predicate
+
пройти source→READY
+
WOULD_SUBMIT
+
один canonical live order
+
reconciled PnL
```

---

# 3. Глобальный vision проекта

## 3.1 Бизнес-vision

PolyProPicks должен превратиться из одного набора scripts и production-fixes в систему, которая:

- обнаруживает market opportunities;
- применяет versioned model;
- создаёт authoritative decisions;
- безопасно исполняет;
- связывает результат с исходным решением;
- измеряет net PnL;
- сравнивает models и datasets;
- поддерживает несколько domains;
- улучшает модели через controlled Champion/Challenger workflow;
- минимизирует active Founder time;
- не допускает autonomous live-risk escalation.

## 3.2 Технологический vision

Целевая система:

```text
Contour Kernel Candidate
+
Domain Packs
+
Dataset Adapters
+
Model Plugins
+
Venue Adapters
+
Settlement Policies
+
Engineering Control Plane
+
Visual Control Views
```

## 3.3 Организационный vision

Эволюция роли Founder:

```text
ручной оператор
→ evidence-first acceptor
→ orchestrator нескольких bounded agents
→ manager of supervised automation
→ owner of goals, budgets, constraints and exceptions
```

Founder не должен становиться full-time QA-инженером для агентов.

## 3.4 Экономический vision

Автоматизация оправдана только если повышает:

```text
Net System Value =
risk-adjusted economic value
+ Founder time saved
+ reliability value
- compute/token cost
- maintenance cost
- error/rework cost
- capital risk
```

Количество агентов, токенов, commits и dashboards не является value.

---

# 4. Source-of-truth и классы утверждений

## 4.1 Приоритет истины

```text
1. Current repo source + git output
2. Production Supabase/Railway/Ireland evidence
3. Immutable run artifacts and hashes
4. Git-tracked project instructions
5. This master roadmap
6. Old handoffs and chat memory
```

## 4.2 Классы утверждений

Каждое значимое утверждение должно быть классифицировано:

```text
VERIFIED
MEASURED
INFERRED
ASSUMPTION
UNKNOWN
STALE
CONTRADICTION
PROPOSED DESIGN
```

## 4.3 Запрет

Нельзя:

- выдавать `ASSUMPTION` за `VERIFIED`;
- считать cached API proof fresh generation;
- считать accepted order filled;
- считать resolved order reconciled PnL;
- считать synthetic fixture production proof;
- считать component tests доказательством полной вертикали;
- считать dashboard source of truth;
- использовать subjective readiness percentage без denominator.

---

# 5. Текущая точка глобального roadmap

## 5.1 Что доказано

Доказаны или существенно развиты:

- frozen historical model baseline;
- two-stage planning/final architecture;
- reservation safety/recovery;
- controlled live capability;
- Ireland durable execution;
- idempotency;
- callback lifecycle;
- resolver;
- fill normalization;
- source lineage;
- canonical stake `$1.10`;
- fail-closed behaviour;
- real accepted capability orders.

## 5.2 Что не доказано

Не доказаны:

- реальный denominator 10–20 opportunities;
- причина 4–5 reservations;
- первый predicate потери final candidates;
- стабильный canonical `source→READY`;
- canonical fixed-stake forward sample;
- canonical forward net PnL;
- reusable Kernel;
- second model swap;
- Weather reuse;
- Model Improvement Factory;
- Level-2 parallel engineering.

## 5.3 Точная позиция

```text
Phase 0  Ireland recovery                     PASS
Phase 1  Durable execution kernel             PASS
Phase 2  CLOB capability                      PASS
Phase 3  Controlled capability batch          PARTIAL PASS
Phase R0 Frozen canonical integration         BLOCKED
Phase R1 Contract Freeze                      NOT STARTED
Phase R2 Fixed-stake forward sample           NOT STARTED
Phase C0 Control Plane Lite                    NOT STARTED
Phase K0 Kernel Candidate extraction          NOT STARTED
Phase M0 Model Improvement Factory            NOT STARTED
Phase D1 Weather Domain Pack                   NOT STARTED
```

---

# 6. Текущий incident: два независимых провала

## 6.1 Провал A — мало planning reservations

Наблюдение:

```text
4–5 reservations
```

Ожидание:

```text
10–20
```

Ожидание пока не является формально доказанным denominator.

Нужен funnel:

```text
source_available
→ source_fresh
→ normalized
→ T−90 eligible
→ model inputs valid
→ model accepted
→ distinct physical events
→ planning eligible
→ reservations created
```

Вердикт:

```text
EXPECTED_10_20_CLAIM =
OPEN / CONFIRMED / REJECTED / REDEFINED
```

## 6.2 Провал B — все reservations исчезли до READY

Наблюдение:

```text
4 reservations
→ 4 skipped
→ 0 READY
```

Общий error code:

```text
CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE
```

Он недостаточен.

Нужно определить:

```text
first failing stage
exact failing predicate
target lineage transition
rejection code
sanitized relevant values
evidence hash
```

## 6.3 Почему нельзя объединять

Даже после исправления Провала B система может продолжить создавать только 4 opportunities.

Даже если denominator = 15, система может продолжить давать 0 READY.

Это разные бизнес- и engineering-Gates.

---

# 7. DEV RULE 2

**DEV RULE 2 — тестировать правильную границу и правильный вход.**

Перед production-fix или readiness claim:

1. Построить полный путь source→business result.
2. Сформировать failure tree из 3–5 competing causes.
3. Не начинать тест после подозреваемого участка.
4. Не подставлять вручную объект, если defect может быть в producer этого объекта.
5. Использовать production-shaped rows.
6. Использовать реальный loader/normalization/filters/producer/matcher/queue/serializer.
7. Использовать frozen clock.
8. Эмитить stage counts.
9. Отслеживать targets.
10. Фиксировать первый rejection reason.
11. Проверять downstream contract.
12. Разделять component proof и vertical proof.
13. Не объявлять FULL_LIVE_READY без production shadow и canonical live record.

---

# 8. Целевая системная модель

## 8.1 Два plane

### Product Runtime Plane

Создаёт бизнес-результат.

```text
Data
→ Model
→ Decision
→ Execution
→ Settlement
```

### Engineering Control Plane

Управляет разработкой и доказательствами.

```text
Intent
→ Task spec
→ Executor
→ Artifacts
→ Validators
→ Review
→ Gate
→ Release
```

Control Plane не определяет market decision.

## 8.2 Kernel Candidate + Domain Packs

### Kernel Candidate

Содержит только потенциально общие механизмы:

- run identity;
- versioning;
- orchestration lifecycle;
- idempotency;
- trace contracts;
- artifact contracts;
- execution intent;
- terminal receipt;
- settlement lineage;
- permissions;
- gates;
- retry/reconciliation patterns.

### Domain Pack

Содержит domain semantics:

- source adapters;
- physical event identity;
- feature normalization;
- model plugin;
- timing policy;
- market-selection constraints;
- settlement policy;
- domain-specific DQA.

### Venue Adapter

Содержит venue mechanics:

- authentication;
- price query;
- minimum size;
- order submission;
- venue receipt;
- venue-specific reconciliation.

---

# 9. Шесть архитектурных слоёв

## Layer 1 — Data Plane

### Ответственность

- загрузить source;
- сохранить raw lineage;
- нормализовать;
- проверить schema/freshness/completeness;
- выдать canonical observations.

### Proposed output

```text
CanonicalObservationV1
```

### Не имеет права

- выбирать stake;
- создавать reservation;
- создавать queue;
- обращаться к venue;
- вычислять settlement PnL.

### Swap criterion

Новый dataset adapter не меняет модель и execution.

---

## Layer 2 — Model Plugin

### Ответственность

- получать canonical observations;
- применять filters;
- вычислять decision;
- выдавать rejections;
- сохранять model trace.

### Outputs

```text
ModelDecisionV1
ModelRejectionV1
ModelRunTraceV1
```

### Не имеет права

- писать READY;
- вызывать Ireland;
- выбирать venue fallback;
- менять stake policy;
- выполнять settlement.

### Swap criterion

Новая модель не требует правок Ireland, callback и resolver.

---

## Layer 3 — Decision Orchestrator

### Ответственность

- planning;
- reservation;
- finalization;
- authoritative intent;
- lifecycle;
- idempotent queue creation.

### Lifecycle

```text
PLANNED
→ RESERVED
→ FINALIZING
→ READY
→ EXECUTING
→ TERMINAL
```

### Не имеет права

- скрыто менять model filters;
- заменять authoritative market;
- пересчитывать rank без model artifact;
- исполнять CLOB.

---

## Layer 4 — Execution Gateway

### Ответственность

Ireland:

- принять exact intent;
- проверить mechanical safety;
- проверить caps;
- проверить venue state;
- submit;
- сохранить receipt;
- callback;
- reconcile unknown states.

### Не имеет права

- выбирать alternative signal;
- менять model;
- менять market identity;
- рассчитывать model confidence;
- решать PnL.

---

## Layer 5 — Settlement and Evaluation

### Ответственность

- resolve outcome;
- связать lineage;
- вычислить fees/slippage;
- actual PnL;
- normalized return;
- segment evaluation;
- forward ledger.

### Outputs

```text
SettlementRecordV1
EvaluationRecordV1
ForwardLedgerEntryV1
```

### Не имеет права

- редактировать historical decision;
- менять order receipt;
- retroactively менять model version.

---

## Layer 6 — Engineering Control Plane

### Ответственность

- task specification;
- run identity;
- evidence artifacts;
- validation;
- independent review;
- gate decisions;
- release evidence;
- permissions;
- cost/time metrics;
- agent lifecycle.

### Не имеет права

- создавать market decisions;
- изменять production stake;
- самостоятельно включать live;
- подменять runtime truth.

---

# 10. Visual layer в этой архитектуре

Visual layer:

```text
typed artifacts
→ deterministic aggregation
→ generated view
```

Он не является Layer 7.

## 10.1 Почему он необходим

Control Plane только из файлов снова потребует переводчика-LLM.

Visual layer делает artifacts операционно доступными Founder.

## 10.2 Почему он не должен быть source of truth

Любая визуальная цифра должна иметь:

```text
run_id
artifact ref
hash
version
freshness
evidence status
```

## 10.3 Почему он должен появиться рано

Stage trace без визуального output уменьшает engineering uncertainty, но не уменьшает Founder cognitive load.

D0 решает обе задачи.

---

# 11. Stage Registry и typed trace

## 11.1 Stage Registry

Trace не определяет pipeline самостоятельно.

Versioned registry хранит:

```text
stage_name
stage_index
stage_version
input_entity_type
output_entity_type
transformation_kind
required
allowed predecessor
allowed successor
```

## 11.2 Transformation kinds

```text
FILTER_1_TO_0_OR_1
MAP_1_TO_1
GROUP_MANY_TO_1
FAN_OUT_1_TO_MANY
JOIN
TERMINAL_SIDE_EFFECT
```

## 11.3 Почему простое count continuity недостаточно

Pipeline меняет entity types:

```text
rows
→ markets
→ events
→ decisions
→ reservations
→ queue rows
```

Grouping loss не является rejection.

## 11.4 Target lineage

Нужны stage-specific IDs и stable lineage root:

```text
source_row_id
physical_event_id
model_decision_id
reservation_id
candidate_id
queue_id
venue_order_id
settlement_id
```

Target считается потерянным только если нет:

- rejection;
- group transition;
- successor identity;
- terminal transition.

---

# 12. Control Plane Lite

Полный Control Plane не нужен сразу.

Первый вариант состоит из трёх объектов.

## 12.1 TaskSpecLite

```text
run_id
goal
task_class
owner
permissions
allowed scope
forbidden scope
stop conditions
expected evidence
commit/push/deploy mode
```

## 12.2 StageTrace

```text
run_id
stage
entity types
input/output counts
transformation
rejections
targets
clock
status
evidence ref
hash
```

## 12.3 VerificationGate

```text
run_id
git SHA
tests
typecheck
build
contract checks
review verdict
gate decision
next allowed transition
Founder action
```

## 12.4 Upgrade Gate

Полный Run Package появляется только если Lite не покрывает:

- multi-repo;
- multi-agent;
- release history;
- multiple environments;
- complex review disagreements;
- repeated artifact ambiguity.

---

# 13. D0 — первый visual output

## 13.1 Назначение

Одна ночь / один run.

## 13.2 Верхний блок

```text
STATUS
RUN
FRESHNESS
CURRENT PHASE
FIRST FAILING STAGE
FIRST FAILING PREDICATE
MONEY AT RISK
FOUNDER ACTION
NEXT ALLOWED ACTION
```

## 13.3 Funnel

Показывает:

- counts;
- conversions;
- transformation type;
- rejection codes;
- missing measurements;
- first failure.

## 13.4 Target lifecycle

Для каждой reservation:

```text
present
→ converted
→ grouped
→ rejected/absent
```

## 13.5 Gates

```text
OPPORTUNITY_DENOMINATOR_DEFINED
FIRST_FAILING_PREDICATE_PROVEN
REPLAY_PARITY
WOULD_SUBMIT
CANONICAL_ORDER
RECONCILED_PNL
```

## 13.6 Технология

```text
generated Markdown
+
static Plotly HTML
```

Без:

- web server;
- database;
- write actions;
- authentication;
- new runtime.

## 13.7 Acceptance

Founder:

- открывает только report;
- находит failure <10 минут;
- не читает чат;
- правильно выбирает next action.

---

# 14. D1 — multi-run comparison

## 14.1 Gate

Не раньше трёх compatible runs.

## 14.2 Выходы

- stage counts by night;
- median baseline;
- rejection distribution;
- opportunity denominator;
- segment comparison;
- Founder minutes;
- Time to Gate;
- rework;
- token cost.

## 14.3 Главный первый вопрос

```text
10–20 expected opportunities:
CONFIRMED / REJECTED / REDEFINED
```

## 14.4 Ограничение

Три runs не доказывают statistical stability модели.

Они создают operational baseline.

---

# 15. Persistent dashboard roadmap

## D2 — Operational read-only dashboard

Только при доказанном bottleneck.

Показывает:

- current runs;
- READY conversion;
- Ireland;
- unresolved;
- exposure;
- alerts.

## D2-PnL

Только после ledger lineage.

Показывает:

- net PnL;
- fees;
- slippage;
- drawdown;
- normalized return;
- model version.

## D3 — Agent operations

Только после writer/reviewer pilot.

## D5 — Portfolio

Только после второго domain.

## Запрет

Не проектировать D5 как текущую задачу.

---

# 16. Monitoring architecture

## M1 Runtime

- job status;
- source freshness;
- funnel;
- reservations;
- READY;
- Ireland;
- callback;
- reconciliation.

## M2 Data/Model

- schema drift;
- completeness;
- opportunity denominator;
- model version;
- rejection drift;
- segment drift.

## M3 Execution/Settlement

- venue state;
- order status;
- duplicates;
- partial fills;
- unknown states;
- PnL lineage.

## M4 Engineering/Operator

- Git;
- tests;
- builds;
- review;
- Gate;
- Founder time;
- token cost;
- rework.

---

# 17. Severity and exception policy

Evidence status и severity различаются.

## Evidence status

```text
MEASURED
INFERRED
MEASUREMENT_MISSING
UNKNOWN
STALE
CONTRADICTION
```

## Severity

### SEV-0

- live money state unknown;
- venue reconciliation unknown;
- cap violation;
- secret/security breach.

Action:

```text
automatic fail-closed
Founder immediate
no further live action
```

### SEV-1

- zero READY;
- canonical run blocked;
- reconciliation mismatch;
- unauthorized mutation.

### SEV-2

- funnel collapse;
- stale critical data;
- review failed;
- drift anomaly.

### SEV-3

- non-blocking engineering/process issue.

### INFO

- successful verified run.

Founder не получает каждый PASS.

---

# 18. Global implementation roadmap

## Phase R0A — Opportunity denominator

### Goal

Доказать реальный source→reservation funnel.

### Outputs

- measured counts;
- stage registry;
- exact rejections;
- D0 section.

### Gate

```text
OPPORTUNITY_DENOMINATOR_DEFINED = PASS
```

---

## Phase R0B — Final-path root cause

### Goal

Найти first predicate потери reservations.

### Gate

```text
FIRST_FAILING_PREDICATE_PROVEN = PASS
```

---

## Phase R0C — Production-shaped replay

### Goal

Прогнать реальную форму строк через настоящий pipeline.

### Gate

```text
REPLAY_PARITY = PASS
```

---

## Phase R0D — WOULD_SUBMIT

### Goal

Получить реальный READY-shaped intent без CLOB write.

### Gate

```text
WOULD_SUBMIT = PASS
```

---

## Phase R0E — One canonical live order

### Goal

Один order через canonical model path.

### Gate

```text
CANONICAL_LIVE_ORDER = PASS
```

---

## Phase R0F — Reconciliation

### Goal

Order→fill→settlement→net PnL.

### Gate

```text
CANONICAL_FORWARD_NET_PNL = ESTABLISHED_FOR_ONE_RECORD
```

---

## Phase R1 — Contract Freeze

Freeze:

- canonical observation;
- model decision;
- rejection;
- execution intent;
- receipt;
- settlement;
- trace;
- Gate.

Freeze означает versioning, а не запрет эволюции.

---

## Phase O0 — Baseline operator economics

Измерить:

- Founder minutes;
- Time to Gate;
- rework;
- chats/logs opened;
- token cost.

---

## Phase C0 — Control Plane Lite

Реализовать три artifacts.

---

## Phase C0.5 — Validators + D1

- schema;
- lineage;
- diff;
- Gate;
- comparison report.

---

## Phase O1 — Founder evidence-first training

Три runs без architect interpretation.

---

## Phase C1 — Read-only Evidence Auditor

Shadow only.

---

## Phase K0 — Kernel Candidate extraction

Только после доказанной vertical.

---

## Phase C2 — Writer + Reviewer pilot

Один writer, один independent reviewer.

---

## Phase R2 — Fixed-stake forward sample

Накопить resolved canonical decisions.

---

## Phase M0 — Model Improvement Factory foundation

Immutable evaluations, no live promotion.

---

## Phase K1 — Second model swap

Новая sports model без downstream changes.

---

## Phase D1 — Weather Domain Pack

Второй domain подтверждает или ломает abstractions.

---

## Phase C3 — Controlled parallelism

2–3 независимых workstreams.

---

## Phase C4 — Supervised autonomy

Только после trusted verification contour.

---

# 19. Уровни автоматизации

## Level 1 — Assistant

Текущий уровень.

Один Founder, один agent, синхронная работа.

## Level 2 — Parallel supervised work

Цель ближайшего периода.

Признаки:

- isolated worktrees;
- self-check;
- independent review;
- artifact-first handoff;
- manual merge/deploy.

## Level 3 — Supervised autonomy

Только доказанные repetitive classes:

- maintenance;
- replay;
- dependency updates;
- recurring audits.

## Level 4 — AI-native

Не текущий roadmap milestone.

Требует:

- trusted validators;
- exceptions;
- budgets;
- event-driven orchestration;
- hundreds of stable procedures.

---

# 20. Agent architecture

## 20.1 Не swarm

Правильная модель:

```text
deterministic orchestrator
→ bounded agent
→ typed artifact
→ validator
→ reviewer
→ Gate
```

## 20.2 First agents

### Evidence Auditor

Read-only.

### Trace Analyst

Read-only.

## 20.3 Writer pilot

- one code zone;
- one worktree;
- one patch attempt;
- TDD;
- no push/deploy.

## 20.4 Reviewer

Получает:

- TaskSpec;
- diff;
- tests;
- artifacts.

Не получает writer self-justification как truth.

## 20.5 Permission tiers

```text
P0 read
P1 sandbox/replay
P2 isolated branch write
P3 merge recommendation
P4 deploy recommendation
P5 production mutation
```

P5 Founder only.

---

# 21. Operator Development Track

## O0 — Understand lifecycle

Founder различает:

```text
signal
reservation
READY
submitted
accepted
filled
resolved
reconciled PnL
```

## O1 — Read D0

Назвать first failure <10 минут.

## O2 — Reject invalid evidence

Не принять красиво визуализированный invalid trace.

## O3 — Close denominator claim

По D1 принять CONFIRMED/REJECTED/REDEFINED.

## O4 — Review artifacts instead of transcript

Gate без чтения agent conversation.

## O5 — Manage permissions

Понимать P0–P5.

## O6 — Measure automation economics

Keep/simplify/remove capability.

## O7 — Manage writer/reviewer conflict

Evidence-based adjudication.

## O8 — Manage exception queue

Не читать все PASS.

---

# 22. Operator Skill Card

Каждый новый automated capability получает карточку:

```text
Name
Manual work replaced
Inputs
Permissions
Can change
Cannot change
Output artifact
PASS criteria
Stop path
Rollback path
Known failures
Founder decision
```

Capability становится reusable Skill после:

- минимум трёх successful supervised uses;
- нуля unauthorized changes;
- отсутствия critical false PASS;
- доказанной экономии Founder time.

---

# 23. Instructions и executor discipline

Каждый engineering prompt требует прочитать:

```text
CLAUDE.md
AGENTS.md
AUTOMATION_MODE_HANDOFF.md
OPERATOR_ACCEPTANCE_CHECKLIST.md
VERIFICATION_GATES.md
WINDSURF_WORKFLOW_RULES.md
TASK_ROUTING_MATRIX.md
CLAUDE_CODE_EXECUTION_PROTOCOL.md
README.md if setup unclear
```

Missing file → STOP.

Каждый prompt содержит:

```text
TASK CLASSIFICATION
EXECUTION MODE
COMMIT
PUSH
DEPLOY
PR
ALLOWED FILES
FORBIDDEN FILES
STOP CONDITIONS
EVIDENCE REQUIRED
FOUNDER ACTION
```

Programming prompt также содержит:

```text
TEST PLAN
EXPECTED FAILING TEST
FILES TO TEST
IMPLEMENTATION FILES
ERROR LOGGING
SECURITY/ENV
VERIFICATION
```

---

# 24. Git, build and release rules

Before commit/push:

```text
git branch --show-current
git status --short
git diff --stat
git diff --check
targeted tests
npx tsc --noEmit
npm run build
```

Rules:

- stage intended files only;
- no package noise;
- docs and code separate;
- no unexpected dirty files;
- no push without explicit mode;
- Railway through main auto-deploy;
- no `railway up`;
- production verification separate.

---

# 25. Token and cost architecture

## 25.1 Artifact-first context

Agent получает:

- TaskSpec;
- relevant contracts;
- exact files;
- previous run package.

Не получает весь чат.

## 25.2 Model routing

- deterministic checks: code;
- formatting: cheap model;
- implementation: coding model;
- architecture/root cause: reasoning model;
- Founder summary: aggregator.

## 25.3 Budgets

Каждая task:

```text
file limit
tool-call limit
token budget
time/attempt limit
one patch attempt
```

## 25.4 Stop

После первого failed patch:

```text
Direct-source option check
```

---

# 26. Automation value metrics

Каждая automation capability оценивается:

```text
Founder active minutes
Time to Gate
Time to First Failing Stage
Rework cycles
False PASS
Escaped defects
Unauthorized changes
Evidence completeness
Token cost
Manual equivalent
```

Promotion only if:

- Founder time decreases;
- rework does not grow;
- false PASS does not grow;
- cost remains acceptable;
- rollback works.

---

# 27. Security and live boundaries

Agents may not:

- expose secrets;
- print env;
- modify production config;
- change stake;
- enable live;
- alter schema;
- create auth/payment/admin;
- submit CLOB without Founder P5;
- change model promotion status autonomously.

Logs must be sanitized.

Unknown venue state → fail closed.

---

# 28. Anti-overengineering rules

Do not build now:

- persistent dashboard;
- dashboard DB;
- event bus;
- Grafana;
- Streamlit;
- Dash server;
- agent command center;
- multi-domain portfolio;
- auto merge;
- auto deploy;
- auto model promotion;
- auto stake;
- universal Kernel before swap tests;
- trace fields without failure mode;
- random visualizations;
- second producer for reporting.

---

# 29. Risk register

## R1 Platform before value

Mitigation: R0 first.

## R2 Trace becomes second pipeline

Mitigation: emit from decision code.

## R3 Dashboard lies

Mitigation: hashes, freshness, evidence status.

## R4 Entity counts misinterpreted

Mitigation: typed stages and transformation kinds.

## R5 Identity break hidden

Mitigation: lineage root.

## R6 Agents accelerate chaos

Mitigation: validators before autonomy.

## R7 Founder becomes reviewer bottleneck

Mitigation: visual views, independent auditor, exception-only model.

## R8 Token cost exceeds value

Mitigation: bounded context and capability metrics.

## R9 Kernel overgeneralization

Mitigation: call Kernel Candidate until model/dataset/domain swap.

## R10 PnL claims overstate evidence

Mitigation: ledger lineage and NOT ESTABLISHED status.

---

# 30. Точный ближайший порядок

## Step 1 — R0.1 inspect-only

Карта real loader→READY:

- stages;
- files/functions;
- entity types;
- counts;
- rejection seams;
- identity transitions;
- missing measurements.

## Step 2 — R0.2 instrumentation

TDD patch real pipeline.

## Step 3 — R0.3 D0 generator

Isolated script, fixtures first.

## Step 4 — Founder D0 acceptance

<10 min.

## Step 5 — Fix proven predicate

Minimal patch.

## Step 6 — Replay

Full source-shaped.

## Step 7 — WOULD_SUBMIT

No live write.

## Step 8 — Canonical live order

$1.10, Founder P5.

## Step 9 — Reconciliation

One net PnL record.

## Step 10 — Contract Freeze

Then Control Plane Lite.

---

# 31. Exact acceptance criteria for current vertical

```text
OPPORTUNITY_DENOMINATOR_DEFINED = PASS
FIRST_FAILING_PREDICATE_PROVEN = PASS
PRODUCTION_SHAPED_REPLAY = PASS
READY_CREATED = PASS
WOULD_SUBMIT = PASS
CANONICAL_LIVE_ORDER = PASS
CALLBACK = PASS
RESOLUTION = PASS
RECONCILED_PNL = PASS
```

FULL_LIVE_READY remains NO until all required Gates are verified.

---

# 32. Exact acceptance criteria for constructor architecture

## Dataset swap

No model/execution edits.

## Model swap

No Ireland/settlement edits.

## Venue swap

No model edits.

## Replay

Deterministic hashes.

## Second domain

Weather uses shared contracts without copying the full contour.

Until these pass:

```text
KERNEL STATUS = CANDIDATE
```

---

# 33. Review and governance

## 33.1 Independent review points

Required after:

- R0 trace design;
- Contract Freeze;
- Kernel Candidate extraction;
- first writer/reviewer pilot;
- second model swap;
- Weather design.

## 33.2 Change statuses

```text
PROPOSED
REVIEWED
FOUNDER_ACCEPTED
IMPLEMENTED
VERIFIED
SUPERSEDED
REJECTED
```

## 33.3 No silent approval

A document does not become architecture merely by being detailed.

---

# 34. Definition of success

## Near-term

One canonical resolved order with trace and D0.

## Medium-term

- stable fixed-stake forward sample;
- Control Plane Lite;
- Founder evidence-first;
- read-only agents;
- model swap.

## Long-term

- multiple Domain Packs;
- trusted Kernel;
- controlled model factory;
- supervised autonomous engineering;
- Founder operates through goals, gates and exceptions.

---

# 35. Final principles

1. A working vertical precedes platform extraction.
2. Instrumentation and visual output develop together.
3. Dashboard is a view, not truth.
4. Typed artifacts precede agent autonomy.
5. Deterministic validators precede LLM review.
6. Model, dataset and venue must be swappable independently.
7. One writer per zone.
8. Reviewer is independent.
9. Founder retains P5.
10. Automation must save time or be removed.
11. No readiness claim without end-to-end evidence.
12. No PnL claim without reconciled lineage.
13. No universal Kernel claim before second-domain proof.
14. No operator training detached from real runs.
15. No agent scale before trusted verification.

---

# Appendix A — D0 conceptual screen

```text
RUN: night-plan:2026-07-22
STATUS: RED
FRESHNESS: FRESH
PHASE: R0B

FIRST FAILING STAGE:
authoritative_universe

FIRST FAILING PREDICATE:
EXACT_MEASURED_CODE

MONEY AT RISK:
$0

NEXT ALLOWED ACTION:
ONE_ACTION

FUNNEL:
source → normalized → model → events → reservations → final → READY

TARGETS:
Chicago: present → ... → absent@stage, code
Detroit: present → ... → absent@stage, code

GATES:
denominator PASS/FAIL
predicate PASS/FAIL
replay PASS/FAIL
WOULD_SUBMIT PASS/FAIL
```

---

# Appendix B — Minimal StageTrace concept

```json
{
  "run_id": "string",
  "stage": "string",
  "stage_version": "v1",
  "stage_index": 1,
  "input_entity_type": "source_row",
  "output_entity_type": "normalized_row",
  "transformation_kind": "FILTER_1_TO_0_OR_1",
  "input_count": 10,
  "output_count": 8,
  "rejection_counts": {"CODE": 2},
  "targets": [],
  "frozen_clock": "ISO",
  "status": "MEASURED",
  "evidence": {
    "ref": "path-or-uri",
    "sha256": "hash",
    "producer_version": "version"
  }
}
```

---

# Appendix C — Founder 60-second checklist

```text
[ ] Status?
[ ] Current phase?
[ ] Money at risk?
[ ] First failing stage?
[ ] Exact code?
[ ] Evidence measured?
[ ] Report fresh?
[ ] One next action?
[ ] Founder action required?
```

---

# Appendix D — Milestone template

```text
Milestone:
Business value:
Precondition:
Exact scope:
Allowed files:
Forbidden files:
Input artifacts:
Output artifacts:
Tests:
Visual output:
Operator skill:
Acceptance:
Stop conditions:
Commit:
Push:
Deploy:
Next Gate:
```

---

# Appendix E — Final decision

This master roadmap supersedes fragmented architectural interpretation across prior RFCs and addenda, but it does not supersede current Git/source/runtime evidence.

It is a design and execution framework.

Implementation starts only from:

```text
R0.1 inspect-only trace-source mapping
```

No web dashboard, agent swarm or Kernel refactor is authorized before the corresponding Gates.

---

# Appendix F — Полная матрица развития по этапам

| Фаза | Что доказываем | Runtime automation | Engineering automation | Visual output | Роль Founder | Переход разрешён когда |
|---|---|---|---|---|---|---|
| R0A | реальный denominator | scheduled source/planning run | executor только inspect/TDD | D0 funnel section | сверяет denominator | все стадии измерены или явно missing |
| R0B | первый failing predicate | finalization trace | Trace Analyst пока не agent, а deterministic logic | D0 target lifecycle | называет failure без чата | exact stage+code+evidence |
| R0C | replay parity | full production-shaped replay | tests/build automated | D0 replay gate | принимает/отклоняет proof | real producer path covered |
| R0D | WOULD_SUBMIT | automatic intent, no CLOB write | evidence packaging | D0 execution section | разрешает переход к live | all guards PASS |
| R0E | canonical live order | one bounded P5 action | no autonomous deploy | D0 live record | explicit live approval | accepted terminal evidence |
| R0F | reconciled record | resolver/settlement | ledger validation | D0 PnL status | принимает first value unit | full lineage |
| R1 | contract freeze | no behavior change | contract tests | contract map | принимает versions | schemas source-backed |
| O0 | baseline | none | time/cost capture | D1 baseline rows | замеряет active time | baseline exists |
| C0 | Control Plane Lite | none | artifact validators | D0/D1 generated | принимает Gate по artifacts | 3 objects valid |
| O1 | evidence-first skill | none | read-only support | D0/D1 | работает без transcript | 3 successful runs |
| C1 | Evidence Auditor shadow | none | one read-only agent | reviewer section | сравнивает verdicts | no critical false PASS |
| K0 | Kernel Candidate | unchanged production | one writer + reviewer | architecture progress line | accepts boundaries | no behavior regression |
| C2 | writer/reviewer pilot | none | isolated worktree | agent status static view | accepts diff, not keystrokes | safe repeated pilot |
| R2 | fixed forward sample | scheduled limited live | reconciliation automation | D1/PnL section | controls caps/exceptions | sufficient resolved sample |
| M0 | model factory foundation | shadow only | evaluation agents | Champion/Challenger report | promotion authority | immutable evaluation |
| K1 | second model swap | shadow first | plugin implementation | model comparison | chooses promotion | no downstream edits |
| D1-domain | Weather Pack | shadow first | domain-specific writer | domain run report | accepts new domain risk | shared contracts survive |
| C3 | controlled parallelism | production remains gated | 2–3 isolated agents | exception queue | orchestrator | validators trusted |
| C4 | supervised autonomy | bounded approved routines | agents launch agents | persistent control UI | goals/exceptions | proven task classes |

---

# Appendix G — Подробная программа обучения Founder/Operator

## G.1 Принцип обучения

Обучение не проводится отдельно от продукта.

Каждый навык осваивается на реальном run и сразу экономит время.

Формат:

```text
короткое объяснение
→ реальный artifact
→ самостоятельное решение
→ автоматическая/архитекторская сверка
→ критерий mastery
```

## G.2 Curriculum

### Module O0 — Vocabulary and value chain

Founder должен объяснить разницу:

| Термин | Что это | Что это не доказывает |
|---|---|---|
| Source row | исходное наблюдение | модельное решение |
| Model decision | принятый model output | reservation/READY |
| Reservation | план на physical event | exact live intent |
| Final candidate | authoritative model result | queue creation |
| READY | исполнение разрешено downstream | venue accepted |
| Submitted | запрос отправлен | order accepted |
| Accepted | venue принял | fill |
| Filled | объём исполнен | settlement |
| Resolved | outcome известен | reconciled net PnL |
| Reconciled PnL | доказанная экономическая запись | statistical model superiority |

**Exercise:** расставить десять записей по lifecycle.
**PASS:** 100% правильный порядок.

### Module O1 — Evidence status

Founder различает:

- measured;
- inferred;
- unknown;
- stale;
- contradiction.

**Exercise:** пять dashboard cards с разными статусами.
**PASS:** ни один Gate не закрыт на inferred/unknown.

### Module O2 — D0 first failure

**Exercise:** blind run report.
**Output Founder:**

```text
first stage
predicate
targets
evidence
next action
```

**PASS:** три runs подряд, <10 минут.

### Module O3 — Artifact validation

**Exercise:** broken count accounting fixture.
**PASS:** Founder отвергает report, несмотря на правдоподобный график.

### Module O4 — D1 denominator

**Exercise:** три ночи, сравнение planning volume.
**PASS:** evidence-backed CONFIRMED/REJECTED/REDEFINED.

### Module O5 — Git and Gate literacy

Founder не анализирует код, но понимает:

```text
branch
HEAD
dirty files
tests
typecheck
build
review
Gate
```

**PASS:** отказывается от merge при unexpected dirty file или failed check.

### Module O6 — Agent permissions

Founder видит P0–P5.

**Exercise:** распределить 12 действий по permission levels.
**PASS:** production mutation всегда P5.

### Module O7 — Writer/reviewer management

**Exercise:** writer claims PASS, reviewer finds target boundary missing.
**PASS:** Founder требует deterministic evidence, не выбирает «кому верит».

### Module O8 — Automation economics

Founder сравнивает capability до/после:

- minutes;
- cost;
- rework;
- false PASS;
- defects.

**PASS:** принимает keep/simplify/remove на основании метрик.

### Module O9 — Exception management

Founder получает только exception queue.

**PASS:** INFO/PASS не требуют ручной обработки; SEV-0/1 обрабатываются по policy.

### Module O10 — Multi-contour portfolio

Только после Weather.

Founder умеет видеть:

- shared Kernel health;
- domain-specific risks;
- model versions;
- exposure;
- unresolved exceptions.

---

# Appendix H — Каталог первых автоматизированных Skills

## H.1 Skill: Precheck Collector

**Replaces:** ручной сбор branch/status/HEAD.
**Permissions:** P0.
**Output:** precheck artifact.
**PASS:** exact repo and no unexpected dirty state.
**Not allowed:** edit/stage/commit.

## H.2 Skill: Stage Trace Validator

**Replaces:** ручная проверка counts и missing reasons.
**Permissions:** P0/P1.
**Output:** validation verdict.
**PASS:** all applicable invariants.
**Not allowed:** fix runtime.

## H.3 Skill: D0 Report Generator

**Replaces:** ручное объяснение run.
**Permissions:** P1.
**Output:** MD+HTML+hash.
**PASS:** identical aggregate in both formats.
**Not allowed:** infer missing data.

## H.4 Skill: Production-Shaped Replay

**Replaces:** ad hoc fixture execution.
**Permissions:** P1.
**Output:** replay artifact.
**PASS:** real loader path and frozen clock.
**Not allowed:** production writes.

## H.5 Skill: Verification Gate Collector

**Replaces:** copying tests/build results into chat.
**Permissions:** P1.
**Output:** VerificationGate.
**PASS:** complete evidence.
**Not allowed:** decide Founder Gate.

## H.6 Skill: Independent Evidence Audit

**Replaces:** first manual architecture review.
**Permissions:** P0.
**Output:** findings and verdict.
**PASS:** no unsupported claim.
**Not allowed:** patch.

## H.7 Skill: Runtime Reconciliation

**Replaces:** manual comparison queue/order/callback/settlement.
**Permissions:** read-only production.
**Output:** mismatch list.
**Not allowed:** mutate ledger.

## H.8 Skill: Release Evidence Packager

**Replaces:** manual release summary.
**Permissions:** P0/P1.
**Output:** SHA/tests/diff/review/rollback.
**Not allowed:** push/deploy.

## H.9 Skill promotion rule

A Skill becomes default only after:

```text
3 supervised PASS
5 total runs
0 unauthorized writes
0 critical false PASS
measured Founder time reduction
documented stop path
```

---

# Appendix I — Agent orchestration patterns

## I.1 Sequential pattern

Use for one uncertain bug:

```text
Inspector
→ Architect
→ Writer
→ Validator
→ Reviewer
→ Founder
```

## I.2 Safe parallel pattern

Use when outputs are independent:

```text
Agent A: runtime source inspection
Agent B: D0 generator on approved fixtures
```

Conditions:

- separate worktrees;
- no overlapping files;
- fixture cannot be called production proof;
- independent merge Gates.

## I.3 Forbidden parallel pattern

```text
Writer A fixes model filter
Writer B fixes same finalization issue
Reviewer merges best-looking result
```

This creates competing truths.

## I.4 Map-reduce pattern

Suitable later for:

- segment decomposition;
- dependency audit;
- multiple independent tests.

Each subagent returns typed partial artifact. Aggregator is deterministic where possible.

## I.5 Escalation pattern

```text
agent STOP
→ artifact states blocker
→ architect narrows scope
→ new bounded task
```

No hidden retry loop.

---

# Appendix J — Dashboard technology decision matrix

| Technology | R0 value | Infra cost | Maintenance | Recommended stage | Decision |
|---|---:|---:|---:|---|---|
| Markdown | High | Minimal | Minimal | D0 | USE |
| Static Plotly HTML | High | Low | Low | D0/D1 | USE |
| Jupyter | Medium | Low | Medium operator friction | Research only | DO NOT use as Founder UI |
| Streamlit | Medium | Medium | New service | None current | REJECT NOW |
| Plotly Dash server | Medium | Medium-high | New runtime | None current | REJECT NOW |
| Grafana | Low current | High setup | Useful only with event/time-series infra | Later | REJECT NOW |
| Internal Next.js read-only route | High later | Medium | Reuses repo/deploy | D2 by Gate | CONDITIONAL |
| Separate Control Plane service | Unknown | High | High | Mature multi-contour | LATER |
| Commercial observability | Unknown | Costly | Vendor dependence | When scale proves need | LATER |

---

# Appendix K — Detailed D0 usage guide for Founder

## K.1 Before opening

Check file/run date.

## K.2 60-second scan

1. Global status.
2. Freshness.
3. Money at risk.
4. First failure.
5. Founder action.

## K.3 10-minute review

1. Funnel collapse.
2. Rejection code.
3. Target lifecycle.
4. Evidence status.
5. Gate.
6. Next action.

## K.4 Founder response format

```text
D0 REVIEW:
Run:
Freshness:
First failing stage:
Predicate/code:
Targets:
Evidence status:
Money at risk:
Gate decision:
Next allowed action:
Time spent:
```

## K.5 Stop

Founder must STOP if:

- STALE;
- UNKNOWN critical stage;
- CONTRADICTION;
- target disappeared without reason;
- no evidence hash;
- more than one next allowed action.

---

# Appendix L — Detailed Control Plane artifact lifecycle

```text
TaskSpec created
→ executor acknowledges permissions
→ precheck attached
→ runtime/code work
→ StageTrace or patch evidence
→ deterministic validation
→ D0/generated view
→ independent review
→ VerificationGate
→ Founder decision
→ release evidence
→ archive/retention
```

No artifact may be silently overwritten after Gate.

New version creates new hash/reference.

---

# Appendix M — Failure-mode catalogue for automation

## M.1 False completion

Agent says PASS, missing upstream boundary.

**Control:** DEV RULE 2 + reviewer.

## M.2 Artifact bureaucracy

Too many fields, Founder stops reading.

**Control:** add field only with demonstrated failure mode.

## M.3 Dashboard drift

View uses different logic from runtime.

**Control:** shared aggregate function, artifact hashes.

## M.4 Stale view

Founder opens old HTML.

**Control:** STALE banner, run validity.

## M.5 Agent context overload

Every agent reads full roadmap.

**Control:** bounded TaskSpec and relevant contracts.

## M.6 Parallel conflict

Two writers touch same zone.

**Control:** worktree/file ownership.

## M.7 Review theatre

Reviewer checks prose, not code/evidence.

**Control:** reviewer receives diff/artifacts.

## M.8 Autonomous risk escalation

Agent enables live because tests passed.

**Control:** P5 Founder only.

## M.9 Cost blindness

More agents, no time savings.

**Control:** cost per accepted Gate.

## M.10 Universal abstraction too early

Sports assumptions become Kernel.

**Control:** Kernel Candidate status until Weather.

---

# Appendix N — Roadmap progress representation

No subjective `75% ready`.

Each area uses evidence gates.

| Area | Required evidence | Current status representation |
|---|---|---|
| Data readiness | denominator, freshness, schema | X/Y gates |
| Model readiness | replay, forward decisions | X/Y gates |
| Orchestrator | reservation→READY | X/Y gates |
| Execution | WOULD_SUBMIT/live/callback | X/Y gates |
| Settlement | resolved/reconciled | X/Y gates |
| Control Plane | artifacts/validators | X/Y gates |
| Agent maturity | shadow/supervised/promotion | level + streak |
| Operator skill | passed exercises | O-level |
| Business evidence | resolved canonical records | count + lineage |

Progress line example:

```text
R0: [PASS][PASS][OPEN][BLOCKED][OPEN][OPEN]
Last verified: timestamp
Blocker: exact code
Next transition: one action
```

---

# Appendix O — RACI

| Activity | Founder | Architect | Executor | Reviewer | Validator |
|---|---|---|---|---|---|
| Product goal | A | R | I | C | I |
| Architecture | A | R | C | C | I |
| Source inspection | I | C | R | C | I |
| Patch | I | C | R | I | C |
| Tests/build | I | C | R | I | R |
| Independent review | I | C | I | R | C |
| Merge | A/R | C | I | C | I |
| Deploy | A/R | C | I | I | I |
| Live enable | A/R | C | I | I | I |
| Model promotion | A | R | C | C | C |
| Gate view | A | R | I | C | C |

A = Accountable, R = Responsible, C = Consulted, I = Informed.

---

# Appendix P — Review questions before every automation milestone

1. Is the underlying process understood?
2. Has it succeeded manually/supervised?
3. Is there a deterministic oracle?
4. Are inputs typed?
5. Are outputs typed?
6. Are permissions bounded?
7. Is rollback possible?
8. Is Founder time baseline known?
9. Will this reduce active minutes?
10. What happens on false PASS?
11. Is a new service truly required?
12. Can static artifact solve it?
13. Does this expand live risk?
14. Is the task reusable?
15. Is there a demonstrated failure mode?

If answers are incomplete, automation remains proposed.

---

# Appendix Q — Handoff compression standard

Future agent handoff should fit into:

```text
TaskSpecLite
Latest compatible contracts
Latest validated StageTrace
VerificationGate
Relevant diff/source files
Open blocker
One next action
```

Do not send:

- full chat;
- all historical RFCs;
- unrelated screenshots;
- old executor explanations;
- contradictory stale summaries.

---

# Appendix R — Long-term Model Improvement Factory

## R.1 Inputs

- frozen dataset snapshot;
- forward ledger;
- model manifest;
- evaluation config;
- execution/liquidity records.

## R.2 Agents

```text
Data Auditor
→ Evaluator
→ Decomposition Agent
→ Hypothesis Agent
→ Implementation Agent
→ Independent Reviewer
```

## R.3 Restrictions

- bounded candidate budget;
- no p-hacking;
- no live promotion;
- immutable runs;
- Champion remains unchanged until Founder approval.

## R.4 Dashboard

Later displays:

- Champion/Challenger;
- sample;
- segment stability;
- drawdown;
- execution feasibility;
- review verdict;
- promotion Gate.

---

# Appendix S — Weather Domain Pack future proof

Weather is selected because it differs materially from sports:

- different source freshness;
- probabilistic forecasts;
- location identity;
- forecast revisions;
- settlement semantics;
- event timing;
- market resolution risk.

Weather must validate:

- canonical observation flexibility;
- model plugin boundary;
- orchestrator generality;
- venue independence;
- settlement contract;
- visual/report reuse.

If Weather requires copying the full sports pipeline, Kernel extraction failed.

---

# Appendix T — Founder decision record template

```text
DECISION:
Date:
Run/Milestone:
Evidence reviewed:
Status:
Accepted:
Rejected:
Unknowns:
Risk:
Allowed next transition:
Forbidden transitions:
P5 action:
Review again when:
```

---

# Appendix U — Final near-term operating model

For the next phase the team does not need 5–10 agents.

It needs:

```text
1 Architect
1 bounded executor
deterministic validators
1 independent reviewer when patch exists
1 Founder Gate
1 D0 report
```

After repeated success:

```text
1 Architect
1 runtime writer
1 isolated reporting writer
1 reviewer
validators
Founder
```

Only after this works should parallel capacity grow.
