# PolyProPicks — полная спецификация восстановления алгоритма для Owner  
## Версия V2: selector, dataset, replay, Fixed Safe, Dynamic Protected и post‑June canonical baseline

**Назначение документа:** этот файл должен позволить технически грамотному владельцу или новой команде восстановить исторический исследовательский контур PolyProPicks после потери исходного контекста. Он не является маркетинговым описанием. Он фиксирует входные данные, порядок правил, формулы, состояния капитала, обязательные проверки и известные пробелы.

**Главный принцип:** если текст документа расходится с текущим Git, источником истины является текущий код и frozen machine evidence. Этот документ должен использоваться вместе с parity‑тестами и хешами, а не вместо них.

**Статус production:** не утверждён.  
**Статус PREMVP integration:** заблокирован до независимого review.  
**Статус Ireland:** заблокирован.  
**Текущий честный исторический baseline:** решения с `decisionAt >= 2026-06-09 00:00 Europe/Minsk`. Данные до 8 июня сохранены, но помещены в карантин из‑за нулевого покрытия атрибуции уровня `HIGH/MEDIUM` по sport/league/market family.

---

# 0. Что именно можно восстановить по этому документу

По этой спецификации можно заново реализовать и проверить:

1. чтение frozen dataset;
2. нормализацию ключевых полей;
3. строгую дедупликацию observation;
4. выбор последнего допустимого snapshot на точке «за 90 минут до старта»;
5. активную сигнальную модель `B2_PRICE_FLOOR_030_TIMING_WITHIN_120M`;
6. группировку рынков одного физического события;
7. детерминированный ranking и выбор одного рынка на событие;
8. формулу исторического Profit and Loss;
9. committed execution order;
10. одновременное settlement‑batching;
11. Fixed Safe profile;
12. Dynamic Protected Growth profile;
13. post‑June fixed‑1u signal control;
14. cost sensitivity;
15. frozen hashes и тестовые границы.

По текущему frozen handoff **нельзя безопасно восстановить без дополнительного источника**:

1. исходную формулу производства Market Signal Score;
2. полный upstream collector от официальных Polymarket API до `generated_signal_pairs`;
3. достоверную историческую sport/league/market-family атрибуцию для большинства 231 строк;
4. production runtime wiring;
5. реальные комиссии, slippage, partial fills и latency.

Это не мелкие оговорки. Для disaster recovery они являются отдельными незакрытыми контрактами.

---

# 1. Короткое объяснение всей системы

PolyProPicks не начинает с размера ставки. Сначала система выбирает **какой рынок вообще достоин рассмотрения**.

Полный порядок:

```text
официальные market data / внутренний upstream scorer
→ Supabase public.generated_signal_pairs
→ frozen 49,400-row dataset
→ strict observation identity
→ latest snapshot at or before T−90
→ score ≥ 65
→ exclude eSports
→ entry price ≥ 0.30
→ 0 ≤ hours until start < 2
→ physical sporting-event identity
→ ranking рынков одного события
→ один representative market на событие
→ frozen observation membership
→ committed execution order
→ stake policy
→ capacity/exposure checks
→ open principal
→ same-timestamp settlement batch
→ Vault policy
→ updated Active / Vault / Total
```

Критически важно разделять четыре разных объекта:

| Объект | Что это |
|---|---|
| Dataset row | Один исторический snapshot одного рынка |
| Selected signal | Dataset row, прошедший selector и победивший ranking внутри события |
| Intended execution | Selected signal в frozen chronological sequence |
| Executed position | Intended execution, для которого capital policy реально разрешила открыть позицию |

Положительный fixed‑1u selector ещё не означает, что любая bankroll policy будет положительной. Post‑June показал именно это: signal control был положительным, Fixed Safe fresh-state replay оказался отрицательным, а Dynamic Protected — положительным.

---

# 2. API и происхождение данных

## 2.1. Что является непосредственным входом модели

Непосредственный вход frozen historical research:

```text
Supabase table:
public.generated_signal_pairs
```

Historical replay не должен обращаться к live Polymarket API. Он должен читать только конкретный frozen dataset с проверенным SHA‑256.

Экспорт реализован read-only через Supabase PostgREST. Используемые имена environment variables:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Допустимые fallback‑имена в exporter:

```text
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_ANON_KEY
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

Секретные значения никогда не логируются и не попадают в manifest.

## 2.2. Контракт read-only export

Source file:

```text
scripts/modeling/export-generated-signal-pairs-from-supabase.ts
```

Точная семантика экспортера:

```text
source table: generated_signal_pairs
resolved filter: resolved_at IS NOT NULL
pagination: keyset by resolved_at and id
sort: resolved_at DESC, id DESC
deep offset: forbidden
retry: allowed for 429 and transient 5xx
writes: local artifact only
Supabase writes: forbidden
```

Упрощённый эквивалент запроса:

```http
GET {SUPABASE_URL}/rest/v1/generated_signal_pairs
  ?select=*
  &resolved_at=not.is.null
  &order=resolved_at.desc,id.desc
  &limit={PAGE_SIZE}
```

Следующая страница должна использовать keyset, а не `offset`:

```text
resolved_at < lastResolvedAt
OR
(resolved_at = lastResolvedAt AND id < lastId)
```

Для строк с одинаковым `resolved_at` порядок стабилизируется полем `id`.

## 2.3. Какие поля exporter нормализует

Exporter читает альтернативные исторические имена и формирует нормализованную строку:

```text
id
condition_id
token_id
created_at
resolved_at
formula_version
metric_formula_version
score
signal_score
pre_event_score_num
coverage
coverage_score
signal_result
result
outcome_status
winning_outcome
selected_outcome
entry_price_num
realized_return_pct
real_pnl_usd
match_family_key
canonical_event_key
parent_event_key
event_slug
event_title
market_slug
league
hours_until_start
diagnostics
```

Правила fallback:

```text
token_id:
token_id
→ selected_token_id
→ diagnostics.selectedTokenId

entry price:
entry_price_num
→ entry_price
→ diagnostics.entryPrice

score:
score
→ signal_score
→ pre_event_score_num

coverage:
coverage
→ coverage_score
```

Отсутствующие `undefined` поля удаляются. `null` должен оставаться `null`, если это фактическое значение источника.

## 2.4. Какие Polymarket API применялись upstream

Проектный scope указывает официальные Polymarket data families:

```text
events / markets / outcomes
price history
CLOB orderbook
trades
holders
open interest
```

Но текущий frozen handoff **не доказывает**:

```text
точные endpoint paths
polling cadence
rate-limit policy
raw response schemas
collector version
полную формулу преобразования raw API → Signal Score
```

Следовательно:

> Historical selector/replay можно восстановить из frozen dataset. Полный live data collector и score producer по этому документу восстановить нельзя. Для них нужен отдельный `UPSTREAM_DATA_AND_SCORE_CONTRACT`.

Нельзя придумывать API или score weights из UI, названий полей либо старых research notes.

---

# 3. Frozen dataset

## 3.1. Точные параметры

```text
Source table family:
generated_signal_pairs

Frozen rows:
49,400

Strict-dedup identities in earlier research layer:
1,850

Raw byte size:
110,875,797 bytes

Deterministic gzip size:
4,396,763 bytes

Raw SHA-256:
b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45

Gzip SHA-256:
153cd28fb98294dd6c3e8cdcb480d77c8b10790d1e04ee7bd856a39cfaaa6a85
```

Canonical package:

```text
modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/
```

Expected contents:

```text
deterministic gzip corpus
dataset manifest
partial export contract
observed inventory
identity set
execution sequence
source lineage
verification
manifest
```

## 3.2. Что означает byte-frozen

`BYTE_FROZEN_SNAPSHOT` означает:

1. Git хранит exact compressed bytes;
2. декомпрессия даёт exact original JSON bytes;
3. любое изменение даже одного пробела меняет SHA;
4. повторное исследование на другом dataset обязано получить новый version и hash;
5. нельзя «обновить» corpus под тем же именем.

## 3.3. Что не доказано

```text
exact historical CLI invocation
declared lower timestamp boundary
exact export-start upper cutoff
immutable revision of database
complete upstream API collector version
```

Observed minimum/maximum timestamps внутри файла не равны доказанным query boundaries.

Статус:

```text
Corpus authority:
BYTE_FROZEN_SNAPSHOT

Source re-export provenance:
PARTIAL
```

---

# 4. Что такое observation

Observation — это point-in-time запись о конкретном market token, созданная в определённый момент.

Минимальная логическая структура:

| Поле | Назначение | Fail-closed поведение |
|---|---|---|
| `id` | Уникальная observation identity | Отсутствует → строка непригодна |
| `condition_id` | Polymarket condition identity | Отсутствует → strict market identity невозможна |
| `token_id` | Выбранный outcome token | Отсутствует → entry/payout contract невозможен |
| `created_at` | Время snapshot | Невалидно → нельзя выбрать T−90 snapshot |
| `resolved_at` | Историческое время resolution/update | Невалидно → нельзя settlement replay |
| `event start` / derived start | Время начала события | Невалидно → T−90 и timing fail |
| `score` | Уже произведённый Signal Score | Невалидно/отсутствует → score filter fail |
| `coverage` | Secondary ranking evidence | Missing → fail или минимальное значение согласно accessor test |
| `entry_price_num` | Историческая цена outcome | Не finite или `p <= 0` или `p > 1` → fail |
| `result` | `win`, `loss`, допустимый void status | Неизвестный status → не считать как win |
| event identity fields | Объединение markets одного матча | Нет надёжного key → fail или approved historical derived key |
| `hours_until_start` | Timing eligibility | Missing/non-finite → fail |

---

# 5. Market Signal Score

```text
SCORE_CONTRACT_STATUS:
UPSTREAM_SCORE_PRODUCTION_NOT_FROZEN
```

Frozen selector не создаёт Market Signal Score. Он читает уже существующее значение через canonical accessor:

```text
getScoreValue(row)
```

Fallback-поля:

```text
row.score
row.signal_score
row.pre_event_score_num
```

Активная минимальная граница:

```text
score >= 65
```

Это означает:

```ts
function passesScore(row: Observation): boolean {
  const score = getScoreValue(row);
  return Number.isFinite(score) && score >= 65;
}
```

Нельзя восстановить score как среднее coverage, volume, price movement или UI trust metrics. Любая такая формула будет новым алгоритмом.

Для полного disaster recovery нужен отдельный документ:

```text
POLYPROPICKS_UPSTREAM_SCORE_PRODUCTION_CONTRACT_V1
```

Он должен содержать raw inputs, weights, clipping, missing-value behavior, versioning и parity fixtures.

---

# 6. Точная сигнальная модель

Canonical signal policy:

```text
B2_PRICE_FLOOR_030_TIMING_WITHIN_120M
```

Base classifier:

```text
ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS
```

Активные правила:

```text
score >= 65
eSports == false
entry price >= 0.30
0 <= hours_until_start < 2
latest snapshot at or before T−90
one representative market per physical event
```

`NBA_NHL_RE` существует в research source для других variants. Он не должен автоматически считаться частью B2, пока `canonical_model_contract.json` прямо этого не требует.

## 6.1. Полный порядок

```text
1. Load frozen rows.
2. Strict identity normalization.
3. Strict deduplication.
4. Determine event start.
5. decisionAt = eventStart - 90 minutes.
6. For each strict market identity, choose latest created_at <= decisionAt.
7. Read score and coverage through canonical accessors.
8. Require score >= 65.
9. Exclude eSports.
10. Require entryPrice >= 0.30.
11. Require 0 <= hoursUntilStart < 2.
12. Build physical sporting-event group key.
13. Group rows by physical event.
14. Rank rows inside each group.
15. Keep first row per event.
16. Freeze membership IDs.
17. Build committed execution sequence.
18. Replay without reselection.
```

## 6.2. Boundary table

| Stage | Exact rule | Pass | Fail |
|---|---|---:|---:|
| Score | `score >= 65` | `65` | `64.9999` |
| Price | `entryPrice >= 0.30` | `0.30` | `0.2999` |
| Timing lower | `hours >= 0` | `0` | `-0.0001` |
| Timing upper | `hours < 2` | `1.9999` | `2.0` |
| T−90 | `created_at <= eventStart-90m` | equal | one millisecond later |
| eSports | `isEsports(row) === false` | baseball | League of Legends |
| Result price | `0 < p <= 1` | `1` | `0`, `1.01`, NaN |

## 6.3. eSports exclusion

Source contracts:

```text
isEsports
ESPORTS_TOKEN_RE
```

Predicate должен проверять normalized text fields, а не только одно поле league. При неизвестной строке нельзя автоматически помечать её eSports; при явном eSports token строка исключается.

## 6.4. T−90

T−90 означает:

```text
decisionAt = eventStart - 90 minutes
```

Для одной strict market identity выбирается:

```text
maximum created_at
subject to created_at <= decisionAt
```

Поздний snapshot после decisionAt не имеет права вытеснить более ранний допустимый snapshot.

Псевдокод:

```ts
function selectT90Snapshot(rows: Observation[], eventStart: Date) {
  const decisionAt = eventStart.getTime() - 90 * 60 * 1000;

  return rows
    .filter(row => parseTime(row.created_at) <= decisionAt)
    .sort((a, b) =>
      parseTime(b.created_at) - parseTime(a.created_at) ||
      String(a.id).localeCompare(String(b.id))
    )[0] ?? null;
}
```

---

# 7. Strict identity, event identity и dedup

Нельзя смешивать:

```text
market identity
physical event identity
observation identity
```

## 7.1. Observation identity

```text
observationId = row.id
```

## 7.2. Strict market identity

Исторические контракты используют сочетание source identifiers. Минимальный безопасный ключ:

```text
condition_id + token_id
```

Если canonical source использует более полный strict key, нужно вызвать существующую функцию, а не переписывать её строкой.

## 7.3. Physical event identity

Source functions:

```text
buildEventGroupKey
historical derived match resolver
bankrollVaultReplay strong execution identity
```

Forward data должны предпочитать provider event ID.

Historical corpus не имел полного provider event key, поэтому был создан deterministic historical derived identity. Confidence такого key не следует выдавать за provider-level certainty.

Fail-closed правило:

```text
если approved event key не удаётся построить,
row не должна молча получить group key из произвольного title substring
```

---

# 8. Ranking одного события

Source constant:

```text
RANK_ORDER
```

Порядок:

```text
1. Signal Score descending.
2. Coverage descending.
3. Entry price ascending.
4. Snapshot created_at descending.
5. Observation ID ascending.
```

Comparator:

```ts
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    numeric(b.score) - numeric(a.score) ||
    numeric(b.coverage) - numeric(a.coverage) ||
    numeric(a.entryPrice) - numeric(b.entryPrice) ||
    parseTime(b.createdAt) - parseTime(a.createdAt) ||
    a.observationId.localeCompare(b.observationId)
  );
}
```

Зачем:

| Tie-break | Причина |
|---|---|
| Higher score | Основной frozen eligibility/ranking signal |
| Higher coverage | Предпочтение более полно подтверждённой observation |
| Lower price | При прочих равных выше payout upside |
| Newer eligible snapshot | Ближайшее допустимое состояние к decision point |
| ID ascending | Полностью детерминированный финальный tie |

После ranking:

```ts
const selected = [...eventGroup].sort(compareCandidates)[0];
```

Нельзя сохранять несколько markets одного события только потому, что они разные по token.

---

# 9. End-to-end selector pseudocode

```ts
export function selectCanonicalSignals(rows: RawRow[]): SelectedSignal[] {
  const normalized = rows
    .map(normalizeObservation)
    .filter(hasStrictIdentity);

  const strictGroups = groupBy(normalized, buildStrictMarketKey);

  const t90Rows: Observation[] = [];

  for (const marketRows of strictGroups.values()) {
    const eventStart = resolveEventStart(marketRows);

    if (!eventStart) continue;

    const snapshot = selectT90Snapshot(marketRows, eventStart);

    if (!snapshot) continue;

    t90Rows.push(snapshot);
  }

  const eligible = t90Rows.filter(row => {
    const score = getScoreValue(row);
    const coverage = getCoverageValue(row);
    const price = getEntryPrice(row);
    const hours = getHoursUntilStart(row);

    if (!Number.isFinite(score) || score < 65) return false;
    if (isEsports(row)) return false;
    if (!Number.isFinite(price) || price < 0.30 || price > 1) return false;
    if (!Number.isFinite(hours) || hours < 0 || hours >= 2) return false;

    // Coverage is used by ranking.
    // Exact missing behavior must match getCoverageValue tests.
    void coverage;

    return true;
  });

  const eventGroups = groupBy(eligible, buildEventGroupKey);

  const selected: SelectedSignal[] = [];

  for (const [eventKey, group] of eventGroups) {
    if (!eventKey) continue;

    const winner = [...group].sort(compareCandidates)[0];

    if (winner) selected.push(winner);
  }

  return buildCommittedExecutionSequence(selected);
}
```

Этот pseudocode не должен заменять canonical source functions. Его цель — описать композицию.

---

# 10. Frozen membership и execution sequence

Original full-history frozen membership:

```text
231 observations

Identity-set SHA-256:
99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca

Execution-sequence SHA-256:
5457240a539e5db189c1b23659678f157b322928105909a5812ce318a9d6b036
```

## 10.1. Membership hash

Membership отвечает:

```text
Какие observation входят в cohort?
```

Для hash IDs сортируются лексикографически только для стабильного membership representation.

## 10.2. Execution sequence

Execution sequence отвечает:

```text
В каком порядке исторический engine обрабатывает решения?
```

> Никогда не сортировать observation IDs лексикографически для replay.

При одинаковых timestamps сохраняется committed tie order.

## 10.3. Current post-June primary subset

После temporal/data-trust audit primary canonical evaluation ограничен:

```text
decisionAt >= 2026-06-09 00:00:00 Europe/Minsk
```

Primary subset:

```text
124 ordered decisions
61 wins
63 losses
```

Sensitivity:

```text
decisionAt >= 2026-06-08 00:00:00 Europe/Minsk
126 decisions
```

Оригинальные 231 решения не удалены. Ранние решения quarantined и не определяют primary review verdict.

---

# 11. Historical payout formula

Пусть:

```text
stake = S
entry probability price = p
0 < p <= 1
```

Купленные shares:

```text
shares = S / p
```

Если выбранный outcome победил:

```text
gross return = shares
net PnL = shares - stake
net PnL = S × (1/p - 1)
```

Если проиграл:

```text
net PnL = -S
```

Void/unresolved:

```text
не считать как win
применить canonical terminal outcome contract
```

TypeScript:

```ts
function realizedPnl(stake: number, price: number, result: Result): number {
  if (!Number.isFinite(stake) || stake <= 0) throw new Error("INVALID_STAKE");
  if (!Number.isFinite(price) || price <= 0 || price > 1) {
    throw new Error("INVALID_ENTRY_PRICE");
  }

  if (result === "win") return stake * (1 / price - 1);
  if (result === "loss") return -stake;
  if (result === "void") return 0;

  throw new Error("UNSUPPORTED_RESULT");
}
```

Historical formula не включает:

```text
venue fee
slippage
partial fill
latency
failed order
price movement between decision and fill
```

---

# 12. Chronological replay

## 12.1. State

```ts
interface CapitalState {
  freeActive: number;
  openPrincipal: number;
  active: number;
  vault: number;
  total: number;

  totalHighWaterMark: number;
  activeHighWaterMark: number;
  peakProfit: number;

  openPositions: number;
  cycleActiveReference: number;
  cycleTransferRemaining: number;
}
```

Relationships:

```text
Active = free Active + open principal
Total = Active + Vault
Peak profit = max(0, Total high-water mark - initial bank)
```

## 12.2. Entry

При entry:

```text
freeActive -= stake
openPrincipal += stake
openPositions += 1
Active не меняется
Total не меняется
```

Открытие позиции переводит деньги из free Active в open principal, но не создаёт PnL.

## 12.3. Settlement

При settlement:

```text
openPrincipal -= original stake
freeActive += original stake + realized PnL
openPositions -= 1
Active = freeActive + openPrincipal
Total = Active + Vault
```

## 12.4. Same-timestamp batch

Settlement contract:

```text
SETTLE_SAME_TIMESTAMP_BATCH_THEN_POLICY_THEN_ENTRY_BATCH_V1
```

Порядок:

```text
1. собрать все settlements с одним timestamp;
2. применить их как один batch;
3. обновить capital state;
4. обновить high-water marks;
5. применить Vault policy;
6. затем рассмотреть entries данного timestamp в committed rank order.
```

Нельзя:

```text
settle row 1
→ открыть entry
→ settle row 2 с тем же timestamp
```

Это создаёт искусственную зависимость от строкового порядка.

---

# 13. Capacity и exposure

Frozen operating contract:

```text
initial bank: 50u
1u = $100
operation: 24×7
maximum concurrent positions: 36
maximum approved Active exposure: 100%
```

Проверки entry:

```ts
function canOpen(
  state: CapitalState,
  stake: number,
  riskBudget: number
): { ok: boolean; reason?: string } {
  if (state.openPositions >= 36) {
    return { ok: false, reason: "POSITION_LIMIT" };
  }

  if (state.freeActive < stake) {
    return { ok: false, reason: "INSUFFICIENT_FREE_ACTIVE" };
  }

  if (state.openPrincipal + stake > state.active) {
    return { ok: false, reason: "EXPOSURE_LIMIT" };
  }

  if (state.openPrincipal + stake > riskBudget) {
    return { ok: false, reason: "VAULT_RISK_BUDGET" };
  }

  return { ok: true };
}
```

Точная комбинация reasons должна совпадать с source enums. Нельзя переименовывать причины, если ledger hash зависит от текста.

---

# 14. Fixed Safe profile

```text
Profile ID:
FIXED_SAFE_V1

Stake policy:
FIXED_1U

Stake:
1u per accepted signal

Vault family:
ONE_WAY_RATCHETED_CPPI

Vault policy:
CPPI_0.4_0.5

alpha:
0.4

multiplier:
0.5
```

Constant Proportion Portfolio Insurance (CPPI) — политика, в которой часть капитала защищается floor, а риск ограничивается cushion.

## 14.1. Exact capital formulas

После settled batch:

```text
TotalHWM = max(previous TotalHWM, Total)

TargetVault = 0.4 × TotalHWM

TransferNeed = max(0, TargetVault - Vault)

Transfer = min(
  TransferNeed,
  freeActive
)

freeActive -= Transfer
Vault += Transfer
Active = freeActive + openPrincipal
Total = Active + Vault
```

Проверка формулы на frozen terminal evidence:

```text
Final Total:
101.89997402u

0.4 × Final Total:
40.759989608u

Recorded ending Vault:
40.75998961u
```

Совпадение подтверждает ratcheted 40% target.

Risk budget:

```text
Cushion = max(0, Total - Vault)
RiskBudget = 0.5 × Cushion
```

Entry разрешён только если:

```text
openPrincipal + 1u <= RiskBudget
freeActive >= 1u
openPositions < 36
exposure <= approved ceiling
```

Vault one-way:

```text
Active → Vault allowed
Vault → Active forbidden
```

## 14.2. Numeric example

**ILLUSTRATIVE FIXED SAFE EXAMPLE — NOT A HISTORICAL EVENT**

До policy:

```text
freeActive = 37u
openPrincipal = 3u
Active = 40u
Vault = 20u
Total = 60u
TotalHWM before = 58u
```

Обновление:

```text
TotalHWM = max(58, 60) = 60u
TargetVault = 0.4 × 60 = 24u
TransferNeed = 24 - 20 = 4u
Transfer = min(4, 37) = 4u
```

После transfer:

```text
freeActive = 33u
openPrincipal = 3u
Active = 36u
Vault = 24u
Total = 60u
```

Risk:

```text
Cushion = 60 - 24 = 36u
RiskBudget = 0.5 × 36 = 18u
```

Если `openPrincipal=3`, следующая fixed stake `1u` допускается по risk budget, потому что `4 <= 18`.

---

# 15. Dynamic Protected Growth profile

```text
Profile ID:
DYNAMIC_PROTECTED_GROWTH_V1

Stake policy:
DYNAMIC_ACTIVE_3PCT

Vault family:
DYNAMIC_PRINCIPAL_RECOVERY_VAULT_V2

Vault policy:
PRV2_T25_P50_R1_S0.05_C0.1
```

Parameters:

```text
profit trigger T = 25u
principal target P = 50u
principal recovery rate R = 1.0
post-recovery skim S = 0.05
transfer cap C = 0.10 of Minsk-cycle Active reference
```

## 15.1. Cycle reference and stake

На начале Minsk operating cycle:

```text
cycleActiveReference = Active
cycleTransferCap = 0.10 × cycleActiveReference
cycleTransferRemaining = cycleTransferCap
```

Для всех entries внутри цикла:

```text
stake = 0.03 × cycleActiveReference
```

Открытие позиций уменьшает `freeActive`, но не меняет captured reference внутри текущего цикла.

Псевдокод:

```ts
function dynamicStake(state: CapitalState): number {
  return 0.03 * state.cycleActiveReference;
}
```

Не вводить округление до cents/integers, пока source tests не требуют его.

## 15.2. Principal recovery Vault formula

После settlement и high-water update:

```text
PeakProfit = max(0, TotalHWM - InitialBank)
```

Прибыль сверх trigger:

```text
TriggeredProfit = max(0, PeakProfit - 25)
```

Principal recovery target:

```text
RecoveredPrincipalTarget =
min(
  50,
  1.0 × TriggeredProfit
)
```

Profit threshold for full recovery:

```text
25 + 50 / 1.0 = 75u peak profit
```

Post-recovery profit:

```text
PostRecoveryProfit = max(0, PeakProfit - 75)
```

Vault target:

```text
TargetVault =
RecoveredPrincipalTarget
+ 0.05 × PostRecoveryProfit
```

Needed transfer:

```text
TransferNeed = max(0, TargetVault - Vault)
```

Actual transfer:

```text
Transfer = min(
  TransferNeed,
  cycleTransferRemaining,
  freeActive
)
```

State update:

```text
freeActive -= Transfer
Vault += Transfer
cycleTransferRemaining -= Transfer
```

Vault never refills Active.

## 15.3. Frozen terminal parity

Full historical state-carrying evidence:

```text
Peak/final PnL:
121.85057149u

TriggeredProfit:
121.85057149 - 25
= 96.85057149u

RecoveredPrincipalTarget:
min(50, 96.85057149)
= 50u

PostRecoveryProfit:
121.85057149 - 75
= 46.85057149u

5% skim:
2.3425285745u

TargetVault:
50 + 2.3425285745
= 52.3425285745u
```

Recorded:

```text
Ending Vault:
52.34252857u
```

Formula reconciles to frozen evidence.

## 15.4. Numeric cycle example

**ILLUSTRATIVE DYNAMIC PROTECTED EXAMPLE — NOT A HISTORICAL EVENT**

Start of Minsk cycle:

```text
Active = 80u
Vault = 20u
Total = 100u
cycleActiveReference = 80u
```

Stake:

```text
3% × 80 = 2.4u
```

Cycle transfer cap:

```text
10% × 80 = 8u
```

Assume after settlements:

```text
TotalHWM = 120u
InitialBank = 50u
PeakProfit = 70u
```

Then:

```text
TriggeredProfit = 70 - 25 = 45u
RecoveredPrincipalTarget = min(50, 45) = 45u
PostRecoveryProfit = 0
TargetVault = 45u
```

Current Vault `20u`, so:

```text
TransferNeed = 25u
Transfer = min(25, 8, freeActive)
```

Если `freeActive=50`, actual transfer:

```text
8u
```

После transfer:

```text
freeActive = 42u
Vault = 28u
cycleTransferRemaining = 0u
Total unchanged
```

Оставшиеся `17u` target gap переносятся на будущие eligible settlement cycles.

---

# 16. Post-June canonical evidence

## 16.1. Почему ранняя история quarantined

Settlement-time 29 May–7 June дал значительную часть full-history PnL.

Attribution repair:

```text
Sport:
230 LOW / 1 UNRESOLVED

League:
230 LOW / 1 UNRESOLVED

Market family:
231 LOW

HIGH/MEDIUM trusted coverage:
0
```

Поэтому early labels `Baseball / MLB / Moneyline` являются diagnostic title parsing, а не trusted provider metadata.

Canonical decision:

```text
pre-8-June evidence:
preserved and quarantined

primary:
decisionAt >= 2026-06-09 00:00 Europe/Minsk
```

## 16.2. Fixed 1u signal control

```text
Decisions:
124

Wins/Losses:
61 / 63

Stake:
124u

Gross PnL:
+16.82674451u

Gross ROI:
13.56995525%

Max drawdown:
5.86500797u

Longest loss streak:
4
```

Cost sensitivity:

| All-in cost | Net PnL |
|---:|---:|
| 0 bps | `+16.82674451u` |
| 25 bps | `+16.51674451u` |
| 50 bps | `+16.20674451u` |
| 100 bps | `+15.58674451u` |
| 200 bps | `+14.34674451u` |

Generic cost formula:

```text
costU = stakeU × bps / 10,000
netAfterCost = grossPnl - costU
```

## 16.3. Fixed Safe fresh-state replay

```text
executed: 49
skipped: 75
ending Active: 25.42422762u
ending Vault: 20.22407047u
ending Total: 45.64829809u
PnL: -4.35170191u
max fall: 7.86222187u
CVaR95: 13.46347823u
```

Вывод: CPPI/Vault policy отфильтровала слишком много selected signals и испортила положительный fixed‑1u selector result.

## 16.4. Dynamic Protected fresh-state replay

```text
executed: 123
skipped: 1
ending Active: 75u
ending Vault: 7.11107514u
ending Total: 82.11107514u
PnL: +32.11107514u
max fall: 11.46632001u
max concurrency: 33
```

Эта policy положительна исторически, но не production-approved.

---

# 17. Worked example contract

Canonical worked-example observation:

```text
6776a92e-0298-43d2-99fe-00ced5b2d64d
```

Exact values должны читаться из:

```text
modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/
post_june9_primary_rows.json

fixed_safe_post_june_ledger.json
dynamic_protected_post_june_ledger.json
```

Не вставлять значения вручную из памяти.

Минимальный extraction script:

```ts
import { readFileSync } from "node:fs";

const id = "6776a92e-0298-43d2-99fe-00ced5b2d64d";

const rows = JSON.parse(
  readFileSync(
    "modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/post_june9_primary_rows.json",
    "utf8"
  )
);

const fixed = JSON.parse(
  readFileSync(
    "modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/fixed_safe_post_june_ledger.json",
    "utf8"
  )
);

const dynamic = JSON.parse(
  readFileSync(
    "modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/dynamic_protected_post_june_ledger.json",
    "utf8"
  )
);

const sourceRow = rows.find((row: any) => row.observationId === id);
const fixedRow = fixed.find((row: any) => row.observationId === id);
const dynamicRow = dynamic.find((row: any) => row.observationId === id);

if (!sourceRow || !fixedRow || !dynamicRow) {
  throw new Error("WORKED_EXAMPLE_LINEAGE_MISSING");
}

console.log({
  sourceRow,
  fixedRow,
  dynamicRow,
});
```

Проверки:

```text
sourceRow belongs to 124-ID primary subset
source execution index matches committed subset sequence
score >= 65
entry price >= 0.30
0 <= hours_until_start < 2
isEsports == false
result and price reproduce fixed-1u PnL
Fixed action matches Fixed Safe ledger
Dynamic action matches Dynamic ledger
```

Путь события через систему:

```text
frozen dataset row
→ strict identity
→ T−90 snapshot
→ score check
→ eSports check
→ price check
→ timing check
→ physical-event group
→ ranking
→ selected ID
→ post-June subset
→ committed sequence
→ profile-specific action
→ settlement batch
→ capital update
```

---

# 18. Source-code reconstruction map

| Contract | Primary source |
|---|---|
| Supabase exporter | `scripts/modeling/export-generated-signal-pairs-from-supabase.ts` |
| Base selector | `lib/modeling/historicalFunnelVariants.ts` |
| Selector export | `evaluateHistoricalFunnelVariant` |
| Score accessor | `getScoreValue` |
| Coverage accessor | `getCoverageValue` |
| Price filter | `passesPriceFloor` |
| Timing filter | `passesTimingWithin120m` |
| eSports filter | `isEsports`, `ESPORTS_TOKEN_RE` |
| Event grouping | `buildEventGroupKey` |
| Event representative | `selectFirstPerEventGroup` |
| Ranking | `RANK_ORDER` |
| Chronological execution | `lib/modeling/bankrollVaultReplay.ts` |
| Capital replay | `lib/modeling/scientificCapitalArchitecture.ts` |
| Fixed profile lock | `LOCKED_CPPI_04_05` |
| Dynamic state carry | `lib/modeling/dynamicVaultStateCarrying.ts` |
| Profile registry | `lib/modeling/bankrollProfileRegistry.ts` |
| Post-June freeze | `lib/modeling/postJuneCanonicalFreeze.ts` |
| Post-June generator | `scripts/modeling/strategies/freeze-post-june-canonical-baseline.ts` |

Evidence packages:

```text
modeling/canonical/model-handoff-v1/
modeling/evidence/2026-07-17-suspicious-growth-temporal-audit-v1/
modeling/evidence/2026-07-17-suspicious-growth-attribution-repair-v1/
modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/
modeling/review/2026-07-17-post-june-canonical-review-v1/
```

---

# 19. Tests required for a clean-room rebuild

## 19.1. Selector boundaries

```text
score: 64.9999 fail; 65 pass
price: 0.2999 fail; 0.30 pass
timing: -1 minute fail
timing: 0 pass
timing: 119.999 minutes pass
timing: 120 minutes fail
snapshot after T−90 fail
eSports token fail
missing score fail
invalid price fail
```

## 19.2. Ranking

Create five candidates differing only by one tie-break. Assert exact winning ID.

## 19.3. Identity

```text
same condition/token snapshots → one strict market timeline
different token → different strict identity
same physical match markets → one event group
missing approved event identity → fail closed
```

## 19.4. Payout

```text
S=1, p=0.50, win → +1u
S=1, p=0.40, win → +1.5u
S=1, loss → -1u
p=0 or p>1 → error
```

## 19.5. Settlement batching

Two settlements at one timestamp must produce same final state regardless of input array order, as long as committed tie semantics are preserved.

## 19.6. Fixed CPPI parity

```text
TargetVault = 0.4 × TotalHWM
RiskBudget = 0.5 × (Total - Vault)
Vault never decreases
Final full-history Vault = 40.75998961u
```

## 19.7. Dynamic parity

```text
stake = 3% × cycle Active reference
cycle cap = 10% × cycle Active reference
trigger = 25u
principal target = 50u
recovery rate = 1
skim = 5%
full-history Vault = 52.34252857u
```

## 19.8. Post-June acceptance

```text
primary count = 124
W/L = 61/63
fixed-1u PnL = 16.82674451u
Fixed Safe Total = 45.64829809u
Dynamic Total = 82.11107514u
```

---

# 20. Git and hash anchors

```text
Dataset SHA:
b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45

Registry SHA:
5ead4f1079920aa61488ce34c17efee1736524f9dd5a95c747f2dcb487d1bf34

Original 231 membership SHA:
99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca

Original execution sequence SHA:
5457240a539e5db189c1b23659678f157b322928105909a5812ce318a9d6b036
```

Relevant lineage:

```text
bankroll profiles atomic freeze:
4889c1c2f67038dcd0cf912df381351284104a2f

dataset freeze:
727e6b7c2c84a39b56f343a7322c89148300deae

canonical handoff:
65256a885aee21663a782a67b0195189aa9be94e

temporal audit:
ccc46d1
1fe6a81
08760be

attribution repair:
401a142
2061356

post-June freeze:
cc2a1ec
e878e0e

walkthrough/review bundle:
ce122b0
9e95ed9
```

---

# 21. Clean-room rebuild order

После взлома или потери проекта:

```text
1. Restore repository at reviewed commit.
2. Verify mandatory instruction files.
3. Verify dataset gzip hash.
4. Decompress and verify raw dataset hash.
5. Run dataset schema/profile validation.
6. Rebuild strict identity timelines.
7. Rebuild T−90 snapshots.
8. Run selector boundary tests.
9. Rebuild event groups and ranking.
10. Verify membership hash.
11. Verify execution-sequence hash.
12. Run fixed-1u payout replay.
13. Verify post-June 124-row anchors.
14. Run Fixed Safe.
15. Run Dynamic Protected.
16. Verify ledgers and capital-curve hashes.
17. Run TypeScript and build.
18. Run independent review before any runtime integration.
```

Нельзя начинать с UI, API route или production queue.

---

# 22. Что downstream contour обязан сохранить

Обязан:

```text
verify all frozen hashes
use explicit profile ID
reuse canonical accessor/filter functions
preserve T−90 semantics
preserve event grouping and ranking
preserve membership and committed execution order
preserve settlement batching
preserve payout formula
preserve stake/Vault pairing
fail closed on missing identity or invalid price
```

Запрещено:

```text
invent score formula
change score threshold
change price floor
make upper timing boundary inclusive
remove eSports exclusion
replace event key with title substring
keep multiple markets per event
sort IDs lexicographically for replay
apply Dynamic stake without Dynamic Vault
apply Fixed stake with Dynamic Vault
refill Active from Vault
use pre-June quarantined rows as primary evidence
claim historical replay as live performance
```

---

# 23. Нерешённые recovery gaps

## 23.1. Score production

Нужен отдельный frozen contract. Пока его нет, clean-room system может только потреблять stored score.

## 23.2. Upstream Polymarket collector

Нужны:

```text
exact endpoints
request parameters
authentication mode
poll schedule
dedup semantics
raw payload fixtures
source version
failure/retry logic
```

## 23.3. Trusted sports metadata

Historical title parsing имеет LOW confidence. Для нового forward dataset должны храниться provider-backed:

```text
sport
league
competition
provider event ID
market type
market family
```

## 23.4. Real execution

Перед production нужны:

```text
fee contract
slippage model
fill model
latency
order rejection
partial fill
idempotency
position reconciliation
```

---

# 24. Owner acceptance checklist

Owner должен суметь ответить «да» на каждый вопрос:

1. Я понимаю, что score formula не заморожена.
2. Я понимаю, что historical replay читает frozen dataset, а не live API.
3. Я вижу точные score/price/timing boundaries.
4. Я понимаю T−90 и почему поздний snapshot запрещён.
5. Я понимаю ranking одного события.
6. Я понимаю разницу membership и execution order.
7. Я могу вручную посчитать payout по price.
8. Я могу вручную посчитать Fixed Vault target.
9. Я могу вручную посчитать Dynamic principal-recovery target.
10. Я понимаю, почему Fixed Safe может проиграть на положительном selector.
11. Я понимаю, почему pre‑June history quarantined.
12. Я знаю, какие hashes нужно проверить.
13. Я знаю, какие исходные функции нельзя переписывать из prose.
14. Я понимаю, что current baseline не production approval.
15. Я понимаю, что independent review обязателен.

---

# 25. Итог

Текущий восстанавливаемый алгоритм — это не одна «магическая формула». Это композиция:

```text
stored upstream score
+ exact point-in-time selector
+ price/timing filters
+ deterministic event ranking
+ frozen execution sequence
+ binary-market payout
+ profile-specific stake
+ profile-specific Vault
+ chronological settlement state machine
```

Главная формула selector:

```text
score >= 65
AND not eSports
AND entryPrice >= 0.30
AND 0 <= hoursUntilStart < 2
AND snapshot.createdAt <= eventStart - 90 minutes
```

После этого выбирается один market на event по:

```text
score DESC
coverage DESC
price ASC
createdAt DESC
observationId ASC
```

Основная payout formula:

```text
win PnL = stake × (1/price - 1)
loss PnL = -stake
```

Fixed Safe:

```text
stake = 1u
TargetVault = 0.4 × TotalHWM
RiskBudget = 0.5 × (Total - Vault)
```

Dynamic Protected:

```text
stake = 0.03 × Minsk-cycle Active reference

TriggeredProfit = max(0, PeakProfit - 25)
PrincipalTarget = min(50, TriggeredProfit)
PostRecoveryProfit = max(0, PeakProfit - 75)
TargetVault = PrincipalTarget + 0.05 × PostRecoveryProfit

per-cycle transfer cap =
0.10 × cycle Active reference
```

Current primary historical review scope:

```text
124 decisions
decisionAt >= 9 June 2026 Minsk
fixed-1u PnL +16.82674451u
Fixed Safe PnL -4.35170191u
Dynamic Protected PnL +32.11107514u
```

Это полный owner-level reconstruction contract для selector и historical capital replay. Для полного восстановления live product всё ещё нужны отдельные upstream score/API и execution contracts.
