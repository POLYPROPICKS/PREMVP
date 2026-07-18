# PolyProPicks — Handoff параллельных треков (Track B / Track A)

> Компактный source-of-truth для будущих сессий ChatGPT, Claude Code, Fable,
> Sonnet, Opus и Codex. Позволяет обоим трекам продолжать работу без перезагрузки
> всей истории.

## 1. Статус и охват

- Текущая глобальная фаза: **Integration Phase 0**.
- Controlled live: **NO-GO**.
- Track A и Track B могут развиваться **параллельно**.
- Любое connected/live-исполнение требует **отдельного синхронизационного Gate**.

Терминология:

- **Phase 4A** = Frozen Model Producer V2 Historical Parity.
- Независимая проверка Opus — это **acceptance Gate между Phase 4A и Phase 4B**
  (не сама реализация).
- **Phase 4B** = Forward Local Shadow (это **не** независимый review).

## 2. Track B — PREMVP backend/model

Владелец:

- текущий основной чат;
- Claude Code / Fable / Sonnet 5 / Opus 4.8.

Зона ответственности:

- frozen model contract;
- канонические решения модели (canonical model decisions);
- неизменяемая идентичность решения (immutable decision identity);
- Forward Local Shadow;
- backend/API-контракты PREMVP;
- persistence seam — только после founder Gate.

Текущие чекпойнты:

- modeling base: `9e95ed99197511d887ef596da77b24ac8ed39989`
- boundary-test checkpoint: `a39052520a794b58af98c95c6c2d7205ceaf8a1b`
- Phase 4A production commit: `bc0ee1097e14a0752144b4e111dc192a0e5548f9`
- текущий portability commit: `1635e4858b81aa0b35346ea25a3555c21799762d`
  (Git HEAD ветки `codex/frozen-model-producer-v2-shadow-v1`)

Доказанный контракт:

```
49 400 сырых строк
  → канонический execution waterfall
  → 231 упорядоченное решение
  → order-preserving post-June фильтр
  → 124 решения
```

Хеши:

- identity: `99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca`
- execution: `5457240a539e5db189c1b23659678f157b322928105909a5812ce318a9d6b036`

Следующая веха Track B — **Phase 4B Forward Local Shadow**:

- append-only локальные evidence;
- неизменяемая идентичность решения;
- без записей в Supabase;
- без записей в очередь (queue);
- без live-исполнения;
- независимый review до интеграции с persistence.

### 2.1 Phase 4B — принято + Forward Snapshot Exporter (checkpoint)

- **Accepted Phase 4B Forward Local Shadow HEAD:**
  `1a01f2741c55880b3de2896d70717f7ab0ba3725`
  (независимая acceptance-проверка PASS: reuse канонической модели,
  fail-closed forward-валидация, append-only journal, exact rerun no-op,
  exclusive lock, реальный black-box CLI).
- **Forward Snapshot Exporter (read-only):**
  - ветка: `claude/phase4b-readonly-snapshot-exporter-v1`
  - commit: `179594a79ea054f5abaf0802f47b0381ac372a6f`
  - статус: **implementation checkpoint** — ожидает последующей независимой
    acceptance.
  - файлы: `lib/modeling/forwardSnapshotExporter.ts`,
    `scripts/modeling/strategies/exportForwardLocalShadowSnapshot.ts`,
    + два теста в `tests/modeling/`.
- **Проверенная offline-цепочка (без live-сети):**

```
fake read-only source adapter
  → real forward snapshot exporter
  → deterministic snapshot.jsonl + manifest.json
  → real runForwardLocalShadow CLI
  → append-only journal
  → exact rerun no-op (journal byte-identical)
```

- Source contract: единственная таблица `generated_signal_pairs`;
  unresolved = `signal_result IS NULL AND resolved_at IS NULL`;
  as-of = `created_at <= asOf`; keyset-пагинация `(created_at DESC, id DESC)`;
  переиспользуется `normalizeGeneratedSignalPairRow`. Модельная селекция
  (score/price/timing/T−90/ranking/one-per-event/post-June) в экспортёр **не**
  входит — остаётся в waterfall/producer.
- **Live Supabase export НЕ запускался** (LIVE_SUPABASE_CALLS: 0).
- Без записей в схему/API/очередь; без миграций; без деплоя; без force-push.
- **Текущая следующая веха Track B:** founder-approved read-only production
  snapshot trial (первый реальный, но по-прежнему read-only, прогон экспортёра
  на проде — только после явного founder Gate).
- Controlled live остаётся **NO-GO**. Кросс-трековый Sync Gate **без изменений**.

## 3. Track A — Ireland execution

Владелец:

- соседний проектный чат;
- Codex Sol — финансовое состояние;
- Codex Terra — bounded review/test/Git.

Окружение:

- AWS Lightsail `polymarket-executor-lab`;
- активный источник: `/home/ubuntu/polymarket-executor`
- изолированный dev-worktree: `/home/ubuntu/polymarket-executor-kernel-v1`
- ветка: `codex/ireland-execution-kernel-v1`
- V1A checkpoint: `aacea11eb7005e510b0f269125c9859d3fe882a2`

Завершено в V1A:

- стабильная идентичность исполнения;
- durable atomic SQLite claim;
- fail-closed SUBMITTING/UNKNOWN;
- защита при рестарте;
- межпроцессный single-consumer lock;
- атомарный rollback.

Следующие вехи Track A:

1. V1B — точная сверка order-ID и частичные исполнения (partial fills).
2. V1C — durable callback outbox и интеграция runner.
3. V1D — полный offline E2E-симулятор.
4. Connected read-only compatibility dry-run.
5. Только после явного founder Gate — один контролируемый ордер на $3.
6. Контролируемый batch.
7. Ограниченная автоматизация — только после evidence по сверке.

## 4. Граница владения (ownership boundary)

PREMVP владеет:

- идентичностью решения сигнала/модели;
- condition_id / token_id / side;
- stake и price caps;
- preferred/latest timing;
- idempotency key;
- model evidence;
- API-контрактом.

Ireland владеет:

- текущей ценой и ликвидностью CLOB;
- фактическим безопасным размером в пределах caps;
- единицами размера CLOB;
- отправкой ордера;
- локальным durable-состоянием;
- точной сверкой ордеров (exact-order reconciliation);
- частичными исполнениями;
- доставкой callback.

Ireland **не** должен:

- реранжировать кандидатов;
- менять решения модели;
- создавать reservations PREMVP;
- менять схему Supabase;
- менять API PREMVP;
- обращаться к Supabase PREMVP напрямую.

PREMVP **не** должен:

- реализовывать CLOB signing;
- менять SQLite journal Ireland;
- управлять process locks Ireland;
- выводить точное состояние fill без сверки Ireland.

## 5. Кросс-трековые синхронизационные Gates

**Sync Gate 1:**

- Track A: `IRELAND_KERNEL_V1D_OFFLINE_E2E_PASS`
- Track B: `PHASE4B_FORWARD_LOCAL_SHADOW_PASS`

Затем — один кросс-трековый compatibility review, покрывающий:

- парность неизменяемой идентичности;
- парность idempotency-key;
- caps по price/stake/timing;
- payload очереди;
- payload order-events;
- payload queue-mark;
- совместимость enum;
- владение отказами (failure ownership);
- семантику повторов callback.

**Sync Gate 2 (до любого connected dry-run):**

- точный снимок API PREMVP;
- отсутствие состояния UNKNOWN в Ireland;
- отсутствие backlog callback;
- единственный consumer;
- чистые ветки/worktrees;
- одобрение founder.

## 6. Жёсткие правила безопасности

- UNKNOWN никогда не переотправляется автоматически.
- Частичное исполнение никогда не создаёт новый ордер.
- Отказ callback повторяет только callback.
- Нет сети/ордеров во время Ireland V1B–V1D.
- Нет записей Supabase/queue во время PREMVP Phase 4B.
- Нет изменений service/cron/deploy без одобрения founder.
- Нет заявлений о гарантированной прибыли или неподтверждённой калибровке модели.
- Push не означает deploy.
- Controlled live остаётся **NO-GO** до явного объединённого Gate.

## 7. Маршрутизация моделей

- **Codex Sol**: жизненный цикл ордера, сверка, durable финансовое состояние, callbacks.
- **Codex Terra**: bounded source review, тесты, Git-верификация.
- **Sonnet 5**: bounded-реализация в PREMVP.
- **Opus 4.8 / Fable**: независимый adversarial architecture review.
- **Founder**: live-ордер, схема, deploy и production-acceptance.

## 8. Правила Handoff

Каждый трек сообщает:

- repo/worktree;
- ветку и точный HEAD;
- изменённые файлы;
- RED/GREEN;
- targeted-тесты;
- регрессии;
- TypeScript/build;
- `git diff --check`;
- commit и доказательство remote;
- текущий Gate;
- точную следующую веху.

Терминальный отчёт Ireland — один экран; детальные evidence — в `/tmp`.

## 9. Текущие следующие действия

Track B: проектирование и реализация Phase 4B Forward Local Shadow после этого
docs-коммита.

Track A: V1B — точная сверка order-ID и жизненный цикл частичных исполнений в
соседнем чате.

Не дублировать задачу одного трека в другом.
