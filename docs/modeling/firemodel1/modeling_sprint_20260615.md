# FireModel1 Modeling Sprint — 2026-06-15

## 1. Что построено

| Скрипт | Фаза | Назначение |
|---|---|---|
| `scripts/firemodel1-model-report.ts` | Phase 1 | Data contract check: покрытие полей, эры, предупреждения |
| `scripts/firemodel1-model-stack-compare.ts` | Phase 2 | Сравнение 3 моделей на идентичных данных |
| `scripts/firemodel1-weight-lab.ts` | Phase 3 | Shadow-тест 7 вариантов весовых формул |
| `scripts/firemodel1-stake-lab.ts` | Phase 4 | Симуляция 7 стейк-политик + Kelly proxy |
| `scripts/firemodel1-cohort-lab.ts` | Phase 5 | Когортный анализ: спорт/рынок/цена/покрытие/таймин |
| `scripts/firemodel1-decision-board.ts` | Phase 6 | CEO-борд: вердикт по 3 моделям, next actions |
| `lib/executor/modelingData.ts` | Shared | Общие хелперы (read-only, no writes, no live) |

## 2. Как запускать

```bash
# Отдельные лабы
npm run firemodel1:report       # Phase 1: data readiness
npm run firemodel1:stack        # Phase 2: 3-model comparison
npm run firemodel1:weights      # Phase 3: weight formulas
npm run firemodel1:stake        # Phase 4: stake policies
npm run firemodel1:cohorts      # Phase 5: cohort analysis
npm run firemodel1:decision     # Phase 6: decision board

# Существующие
npm run firemodel1:checkpoint
npm run firemodel1:roi
npm run firemodel1:funnel
npm run firemodel1:live-readiness

# Все моделирующие скрипты последовательно
npm run firemodel1:all-modeling
```

Env требования: `SUPABASE_SERVICE_ROLE_KEY` + `NEXT_PUBLIC_SUPABASE_URL` в `.env.local`.  
Если env отсутствует — скрипты компилируются (`npm run build` PASS), но runtime выдаст DB error.

## 3. Что отвечает каждый скрипт

**firemodel1:report**
- Counts по версиям (v2-lite / shadow-fm1.1 / shadow-strategic / other)
- Покрытие критических полей (token_id, entry_price, gameStartIso, signal_result, realized_return_pct)
- Эры: до/после патча 0f637c0, last 7d/48h/24h
- Предупреждения: нет resolved rows → ROI_NOT_AVAILABLE

**firemodel1:stack**
- Модель A (PRIMARY_SM_GUARD), B1 (FLAT10_NO_GUARD), B2 (FLAT10_SM_GUARD), C (DEDUP_1_PER_EVENT), D (BASELINE)
- Окна: 24h / 48h / 96h / 7d / all-available
- Метрики: N, resolved, WR, ROI, PnL, stake, maxLossRun
- Cost stress: +0/1/2/4/8 cent slippage
- Holdout: `HOLDOUT_NOT_ENOUGH_N` если resolved < 100

**firemodel1:weights**
- 7 формул: F0_CURRENT → F6_COMPOSITE
- Anti-overfit gates: N, supply/day, adds/removes vs current
- Вывод: `NO_CHANGE` / `SHADOW_ONLY` / `READY_FOR_SMALL_PATCH`

**firemodel1:stake**
- 7 политик стейка: CURRENT / FLAT5 / FLAT10 / BOUNDED_VARIABLE / PROXY_KELLY / DRAWDOWN_PROTECT / AGGRESSIVE_RECOVERY
- Bankroll simulation ($300 start, $220 hard exposure)
- Verdict: best for $300 / best PnL / safest / next controlled live

**firemodel1:cohorts**
- Когорты: WC2026 / eSports / NBA-NHL / other
- Market family: spread / totals / BTTS / moneyline
- Price buckets: <0.25 / 0.25-0.44 / 0.44-0.58 / 0.58-0.75 / >0.75
- Coverage: <25 / 25-49 / 50-74 / >=75
- Timing: live / 0-1h / 1-2h / 2-3h / 3-6h / 6-24h / >24h
- Action labels: BOOST / KEEP / REDUCE / SKIP / NEED_MORE_DATA

**firemodel1:decision**
- Вердикт по 3 моделям: LOCK / KEEP / SHADOW / REJECT / NEED_DATA
- Рекомендованная production политика
- Shadow candidates + what not to do
- Next 5 actions

## 4. Текущие известные факты

| Факт | Статус |
|---|---|
| FireModel1 (ALT_SM_GUARD_ON_PRIMARY) | LOCKED — текущий лучший кандидат |
| DB candidate pool | Существует (v2-lite + shadow-fm1.1) |
| token_id / gameStartIso pass | Подтверждено патчем 0f637c0 |
| Ireland live executor | PAUSED — не часть этого спринта |
| Polymarket CLOB / wallet | НЕ трогаем |
| API endpoint /executor/candidates | Существует, modeling не трогает |
| realized_return_pct | Вероятно NULL — живых ордеров ещё не было |

## 5. Как принимать решение завтра

```
1. npm run firemodel1:report        → проверить data readiness
2. npm run firemodel1:stack         → сравнить 3 модели на свежих данных
3. npm run firemodel1:decision      → прочитать вердикт
4. Выбрать 1–3 кандидата           → из списка live-readiness
5. npm run firemodel1:live-readiness → подтвердить readiness gate
6. Контролируемая live-сессия      → только после готовности внешнего executor
```

Не менять production политику пока resolved < 20 строк.  
Не запускать Flat $10 на банке $300 пока resolved < 50 строк.  
ROI из моделирования — shadow оценка; реальный ROI появится только после live ордеров.

## 6. Policy constants (locked)

```
active_bank         = $300
target_exposure     = $160
hard_exposure       = $220
max_order_usd       = $10
esports_max_stake   = $5
smart_money_guard   = sm>=75 → half stake (not boost)
bad_bucket          = cov 50–74 AND price 0.44–0.58 → skip
entry_price_policy  = entry_price_num + 0.04, cap 0.99
```
