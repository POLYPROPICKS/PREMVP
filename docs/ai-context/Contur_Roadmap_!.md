# Contur_Roadmap_!

## PolyProPicks / PREMVP / Contur3 / Ireland / Model Integration
### Полный технический, научный и операторский handoff
### Точка объединения frozen-модели и боевого execution-контура

**Дата состояния:** 17 июля 2026  
**Статус документа:** канонический roadmap интеграции; до появления доказательства Git commit/push этот файл считается внешним handoff-артефактом.  
**Основной PREMVP repo:** `C:\WORK\KalshiProPulse\sipropicks-premvp1-1`  
**Production:** `https://polypropicks.com`  
**Ireland host:** AWS Lightsail, instance `polymarket-executor-lab`  
**Ireland source family:** `/home/ubuntu/polymarket-executor`  
**Главная задача:** соединить доказанный post‑June сигнальный baseline и выбранную Dynamic Protected capital policy с безопасным боевым Contur3 execution-контуром, начать с отдельных контролируемых ставок максимально рано, затем перейти к ограниченной и далее полной автоматизации, сохраняя полный forward dataset, фактические fills, комиссии, результаты и state history.

---

# 0. Назначение файла

Этот файл является **точкой восстановления проекта**. Новый дружественный чат, архитектор, Claude Code, Codex или founder должен по нему понять:

1. где находится проект;
2. какой код и какие ветки являются текущими;
3. что уже доказано и зафризено в моделировании;
4. что уже работает в PREMVP Contur3;
5. что исторически работало на Ireland;
6. что реально активно на Ireland сейчас;
7. почему нельзя просто соединить модель с текущим watcher;
8. какие этапы интеграции утверждены;
9. какие тесты и Gate обязательны;
10. какой executor/model использовать для каждого типа задачи;
11. какие действия запрещены;
12. к какой точке откатываться при неудаче.

Файл не является маркетинговым описанием и не заменяет source code. При конфликте используется приоритет:

```text
1. Текущий source code и git output конкретного repo.
2. Frozen machine artifacts, manifests и hashes.
3. Этот Contur_Roadmap_!.
4. Root/project instructions.
5. Текущий founder message.
6. Старые отчёты и история чатов.
```

Нельзя объявлять этот файл «закоммиченным», пока не получены:

```text
branch
commit hash
push proof
local HEAD
remote HEAD
clean git status
```

---

# 1. Краткий executive status

## 1.1. Что уже работает

### PREMVP / Contur3 producer

Доказанный pipeline:

```text
generated_signal_pairs
→ buildFireModelCandidates
→ night_event_reservations
→ due-window T−70…T−3
→ event rebalance
→ one-best-market selection
→ event_execution_queue status READY
→ GET /api/executor/queue
```

PR #54–#59 смержены в `main`. Последний подтверждённый PREMVP review commit:

```text
ba33663dc54c05ecf9f72df65ca8e7094da0c753
```

На этой точке producer, reservation, rebalance, queue creation и queue read API считаются рабочими для дальнейшего contract integration.

### Историческое Ireland execution proof

На Ireland существовал реальный execution path, который размещал Polymarket order. Подтверждено:

```text
Switzerland vs Colombia
реальный Polymarket portfolio/history record
успешный исход
ручная reconciliation
```

Историческое `orders=0` было не доказательством отсутствия реального order, а в одном из случаев следствием недостаточного join/monitoring contract. PR #59 добавил сохранение `match_family_key`, `reservation_id`, `queue_id` в PREMVP order-event для корректного сопоставления.

### Frozen model research

Зафризены:

```text
frozen 49,400-row dataset
original 231 selected decisions
post-9-June canonical subset: 124 decisions
signal model: B2_PRICE_FLOOR_030_TIMING_WITHIN_120M
fixed-1u signal control
Fixed Safe replay
Dynamic Protected replay
post-June canonical walkthrough
independent review bundle
```

Главный post‑June результат:

```text
124 decisions
61 wins / 63 losses
gross PnL +16.82674451u
gross ROI 13.56995525%
max drawdown 5.86500797u
```

Dynamic Protected fresh-state result:

```text
123 executed / 1 skipped
ending Total 82.11107514u
PnL +32.11107514u
```

## 1.2. Что сейчас не готово

Текущий активный Ireland audit показал queue-only watcher:

```text
candidate endpoint: /api/executor/queue
auth header: x-executor-secret
stake_usd consumed: YES
```

Но в активном consumer не доказаны или отсутствуют:

```text
preferred_entry_iso guard
latest_entry_iso guard
price_cap consumption
price cap before CLOB
CLOB SDK/order function
CLOB size unit
USD→shares conversion
local idempotency
durable local ledger
POST /api/executor/order-events
POST /api/executor/queue/mark
callback retry
accepted-order recovery
safe executor dry-run
```

Следовательно:

```text
historical executor existed and worked;
current active process is not a proven complete executor.
```

## 1.3. Главная архитектурная развилка уже решена

Не выбираем:

```text
«сначала полностью переписать контур»
или
«сразу подключить модель к неготовому executor»
```

Утверждён двухтрековый подход:

```text
TRACK A — EXECUTION
восстановить canonical Ireland source
→ укрепить execution kernel
→ один controlled order
→ controlled batch
→ limited automation

TRACK B — MODEL
встроить frozen model как отдельный versioned producer
→ shadow
→ fixed-stake model-driven orders
→ forward dataset
→ Dynamic Protected shadow
→ Dynamic Protected live
```

Треки могут идти параллельно, но соединяются только после отдельных Gate.

---

# 2. Жёсткие роли и модель маршрутизации

Каждый executor prompt обязан явно указывать модель.

## 2.1. ChatGPT / Architect

Роль:

```text
project architect
senior technical lead
scope controller
prompt writer
reviewer
operator assistant
```

ChatGPT:

```text
не делает вид, что знает source при неопределённости;
не заменяет факты старой памятью;
не разрешает live/order без founder gate;
выдаёт один bounded prompt или короткий CMD block;
контролирует объединение PREMVP и Ireland;
разделяет signal model, capital policy и execution layer.
```

## 2.2. Founder

Founder:

```text
финальный business/live acceptor;
утверждает controlled live order;
утверждает повышение stake/capacity;
утверждает Supabase schema;
утверждает переход в автоматический режим;
не получает ручные multi-file edits.
```

## 2.3. Codex model routing

### Codex Luna

Использовать для:

```text
простого docs-context;
одного понятного файла;
повторяемой Git-проверки;
короткого детерминированного изменения;
небольших scripts без сложной архитектуры;
известного bounded task.
```

Не использовать для:

```text
денежного execution state machine;
cross-repo ambiguity;
научного modeling verdict;
сложной durability/reconciliation.
```

### Codex Terra

Использовать для:

```text
обычной инженерии;
cross-file TDD;
API/backend implementation;
data aggregation;
deterministic artifact generation;
model adapter;
forward dataset writers;
review bundle;
release verification.
```

Terra является default для обычного implementation milestone.

### Codex Sol

Использовать только для действительно сложных/опасных задач:

```text
Ireland execution kernel;
CLOB unit/size semantics;
idempotency and crash recovery;
financial state machine;
atomic claim/lease architecture;
cross-repo contract reconciliation;
hard scientific methodology;
ambiguous high-risk source archaeology.
```

Sol не должен быть default для простой работы.

## 2.4. Claude model routing

### Claude Sonnet 5

Использовать для:

```text
быстрого source-backed PREMVP inspect;
bounded backend patch;
обычного TDD;
docs and contract updates;
routine cross-file implementation;
экономного token use.
```

### Claude Opus 4.8

Использовать для:

```text
глубокого архитектурного review;
сложной системы с несколькими state machines;
широкого design critique;
методологического анализа перед крупным refactor.
```

Не использовать для простой Git/document task.

### Fable

Использовать для:

```text
широкого read-only architecture audit;
параллельного multi-agent source research;
git archaeology;
independent falsification;
cross-repo final review;
поиска скрытых контрактных противоречий.
```

Fable не является implementation executor для live patch без отдельного bounded prompt.

## 2.5. Direct CMD

```text
≤5 простых git/build/curl команд → Direct CMD
>5 команд → bounded executor prompt
неопределённая wiring → inspect-only first
```

---

# 3. Token-optimization rule — обязательный

Нельзя в каждом prompt заставлять executor перечитывать и пересказывать весь instruction stack.

## 3.1. Fresh session

В fresh session:

```text
проверить, что mandatory instruction files существуют;
прочитать только task-relevant sections;
не пересказывать их;
применять правила молча.
```

Mandatory root files:

```text
CLAUDE.md
AGENTS.md
AUTOMATION_MODE_HANDOFF.md
OPERATOR_ACCEPTANCE_CHECKLIST.md
VERIFICATION_GATES.md
WINDSURF_WORKFLOW_RULES.md
README.md только когда setup неясен
```

Если mandatory file отсутствует — STOP.

## 3.2. Continuing session

Если executor уже прочёл правила в текущей сессии:

```text
не перечитывать stack;
не повторять summaries;
сослаться на already-loaded project rules;
прочитать только новые source files.
```

## 3.3. Prompt design

Каждый prompt должен:

```text
указывать exact workspace;
указывать base branch/HEAD;
задавать allowed/forbidden files;
задавать one milestone;
не включать лишние historical essays;
требовать компактный proof package;
не печатать секреты;
не печатать большие outputs на AWS;
```

Для AWS browser SSH:

```text
все большие outputs → /tmp report;
последние строки → one-screen SCREENSHOT_BEGIN/END block;
не использовать pager;
не заставлять founder копировать длинный терминал.
```

---

# 4. Общие TDD и release rules

Любая работа с:

```text
functions
backend logic
parsers
scoring
API behavior
model logic
integrations
scripts
data transformation
reusable utilities
execution state
```

обязана идти TDD-first.

## 4.1. TDD sequence

```text
1. Inspect current source and tests.
2. Define expected behavior.
3. Add failing unit/regression test.
4. Show RED.
5. Implement minimal code.
6. Show GREEN.
7. Run related regression tests.
8. Run TypeScript/build where applicable.
9. Verify determinism and manifests for generated evidence.
```

Если safe test target отсутствует:

```text
STOP;
propose smallest harness;
не fake TDD.
```

## 4.2. Error handling

Обязательно:

```text
boundary input validation;
explicit failure paths;
safe context logging;
never swallow errors;
never log secrets;
never log raw env values;
never log wallet/private keys;
never log sensitive payloads.
```

## 4.3. PREMVP pre-commit gates

```cmd
git branch --show-current
git status --short
git diff --stat
git diff --check
targeted tests
npx tsc --noEmit
npm run build
```

Правила:

```text
stage only intended files;
package.json/package-lock only when explicitly scoped;
не stage modeling/xlsx/csv/report noise;
no trailing whitespace;
no unexpected dirty files;
no railway up;
deploy through GitHub main auto-deploy only when DEPLOY:YES;
production verification separate from local build.
```

## 4.4. Build environment

Если isolated worktree не имеет ignored `.env.local`:

```text
использовать approved PREMVP env-loading mechanism;
environment names only;
не печатать значения;
не commit env;
```

Env-only blocker должен называться честно. Нельзя менять приложение для обхода env validation.

---

# 5. Product and safety locks

Сохранять:

```text
PolyProPicks — premium dark mobile sports/prediction-market signal product;
PremiumEventCard / CanonicalSignalCard — core signal surface;
one visible free signal;
filters remain free;
MarketSource evidence must match active signal;
no guaranteed profit claims;
no fake countdown;
no fake calibrated ML claims;
no unverified news/smart-money claims;
no premature Stripe/auth/admin.
```

Live/Contur safety:

```text
PREMVP is producer;
Ireland is queue-only consumer/executor;
Ireland does not rank;
Ireland does not broad-pull;
Ireland does not apply Tier2/Tier3;
Ireland does not create reservations/rebalance authoritatively;
no live order without explicit founder gate;
no legacy night_live_loop;
no direct execution from reports snapshots.
```

---

# 6. Репозитории и environments

## 6.1. PREMVP

```text
repo:
C:\WORK\KalshiProPulse\sipropicks-premvp1-1

stack:
Next.js / React / TypeScript / CSS Modules
Supabase
Railway
Windows CMD

production:
https://polypropicks.com
```

## 6.2. Modeling worktrees used in current freeze

Primary modeling worktree:

```text
C:\WORK\KalshiProPulse\sipropicks-postcutoff-run
```

Chart/review worktree:

```text
C:\WORK\KalshiProPulse\sipropicks-real-pnl-chart
```

## 6.3. Ireland

```text
AWS Lightsail:
polymarket-executor-lab

source family:
 /home/ubuntu/polymarket-executor

active process evidence:
 scripts/contur3_queue_only_watcher.py

observed launch helpers requiring Phase 0 review:
 /tmp/contur3_queue_producer_tick.sh
 /tmp/contur3_rebalance_producer.sh
```

Наличие process name не доказывает его точную логику. Эти два launcher должны быть классифицированы как:

```text
authoritative producer
diagnostic proxy
legacy
or unsafe duplicate producer
```

до controlled live.

---

# 7. Current Contur3 roadmap position

## 7.1. Старый Contur3 recovery roadmap

Исторически recovery шёл через:

```text
reservation identity
→ preflight
→ live-funnel truthfulness
→ rebalance
→ queue creation
→ Ireland API visibility
→ order monitoring
```

Пройдено:

```text
reservation: PASS
preflight anomaly gating: PASS
cron layer: PASS
due-window: PASS
rebalance: PASS
one-best-market selection: PASS
queue creation: PASS
queue API: PASS
queue lifecycle monitoring: PASS
consumer-handoff diagnostics: PASS
order-event matching fix: MERGED
```

Текущая точка старого roadmap:

```text
PREMVP producer recovery complete;
external Ireland execution reactivation incomplete.
```

## 7.2. Contur3 PR/commit lineage in main

Подтверждённый PREMVP review:

```text
HEAD/origin/main:
ba33663dc54c05ecf9f72df65ca8e7094da0c753
```

Relevant merged work:

| PR / commit | Результат |
|---|---|
| `b2d7cda` / PR #54 | Исправлен false reservation-underfill gating |
| `71d1b44` / PR #55 | Queue lifecycle visibility classification |
| `4f857a1` / PR #56 | Consumer handoff diagnostics |
| `fd96fc3` | Fail-closed stake/price callback validation |
| `9d4e1df` / PR #57 | Executor queue read-only dry-run probe |
| `eb79f81` / PR #59 | Order monitoring/join closeout |
| `3d4e604` | Ireland cross-repo evidence docs |

В текущем main нет отдельной несмерженной Contur3 feature branch.

## 7.3. Canonical producer flow

```text
generated_signal_pairs
→ lib/executor/buildFireModelCandidates.ts
→ lib/executor/nightEventReservations.ts
→ night_event_reservations
→ lib/executor/eventExecutionQueue.ts
→ event_execution_queue
→ app/api/executor/queue/route.ts
```

## 7.4. Canonical Ireland-facing files

```text
app/api/executor/queue/route.ts
app/api/executor/queue/mark/route.ts
app/api/executor/order-events/route.ts
lib/executor/executorQueueTypes.ts
```

## 7.5. API contract

### GET `/api/executor/queue`

Auth:

```text
header:
x-executor-secret

server env:
EXECUTOR_CANDIDATES_SECRET
```

Visibility:

```text
status = READY
latest_entry_iso > server now
```

Order:

```text
preferred_entry_iso ASC
queued_at ASC
```

Default cap:

```text
EXECUTOR_QUEUE_MAX_CANDIDATES or 15
```

`preferred_entry_iso` используется для `entry_state`, но не исключает early rows. Поэтому Ireland обязана проверять:

```text
now >= preferred_entry_iso
now < latest_entry_iso
```

### POST `/api/executor/order-events`

Практически обязательны:

```text
idempotency_key
token_id
submitted_size
submitted_price
```

Сверяются при наличии queue values:

```text
condition_id
side
market_slug
```

Fail-closed:

```text
missing submitted size
stake exceeds queue maximum
missing max_entry_price
missing submitted price
price exceeds max
identity mismatch
```

### POST `/api/executor/queue/mark`

Required:

```text
queue_id
status
source = ireland_queue_only
```

Allowed status family:

```text
CLAIMED
EXECUTED
SKIPPED
FAILED
EXPIRED
```

`EXECUTED` требует:

```text
live_order_confirmed = true
```

Но `queue/mark` не является atomic claim/lease.

## 7.6. Current live candidate algorithm

Current tiers:

```text
score >= 72 and coverage >= 50 → TIER1 live eligible
score >= 60 and coverage >= 50 → TIER2
score >= 50 and coverage >= 25 → TIER3
```

Current Contur3 live doctrine:

```text
только TIER1
```

Stake source:

```text
computeBaseStake(score, coverage)
computeStake(base, smartMoney, esports)
```

Observed effective values:

```text
$3 / $5 / $7
effective base maximum $7
```

Price cap:

```text
max_entry_price =
min(round((signal_entry_price + 0.04) * 1000) / 1000, 0.99)
```

## 7.7. Live market policy

Allowed:

```text
full-match moneyline/winner
full-match spread/handicap
full-match total
```

Blocked/fail-closed:

```text
halftime
first half
second half
corners
exact score
goalscorer
props
futures/outrights
eSports
unknown
```

Known debt:

```text
canonical taxonomy exists,
but runtime blocking still relies on several duplicated regex sets.
```

До full automation нужен single-source taxonomy migration с parity tests.

## 7.8. PREMVP DB tables in contour

```text
generated_signal_pairs
night_event_reservations
event_execution_queue
executor_order_events
executor_audit_events
job_runs
```

Known schema/versioning debt:

```text
CREATE TABLE migrations not fully present for:
generated_signal_pairs
executor_order_events
job_runs
```

Current source also contains status drift between DDL/TS status values and queue-mark accepted values.

## 7.9. PREMVP current risks

### P0 readiness risks

```text
no atomic claim/lease;
PREMVP callback dedup does not prevent duplicate real CLOB order;
idempotency_key uniqueness not proven as money-level protection;
live_order_confirmed is Ireland-asserted.
```

### P1

```text
GET /api/executor/order-events lacks auth;
queue/mark and order-events are independent;
no automatic READY expiry;
no route-level test coverage;
taxonomy duplication;
monitoring order-event dedup weakness;
no aggregate dollar exposure cap in current Contur3 queue.
```

---

# 8. Ireland current and historical state

## 8.1. Historical execution proof

Нельзя писать «Ireland executor никогда не существовал».

Правильная формулировка:

```text
historical one-shot/live executor existed;
at least one real order was executed;
Switzerland–Colombia produced portfolio/history evidence;
one historical CLOB response parser commit was referenced:
5e8f539 — "Executor: parse one-shot CLOB order response".
```

Точный canonical source и full lineage этого successful runner ещё должны быть восстановлены.

## 8.2. Current active audit

Ireland report:

```text
/tmp/CONTUR3_IRELAND_ARCHITECTURE_REVIEW.md

SHA-256:
6273af68b213a8dc7d5f8cbb76cb1cd7c93cc4d6af716efb60aebdf2af3e9c13
```

Compact verdict:

```text
CANDIDATE_ENDPOINT=/api/executor/queue
QUEUE_AUTH_HEADER=x-executor-secret
PREFERRED_TIME_GUARD=NO
LATEST_TIME_GUARD=NO
STAKE_USD_CONSUMED=YES
STAKE_CAP_BEFORE_CLOB=PARTIAL
CLOB_SIZE_UNIT=UNRESOLVED
SIZE_CONVERSION=UNRESOLVED
PRICE_CAP_CONSUMED=NO
PRICE_CAP_BEFORE_CLOB=NO
CLOB_SDK=NONE
ORDER_FUNCTION=NONE
LOCAL_IDEMPOTENCY=NO
LOCAL_LEDGER=NONE
ORDER_EVENTS_POST=NO
QUEUE_MARK_POST=NO
CALLBACK_RETRY=NO
ACCEPTED_POST_FAILED_RECOVERY=NO
SAFE_DRY_RUN=NO
PREMVP_COMPATIBILITY=PARTIAL
CONTROLLED_LIVE=NO_GO
AUTOMATED_LOOP=NO_GO
```

## 8.3. Правильная интерпретация

```text
historical executor:
EXISTED

current active watcher:
QUEUE-ONLY

canonical production-ready executor:
NOT YET IDENTIFIED/PROVEN
```

## 8.4. Ireland doctrine

Ireland обязана:

```text
читать только /api/executor/queue;
не делать ranking;
не broad-pull;
не применять Tier2/Tier3;
не быть вторым authoritative producer;
не использовать legacy /night-plan path;
не запускать forbidden night_live_loop;
исполнять exact condition_id/token_id/side;
уважать stake/price/time caps;
вести local durable journal;
не resubmit CLOB при callback failure.
```

---

# 9. Current modeling roadmap position

## 9.1. Пройденные modeling phases

Roadmap lineage:

```text
MODEL_REVIEW_CLASS1
→ dataset registry
→ dataset build audit
→ result-field consistency
→ keyset export
→ historical verdict
→ post-cutoff freeze
→ decomposition
→ temporal stability
→ ROI/PnL contract
→ bankroll/Vault research
→ state-carrying validation
→ suspicious-growth audit
→ attribution repair
→ post-June canonical freeze
→ walkthrough/review bundle
```

## 9.2. Frozen dataset

```text
rows:
49,400

dataset raw SHA-256:
b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45

deterministic gzip SHA-256:
153cd28fb98294dd6c3e8cdcb480d77c8b10790d1e04ee7bd856a39cfaaa6a85

registry SHA-256:
5ead4f1079920aa61488ce34c17efee1736524f9dd5a95c747f2dcb487d1bf34
```

Canonical package family:

```text
modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/
```

Authority:

```text
BYTE_FROZEN_SNAPSHOT
```

Re-export provenance remains partial.

## 9.3. Frozen signal model

```text
B2_PRICE_FLOOR_030_TIMING_WITHIN_120M
```

Core frozen selector semantics:

```text
stored score >= 65
exclude eSports
entry price >= 0.30
0 <= hours until start < 2
latest eligible snapshot at/before T−90
one representative market per physical event
deterministic ranking
committed execution sequence
```

Important:

```text
UPSTREAM SCORE PRODUCTION IS NOT FROZEN.
```

Live adapter initially consumes stored score and stores score source/version. Он не изобретает новую formula.

## 9.4. Original frozen selected sequence

```text
231 decisions

identity-set SHA-256:
99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca

execution-sequence SHA-256:
5457240a539e5db189c1b23659678f157b322928105909a5812ce318a9d6b036
```

Original full-history results remain evidence but не являются primary canonical verdict.

## 9.5. Suspicious growth audit

Early settlement period:

```text
29 May–7 June
Fixed gain +37.12524392u
Dynamic gain approximately +78.00453764u
```

Audit found:

```text
early median resolution lag ~7.57h
later plateau median lag ~150.96h
settlement chronology materially distorted later visual curve
```

Attribution coverage:

```text
Sport:
230 LOW / 1 UNRESOLVED

League:
230 LOW / 1 UNRESOLVED

Market family:
231 LOW

Trusted HIGH/MEDIUM:
0
```

Therefore:

```text
pre-8-June evidence preserved but quarantined.
```

## 9.6. Post-June canonical scope

Primary:

```text
decisionAt >= 2026-06-09 00:00 Europe/Minsk
124 ordered decisions
```

Sensitivity:

```text
decisionAt >= 2026-06-08 00:00 Europe/Minsk
126 decisions
```

Primary fixed‑1u:

```text
61 wins
63 losses
stake 124u
gross PnL +16.82674451u
gross ROI 13.56995525%
max drawdown 5.86500797u
longest loss streak 4
```

Cost sensitivity:

```text
0 bps:   +16.82674451u
25 bps:  +16.51674451u
50 bps:  +16.20674451u
100 bps: +15.58674451u
200 bps: +14.34674451u
break-even: 1356.99552498 bps
```

## 9.7. Capital profiles

### FIXED_SAFE_V1

```text
stake:
FIXED_1U

Vault:
CPPI_0.4_0.5

family:
ONE_WAY_RATCHETED_CPPI
```

Fresh-state post-June:

```text
49 executed / 75 skipped
Active 25.42422762u
Vault 20.22407047u
Total 45.64829809u
PnL -4.35170191u
max fall 7.86222187u
CVaR95 13.46347823u
```

Verdict:

```text
не использовать live;
policy destroyed positive selector performance through skips/capital constraints.
```

### DYNAMIC_PROTECTED_GROWTH_V1

```text
stake:
DYNAMIC_ACTIVE_3PCT

Vault:
PRV2_T25_P50_R1_S0.05_C0.1

family:
DYNAMIC_PRINCIPAL_RECOVERY_VAULT_V2
```

Fresh-state post-June:

```text
123 executed / 1 skipped
Active 75u
Vault 7.11107514u
Total 82.11107514u
PnL +32.11107514u
max fall 11.46632001u
max concurrency 33
```

Verdict:

```text
selected capital-policy candidate;
not live-approved;
must run shadow on actual fills before live activation.
```

## 9.8. Full-history profile anchors

Fixed:

```text
PnL 51.89997402u
ending Total 101.89997402u
ending Vault 40.75998961u
max fall 6.43150453u
CVaR95 9.92765355u
```

Dynamic state-carrying:

```text
PnL 121.85057149u
ending Active 119.50804292u
ending Vault 52.34252857u
ending Total 171.85057149u
max fall 19.99816041u
CVaR95 25.69447488u
230 executed / 1 skipped
```

Older Dynamic ledgers ending near `82.01226315u` belong to obsolete contract and не являются final authority.

---

# 10. Modeling branches and commits

## 10.1. Temporal audit

Branch:

```text
codex/model-auto-suspicious-growth-temporal-audit-v1
```

Commits:

```text
ccc46d1 — Modeling: implement suspicious growth temporal audit
1fe6a81 — Modeling: add temporal audit evidence and verdict
08760be — Modeling: add temporal audit machine evidence
```

Head:

```text
08760be4455e266e4ce69157c3002e6b0ea93850
```

## 10.2. Attribution repair

Branch:

```text
codex/model-auto-suspicious-growth-attribution-repair-v1
```

Commits:

```text
401a142 — Modeling: implement historical attribution repair
2061356 — Modeling: add attributed growth audit evidence
```

Head:

```text
2061356cdd8099f2ce363a4d74230c29e6123bf4
```

## 10.3. Post-June freeze

Branch:

```text
codex/model-auto-post-june-canonical-freeze-v1
```

Commits:

```text
cc2a1ec — Modeling: implement post-June canonical baseline
e878e0e — Modeling: freeze post-June replay evidence
```

Head:

```text
e878e0efbd5d972c4edac0498d885ea8a7282ad0
```

## 10.4. Walkthrough/review bundle

Branch:

```text
codex/model-auto-post-june-final-walkthrough-review-v1
```

Commits:

```text
ce122b0 — Modeling: add post-June canonical walkthrough
9e95ed9 — Modeling: add independent review bundle
```

Head:

```text
9e95ed99197511d887ef596da77b24ac8ed39989
```

## 10.5. Merge status warning

Подтверждено:

```text
committed and pushed on feature branches.
```

Не считать подтверждённым без отдельного Git proof:

```text
merged into PREMVP main
deployed
production integrated
```

Modeling artifacts остаются research/freeze package до отдельной integration branch.

## 10.6. Docs not yet proven in Git

At the moment of creating this roadmap, these artifacts were created externally and require Git proof:

```text
POLYPROPICKS_OWNER_REBUILD_SPEC_RU_V2.md
Contur_Roadmap_!.md
```

Owner rebuild target path:

```text
modeling/canonical/model-handoff-v1/docs/
POLYPROPICKS_OWNER_REBUILD_SPEC_RU_V2.md
```

This roadmap target path:

```text
docs/ai-context/Contur_Roadmap_!.md
```

No assistant may claim they are committed until proof exists.

---

# 11. Evidence and test counts

## 11.1. Modeling recent gates

Temporal audit:

```text
targeted audit tests: 4/4
existing replay helper tests: 4/4
TypeScript: PASS
configured build: PASS after approved env
deterministic regeneration: PASS
manifest: PASS
```

Attribution repair:

```text
attribution tests: 7/7
temporal regression: 4/4
combined: 11/11
TypeScript: PASS
build: PASS
determinism: PASS
```

Post-June freeze:

```text
post-June test: PASS
regression total reported: 13/13
TypeScript: PASS
build: PASS
deterministic regeneration: PASS
manifest: 0 mismatches
```

Review bundle:

```text
review-bundle validation: PASS
post-June regression: PASS
temporal audit regression: PASS
attribution regression: PASS
TypeScript: PASS
build: PASS
determinism: PASS
source inventory: 15 artifacts
walkthrough: 4,002 words
```

## 11.2. Contur3 current tests found

Named files:

```text
scripts/contur3/lib/__tests__/contur3LiveFunnelMonitor.test.mjs
scripts/contur3/lib/__tests__/contur3ExecutorQueueProbe.test.mjs
scripts/contur3/__tests__/reservation-capacity-audit.tier-probe.test.ts
tests/contur3/executorQueueTypes.stakePricePolicy.test.ts
tests/contur3/taxonomy.corpus.test.ts
tests/contur3/executorQueueRoute.candidateMapping.test.ts
tests/contur3/eventExecutionQueue.stakePropagation.test.ts
```

Historical PR #57 verification reported:

```text
TS Contur3 tests: 33/33
live funnel tests: 37/37
executor probe tests: 8/8
TypeScript: PASS
build: PASS
diff-check: clean
```

Current main architecture audit noted roughly 40 monitor tests but exact current aggregate must be re-run before any patch.

## 11.3. Missing critical tests

```text
route-level auth failures
route-level duplicate callback
exact latest_entry boundary
queue/mark state transitions
atomic claim race
two Ireland consumers
CLOB accepted/callback failed
unknown submission state
partial fill
callback retry without CLOB resubmit
startup reconciliation
durable ledger recovery
actual CLOB size units
```

---

# 12. Final integration architecture

```text
Polymarket/Gamma/CLOB market data
        ↓
generated_signal_pairs / stored score
        ↓
Versioned Model Producer V2
        ↓
immutable signal decision
        ↓
execution intent
        ↓
PREMVP atomic queue/claim
        ↓
Ireland Execution Kernel
        ↓
live market/orderbook validation
        ↓
Polymarket CLOB
        ↓
Ireland durable execution journal
        ↓
PREMVP execution event + queue terminal state
        ↓
fill / position / resolution
        ↓
forward dataset
        ↓
flat signal evaluation
        ↓
Dynamic Protected shadow state
        ↓
future policy promotion
```

## 12.1. PREMVP authority

PREMVP decides:

```text
model_contract_id
signal_policy_id
event
market
condition_id
token_id
side
score and score source
ranking trace
stake recommendation/cap
price cap
preferred/latest entry time
idempotency key
```

## 12.2. Ireland authority

Ireland decides:

```text
actual current price
actual available liquidity
actual safe submitted size within cap
CLOB units conversion
signature
submission
local durability
retry/reconciliation
callback delivery
```

Ireland must not change signal identity.

---

# 13. Global roadmap overview

## Phase 0 — Canonical Ireland source recovery

Goal:

```text
identify exact successful one-shot source;
identify batch source;
identify current watcher;
create clean Git lineage;
classify legacy/report/tmp code.
```

## Phase 1 — Execution Kernel V1

Goal:

```text
small isolated TDD execution core;
time/price/stake guards;
CLOB size adapter;
local idempotency;
durable journal;
callbacks;
reconciliation.
```

## Phase 2 — One controlled new order

Goal:

```text
prove current execution kernel end-to-end with $3.
```

## Phase 3 — Controlled batch on current Contur3 producer

Goal:

```text
3–5 reconciled orders;
fixed $3;
max 3 per approved batch;
single consumer.
```

## Phase 4 — Frozen Model Producer V2 shadow

Goal:

```text
historical-parity model adapter;
no executable queue writes;
immutable shadow decisions.
```

## Phase 5 — First model-driven fixed-stake live orders

Goal:

```text
new model controls identity;
execution kernel already proven;
flat $3 execution.
```

## Phase 6 — Clean forward dataset

Goal:

```text
decision, order, fill, resolution, costs and PnL recorded append-only.
```

## Phase 7 — Dynamic Protected shadow

Goal:

```text
real fills/outcomes;
virtual Active/Vault/Total;
no live dynamic stake.
```

## Phase 8 — Dynamic Protected limited live

Goal:

```text
small dollar Active;
hard per-order/daily caps;
manual kill switch.
```

## Phase 9 — Automated limited/full contour

Goal:

```text
atomic claim;
single-instance execution;
startup reconciliation;
unknown-order resolver;
partial fill handling;
alerts;
continuous safe operation.
```

---

# 14. Detailed Phase 0 — Canonical Ireland source recovery

## 14.1. Current problem

AWS contains:

```text
active loose processes
/tmp launchers
reports snapshots
historical patch copies
legacy night_live_loop
one-shot runner evidence
batch consumer evidence
queue-only watcher
```

Нельзя патчить первое найденное имя.

## 14.2. Required work

1. Trace successful Switzerland–Colombia order to exact source file.
2. Identify exact `contur3_one_shot_queue_runner.py` or equivalent.
3. Identify batch consumer referenced in Ireland closeout.
4. Identify currently active queue-only watcher.
5. Determine Git repo / loose file status for each.
6. Calculate SHA-256 for loose authoritative files.
7. Compare API paths:
   - `/api/executor/queue`
   - `/api/executor/order-events`
   - `/api/executor/queue/mark`
8. Compare CLOB SDK construction.
9. Compare size conversion.
10. Compare local ledger/reconciliation.
11. Classify every source:
   - canonical candidate;
   - legacy;
   - experimental;
   - report snapshot;
   - forbidden.
12. Create clean Ireland Git repo if none exists.
13. Add `.gitignore` for:
   - `.env*`;
   - private keys;
   - wallets;
   - local DB;
   - ledgers;
   - raw logs.
14. Move or mark legacy execution disabled.
15. Choose one canonical entrypoint.
16. Do not run any live code during Phase 0.

## 14.3. Phase 0 Gate

```text
CANONICAL_IRELAND_SOURCE_IDENTIFIED
SUCCESSFUL_ORDER_SOURCE_IDENTIFIED
ONE_SHOT_SOURCE_IDENTIFIED
BATCH_SOURCE_IDENTIFIED
ACTIVE_WATCHER_IDENTIFIED
SECRETS_NOT_IN_GIT
LIVE_NOT_RUN
```

## 14.4. Model routing

```text
AWS source archaeology:
Codex Sol

PREMVP cross-check:
Fable or Claude Opus 4.8 inspect-only

simple Git bootstrap after plan:
Codex Terra
```

---

# 15. Detailed Phase 1 — Execution Kernel V1

## 15.1. Preferred structure

```text
executor/
  queue_client.py
  candidate_contract.py
  time_guard.py
  market_guard.py
  price_guard.py
  size_adapter.py
  exposure_guard.py
  idempotency_store.py
  clob_gateway.py
  execution_journal.py
  callback_client.py
  reconciliation.py
  one_shot.py
  controlled_batch.py
```

## 15.2. Candidate contract

Fail closed unless:

```text
candidate_id present
idempotency_key present
condition_id present
token_id present
side valid
market_slug present
stake_usd finite > 0
max_stake_usd finite > 0
max_entry_price finite in (0,1]
preferred_entry_iso valid
latest_entry_iso valid
game_start_iso valid
```

## 15.3. Time guard

Immediately before CLOB submission:

```text
now >= preferred_entry_iso
now < latest_entry_iso
```

Use timezone-aware UTC datetimes.

Never rely only on queue response visibility.

## 15.4. Market guard

Before submission:

```text
market open
token tradeable
side/token match candidate
orderbook available
best executable ask exists
best ask <= max_entry_price
liquidity sufficient
```

No broad candidate pull and no re-ranking.

## 15.5. Size adapter

Must prove:

```text
stake_usd
→ CLOB size unit
→ submitted_size
```

Required tests:

```text
USD notional to shares
rounding
minimum order
price relation
max stake
partial fill
zero/negative input
```

Live forbidden while `CLOB_SIZE_UNIT=UNRESOLVED`.

## 15.6. Durable journal

Recommended:

```text
SQLite
WAL mode
single local DB
UNIQUE(idempotency_key)
transactional state transitions
```

States:

```text
RECEIVED
VALIDATED
CLAIM_PENDING
CLAIMED
SUBMISSION_STARTED
ORDER_ACCEPTED
ORDER_REJECTED
ORDER_STATUS_UNKNOWN
CALLBACK_PENDING
CALLBACK_CONFIRMED
QUEUE_MARK_PENDING
COMPLETED
RECONCILIATION_REQUIRED
```

## 15.7. Money-level idempotency

Before CLOB:

```text
insert/claim idempotency_key transactionally;
if already present in a submission/accepted/unknown state:
do not submit another order.
```

Callback retry may retry only PREMVP HTTP callback. It must not retry CLOB submission.

## 15.8. Correct post-order sequence

```text
CLOB response
→ durable journal write
→ POST /api/executor/order-events
→ POST /api/executor/queue/mark
→ store callback/mark responses
```

Failure:

```text
CLOB accepted + callback failed
→ state CALLBACK_PENDING
→ retry callback only
```

## 15.9. Single-instance protection

Before controlled batch:

```text
process lock
or SQLite leader lease
or systemd single instance
```

Two parallel consumer processes are forbidden.

## 15.10. Phase 1 tests

At minimum:

```text
candidate schema validation
preferred boundary
latest boundary
stake cap
price cap
market closed
missing orderbook
size conversion
rounding/minimum
duplicate idempotency
restart after SUBMISSION_STARTED
accepted order + callback failure
queue mark failure
unknown CLOB result
partial fill
two-process lock
dry-run no side effects
secret redaction
```

## 15.11. Phase 1 Gate

```text
RED/GREEN complete
offline tests PASS
no network in unit tests
dry-run has zero CLOB POST
dry-run has zero PREMVP POST
duplicate restart test PASS
callback retry test PASS
unknown-state reconciliation PASS
```

Model:

```text
Codex Sol for design/implementation;
Codex Terra for bounded follow-up patches.
```

---

# 16. Detailed Phase 2 — One controlled new order

## 16.1. Why

Исторический order proves possibility, but current canonical kernel must be re-proven.

## 16.2. Current founder decision

Current integration roadmap supersedes old contradictory doctrine:

```text
old historical "all READY overnight" authorization
does not apply to reactivation.
```

Reactivation begins with exactly one controlled order.

## 16.3. Stake

```text
$3 actual stake
```

Historical normalized analytics remain in units; live balance does not justify literal $100 stake.

## 16.4. Required sequence

```text
one READY candidate
→ one-shot dry-run
→ founder sees identity/stake/cap/time/current price
→ explicit GO
→ one live CLOB submit
→ local journal
→ order-event
→ queue mark
→ portfolio verification
→ later resolution
```

## 16.5. Acceptance

```text
exactly one CLOB attempt
exactly one local accepted/rejected row
exactly one PREMVP order-event
one terminal queue state
no duplicate
size <= cap
price <= cap
identity exact
```

Model:

```text
Codex Sol on AWS;
Founder GO required.
```

---

# 17. Detailed Phase 3 — Controlled batch

## 17.1. Entry criteria

```text
Phase 2 PASS;
reconciliation complete;
no unknown order state;
no duplicate;
callback/mark both consistent.
```

## 17.2. Batch policy

Initial:

```text
fixed $3
max 3 orders per approved batch
max 3 concurrent open positions
single consumer process
manual batch approval
```

Then, after 3–5 clean reconciled orders:

```text
consider $5;
do not raise solely because of wins.
```

No Dynamic and no CPPI.

## 17.3. Gate

```text
3–5 resolved/reconciled orders
0 duplicate submissions
0 unresolved callback state
0 cap violations
0 stale-window submissions
```

---

# 18. Detailed Phase 4 — Frozen Model Producer V2 shadow

## 18.1. Isolation

Do not replace current Contur3 builder in place.

Preferred:

```text
lib/modeling/liveModelProducerV2/
```

## 18.2. Functions

```text
loadEligibleStoredScores
selectT90Snapshot
applyScoreGate
excludeEsports
applyPriceFloor
applyTimingWindow
deriveEventIdentity
rankEventMarkets
selectRepresentative
buildImmutableDecision
```

## 18.3. Output

```text
model_run_id
model_contract_id
signal_policy_id
source_observation_id
decision_at
event_start
condition_id
token_id
side
score
score source/version
entry price
price cap
event group key
ranking trace
selection trace
recommended flat stake
dynamic stake shadow
```

## 18.4. No live side effects

Shadow producer must not:

```text
write event_execution_queue
call Ireland
mark queue
place order
```

## 18.5. Historical parity

Must reproduce:

```text
frozen model contract
post-June subset logic
boundary behavior
deterministic selection
```

It should not be expected to reproduce the exact old corpus from a different live date; it must reproduce the algorithm on fixtures and frozen snapshot.

## 18.6. Gate

```text
selector TDD PASS
historical fixtures PASS
no outcome leakage
deterministic hash
no queue writes
```

Model:

```text
Codex Terra
or Claude Sonnet 5 for routine PREMVP implementation.
```

---

# 19. Detailed Phase 5 — First model-driven live orders

## 19.1. Start policy

Use:

```text
flat fixed $3
```

Do not use Fixed Safe.

Do not use Dynamic live yet.

## 19.2. Rollout

```text
model orders 1–5:
one-shot/manual $3

orders 6–20:
controlled batch max 3
```

## 19.3. Dual accounting

Store:

```text
actual USD stake/PnL
normalized 1u return
```

This permits forward comparison to historical fixed‑1u research.

## 19.4. Gate

```text
20 model-driven resolved decisions
or explicit founder exception with evidence;
no execution contract failures;
forward data complete;
gross/net metrics separated.
```

---

# 20. Detailed Phase 6 — Forward dataset

Requires explicit founder approval for Supabase schema.

## 20.1. Proposed tables

```text
forward_model_runs
forward_signal_decisions
execution_intents
execution_attempts
execution_fills
position_resolutions
capital_policy_states
```

## 20.2. Decision-time fields

```text
model version
score and source
event/provider IDs
condition/token/side
decision time
event start
entry snapshot
orderbook snapshot
liquidity
spread
price cap
ranking trace
rejected alternatives
```

## 20.3. Execution fields

```text
intent ID
idempotency key
submitted price
submitted size
filled size
average fill
fee
slippage
CLOB order ID
transaction hash
timestamps
partial fill
callback state
queue state
```

## 20.4. Resolution fields

```text
winning outcome
actual USD PnL
normalized return
fees
fill latency
resolution lag
model policy
capital policy
```

## 20.5. Clean dataset rules

```text
append-only
versioned schema
provider event identity
no title-only identity when provider ID available
no overwrite of frozen historical corpus
historical and forward datasets separate
```

---

# 21. Detailed Phase 7 — Dynamic Protected shadow

## 21.1. Input

Use actual:

```text
selected signals
actual fill prices
actual fees
actual outcomes
```

But virtual capital state.

## 21.2. State

```text
Active
Vault
Total
free Active
open principal
cycle reference
transfer remaining
executed/skipped
```

## 21.3. Policy

```text
DYNAMIC_ACTIVE_3PCT
PRV2_T25_P50_R1_S0.05_C0.1
```

## 21.4. Minimum Gate

```text
minimum 30 resolved live decisions
preferred 50
0 state reconciliation errors
actual-fill replay deterministic
no exposure violations
dynamic shadow better than flat after actual costs
```

No live Dynamic before Gate.

---

# 22. Detailed Phase 8 — Dynamic Protected limited live

## 22.1. Scale

Do not use historical `1u=$100` literally.

Initialize:

```text
Active = founder-approved execution capital
Vault = 0 or explicit founder value
stake = 3% × cycle Active reference
hard per-order dollar cap
```

## 22.2. Initial limits

```text
max 1 dynamic position
then max 3
daily exposure cap
daily loss stop
one-way Vault
manual kill switch
```

## 22.3. Promotion

Promotion from flat live requires:

```text
Dynamic shadow Gate PASS
execution kernel stable
fees/slippage measured
minimum order/rounding proven
founder approval
```

---

# 23. Detailed Phase 9 — Automated mode

## 23.1. PREMVP required work

```text
atomic claim/lease endpoint
compare-and-swap status
unique idempotency constraints
automatic READY expiry
authenticated GET order-events
unified status enum
route-level tests
order-event/queue reconciliation
heartbeat visibility
```

## 23.2. Ireland required work

```text
single-instance lock
durable SQLite journal
startup reconciliation
unknown-order resolver
partial-fill handling
callback retry without CLOB resubmit
exposure/balance guard
heartbeat
kill switch
safe service unit
```

## 23.3. Modes

```text
SHADOW
DRY_RUN
ONE_SHOT
CONTROLLED_BATCH
AUTOMATED_LIMITED
AUTOMATED_FULL
```

Mode change is explicit configuration plus founder gate.

---

# 24. Parallel execution strategy

## 24.1. Work allowed in parallel now

### Ireland Track A0

```text
Codex Sol:
canonical source recovery
```

No edits/live.

### PREMVP Track B0

```text
Claude Sonnet 5 or Fable:
inspect exact integration seam for Model Producer V2
map current generated_signal_pairs → shadow decisions
no patch yet
```

These can run simultaneously.

## 24.2. Work that cannot be parallelized across a Gate

Cannot start:

```text
live one-shot
```

until Ireland Phase 1 tests pass.

Cannot start:

```text
model-driven live
```

until:

```text
execution Phase 2 PASS
and model Phase 4 PASS.
```

Cannot start Dynamic live until forward shadow Gate.

---

# 25. First exact next milestones

## Milestone A — Ireland canonical source recovery

```text
TASK CLASSIFICATION:
inspect-only / external-consumer-source-recovery

MODEL:
Codex Sol

COMMIT:
NO initially

OUTPUT:
canonical source map
successful order source
one-shot source
batch source
active watcher source
hashes
recommended repo root
```

## Milestone B — PREMVP model integration seam audit

```text
TASK CLASSIFICATION:
inspect-only / backend-model-integration-map

MODEL:
Claude Sonnet 5

COMMIT:
NO

OUTPUT:
exact source path from generated_signal_pairs
current producer interfaces
new shadow table/artifact options
allowed files for implementation
tests to add
no queue/order changes
```

Run A and B concurrently.

After both:

```text
Milestone C:
Fable cross-track review
```

It chooses exact Phase 1 and Phase 4 implementation prompts.

---

# 26. Rollback checkpoints

## Checkpoint C0 — PREMVP current producer

```text
main:
ba33663dc54c05ecf9f72df65ca8e7094da0c753
```

Return here if integration patches destabilize Contur3.

## Checkpoint M0 — Modeling canonical package

```text
branch:
codex/model-auto-post-june-final-walkthrough-review-v1

HEAD:
9e95ed99197511d887ef596da77b24ac8ed39989
```

Return here if live adapter changes model semantics.

## Checkpoint M1 — Frozen post-June evidence

```text
branch:
codex/model-auto-post-june-canonical-freeze-v1

HEAD:
e878e0efbd5d972c4edac0498d885ea8a7282ad0
```

## Checkpoint I0 — Historical Ireland evidence

```text
Switzerland–Colombia order evidence
plus historical source commit/reference 5e8f539
```

Before modifying Ireland, canonical files and hashes must be preserved in Git.

## Checkpoint I1 — Current AWS audit

```text
/tmp/CONTUR3_IRELAND_ARCHITECTURE_REVIEW.md
SHA-256 6273af68...
```

This proves current active watcher limitations.

---

# 27. Stop conditions

Stop immediately when:

```text
unexpected dirty files;
source root uncertain;
candidate size unit unresolved before live;
current price cap cannot be enforced;
two active consumer processes;
idempotency journal unavailable;
CLOB status unknown with no reconciliation;
callback failure causes CLOB resubmit;
secret appears in logs;
model selector differs from frozen contract;
outcome data enters selection;
historical/forward data mixed;
build/test failure caused by patch;
PREMVP main differs from recorded base unexpectedly;
Ireland code is only found under reports snapshot without authoritative source.
```

After one failed broad executor attempt:

```text
Direct-source option check:
continue with executor
or request source files
or provide exact full-file replacement
because [specific reason].
```

---

# 28. Current GO/NO-GO matrix

| Area | Verdict |
|---|---|
| PREMVP reservations | GO |
| PREMVP rebalance | GO |
| PREMVP queue creation | GO |
| PREMVP queue read API | GO |
| PREMVP current callback architecture | PARTIAL |
| Historical Ireland one-shot proof | CONFIRMED |
| Current active Ireland watcher read-only | GO |
| Current active Ireland live executor | NO-GO |
| Canonical Ireland source recovery | NEXT |
| Frozen model research baseline | FROZEN |
| Independent model review | READY/BUNDLE EXISTS, not production approval |
| Model shadow adapter | GO after seam audit |
| First new model-driven order | BLOCKED by execution Gate |
| Fixed Safe live | NO-GO |
| Dynamic Protected shadow | FUTURE after forward data |
| Dynamic Protected live | NO-GO now |
| Full automated loop | NO-GO now |

---

# 29. What must never be confused

```text
historical executor existed
≠ current active executor is complete

queue callback dedup
≠ prevention of duplicate real order

fixed-1u signal control
≠ bankroll policy result

Dynamic historical replay
≠ live Dynamic approval

post-June frozen baseline
≠ production model integration

queue candidate visible
≠ candidate actionable now

successful CLOB order
≠ position fully filled/resolved/reconciled

feature branch pushed
≠ merged to main
≠ deployed
≠ production verified
```

---

# 30. Current final decision

The project is at the exact merge point:

```text
OLD CONTUR3 ROADMAP:
producer and observability recovered;
Ireland reactivation incomplete.

MODELING ROADMAP:
post-June model and capital candidates frozen;
production integration not started.

NEW INTEGRATION ROADMAP:
Phase 0 begins now.
```

Optimal execution:

```text
1. Recover canonical Ireland source.
2. In parallel inspect PREMVP model-shadow seam.
3. Build Execution Kernel V1.
4. Prove one new $3 order.
5. Build frozen model shadow producer.
6. Run first model-driven fixed-$3 orders.
7. Build clean forward dataset.
8. Run Dynamic Protected shadow.
9. Promote Dynamic only after forward evidence.
10. Automate only after atomic claim and durable reconciliation.
```

This path begins earning as early as technically defensible while preserving money-level safety, scientific separation, reproducibility and rollback.

---

# 31. Required response format for every future milestone

Every engineering response starts:

```text
TASK CLASSIFICATION:
EXECUTION MODE:
MODEL:
COMMIT:
PUSH:
DEPLOY:
PR:

ALLOWED FILES
FORBIDDEN FILES
STOP CONDITIONS
EVIDENCE REQUIRED
FOUNDER ACTION
```

Executor response must include:

```text
Precheck
Actual branch/workspace
Files changed
Old/new snippets
Tests added
RED
GREEN
Regression tests
TypeScript
Build
git diff --check
git diff --stat
git status
Risks/assumptions
Gate verdict
Commit hash
Push proof when applicable
```

For Ireland browser terminal:

```text
one-screen final block
detailed report in /tmp
no large terminal output
```

---

# 32. Source index

## PREMVP current source

```text
lib/executor/buildFireModelCandidates.ts
lib/executor/nightEventReservations.ts
lib/executor/eventExecutionQueue.ts
lib/executor/executorQueueTypes.ts
lib/contur3/taxonomy.ts
app/api/executor/queue/route.ts
app/api/executor/queue/mark/route.ts
app/api/executor/order-events/route.ts
scripts/contur3/
tests/contur3/
```

## Modeling

```text
modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/
modeling/canonical/model-handoff-v1/
modeling/evidence/2026-07-17-suspicious-growth-temporal-audit-v1/
modeling/evidence/2026-07-17-suspicious-growth-attribution-repair-v1/
modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/
modeling/review/2026-07-17-post-june-canonical-review-v1/
```

## Main founder docs

```text
modeling/canonical/model-handoff-v1/docs/
POLYPROPICKS_POST_JUNE_CANONICAL_WALKTHROUGH_RU_V1.md

modeling/canonical/model-handoff-v1/docs/
POLYPROPICKS_OWNER_REBUILD_SPEC_RU_V2.md

docs/ai-context/
Contur_Roadmap_!.md
```

---

# 33. Final one-screen handoff

```text
PREMVP MAIN:
ba33663dc54c05ecf9f72df65ca8e7094da0c753

CONTUR3:
producer/rebalance/queue ready
Ireland reactivation incomplete

HISTORICAL IRELAND:
real Switzerland–Colombia order confirmed

CURRENT IRELAND:
queue-only watcher
no proven current CLOB/callback/durability path

FROZEN MODEL:
B2_PRICE_FLOOR_030_TIMING_WITHIN_120M

FROZEN DATASET:
49,400 rows
SHA b2f5df...

CANONICAL PERIOD:
decisionAt >= 9 June 2026 Minsk
124 decisions
+16.82674451u
13.56995525% gross ROI

FIXED SAFE:
negative post-June
not live

DYNAMIC PROTECTED:
positive post-June
shadow first, live later

CURRENT PHASE:
INTEGRATION PHASE 0

NEXT PARALLEL ACTIONS:
Codex Sol on Ireland source recovery
Claude Sonnet 5 on PREMVP model seam audit

CONTROLLED LIVE:
blocked until Execution Kernel V1

MODEL-DRIVEN LIVE:
blocked until execution proof + shadow parity

FULL AUTOMATION:
blocked until atomic claim + durable reconciliation
```
