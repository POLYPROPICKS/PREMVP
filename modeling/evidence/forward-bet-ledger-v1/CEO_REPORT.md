## Десять исследовательских дорожек
| Стратегия | Independent games | BET | WIN–LOSS–VOID–UNKNOWN | Timing proof | Price proof | Gross/Fees/Net ROI | Confidence | Verdict |
|---|---|---|---|---|---|---|---|---|
| Прематч · Цена 50–52¢ (`P50_52_SAFE`) | 0 | 0 | 0–0–0–0 | авторитетно до старта: 0; до СТАРТА ПО РАСПИСАНИЮ (факт старта не подтверждён): 0; поздно/повтор: 0; без доказательства: 630 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (verified settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Прематч · Широкий портфель (`PORTFOLIO_BROAD_SAFE`) | 0 | 0 | 0–0–0–0 | авторитетно до старта: 0; до СТАРТА ПО РАСПИСАНИЮ (факт старта не подтверждён): 0; поздно/повтор: 0; без доказательства: 630 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (verified settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Прематч · Сбалансированный (`QUALITY_FILL_A_SAFE`) | 0 | 0 | 0–0–0–0 | авторитетно до старта: 0; до СТАРТА ПО РАСПИСАНИЮ (факт старта не подтверждён): 0; поздно/повтор: 0; без доказательства: 630 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (verified settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Прематч · Футбольный расширенный (`QUALITY_FILL_D_SAFE`) | 0 | 0 | 0–0–0–0 | авторитетно до старта: 0; до СТАРТА ПО РАСПИСАНИЮ (факт старта не подтверждён): 0; поздно/повтор: 0; без доказательства: 630 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (verified settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Прематч · Теннис 50–52¢ (`TENNIS_P50_52_SAFE`) | 0 | 0 | 0–0–0–0 | авторитетно до старта: 0; до СТАРТА ПО РАСПИСАНИЮ (факт старта не подтверждён): 0; поздно/повтор: 0; без доказательства: 341 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (verified settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Лайв · Контроль 48–52¢ (`CONTROL_PRICE_BUCKET_A`) | 51 | 51 | UNPROVEN (результат не сохраняется в Ledger) | DELAYED_PAPER: 51; LIVE_PROSPECTIVE: 0; TIMING_UNPROVEN: 0 | исполнимый BUY VWAP полного стейка: 51/51 | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (games n=51) | DELAYED_PAPER_ONLY_NOT_FORWARD_EVIDENCE |
| Лайв · Контроль 53–58¢ (`CONTROL_PRICE_BUCKET_B`) | 53 | 53 | UNPROVEN (результат не сохраняется в Ledger) | DELAYED_PAPER: 53; LIVE_PROSPECTIVE: 0; TIMING_UNPROVEN: 0 | исполнимый BUY VWAP полного стейка: 53/53 | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (games n=53) | DELAYED_PAPER_ONLY_NOT_FORWARD_EVIDENCE |
| Лайв · Контроль 35–44¢ (`CONTROL_PRICE_BUCKET_C`) | 104 | 104 | UNPROVEN (результат не сохраняется в Ledger) | DELAYED_PAPER: 104; LIVE_PROSPECTIVE: 0; TIMING_UNPROVEN: 0 | исполнимый BUY VWAP полного стейка: 104/104 | UNPROVEN/UNPROVEN/UNPROVEN | SUFFICIENT_FOR_COMPARISON | DELAYED_PAPER_ONLY_NOT_FORWARD_EVIDENCE |
| Alpha 1 · Недооценённые исходы (`VALUE_BACKED_TAIL_REPRICING`) | 0 | 0 | n/a | n/a (facts-only) | n/a (facts-only) | UNPROVEN/UNPROVEN/UNPROVEN | n/a | FACTS_ONLY_NO_BET |
| Alpha 2 · Арбитраж связанных рынков (`STATEWISE_PAYOFF_ARBITRAGE`) | 0 | 0 | n/a | n/a (facts-only) | n/a (facts-only) | UNPROVEN/UNPROVEN/UNPROVEN | n/a | FACTS_ONLY_NO_BET |

## Режимы дорожек (из реестров стратегий, названия — только отображение)
| Название | Canonical ID | Группа | Режим | canEmitBet |
|---|---|---|---|---|
| Прематч · Цена 50–52¢ | `P50_52_SAFE` | PREMATCH | PREMATCH_FORWARD_BET_ENGINE | true |
| Прематч · Широкий портфель | `PORTFOLIO_BROAD_SAFE` | PREMATCH | PREMATCH_FORWARD_BET_ENGINE | true |
| Прематч · Сбалансированный | `QUALITY_FILL_A_SAFE` | PREMATCH | PREMATCH_FORWARD_BET_ENGINE | true |
| Прематч · Футбольный расширенный | `QUALITY_FILL_D_SAFE` | PREMATCH | PREMATCH_FORWARD_BET_ENGINE | true |
| Прематч · Теннис 50–52¢ | `TENNIS_P50_52_SAFE` | PREMATCH | PREMATCH_FORWARD_BET_ENGINE | true |
| Лайв · Контроль 48–52¢ | `CONTROL_PRICE_BUCKET_A` | LIVE_CONTROL | LIVE_DELAYED_PAPER | true |
| Лайв · Контроль 53–58¢ | `CONTROL_PRICE_BUCKET_B` | LIVE_CONTROL | LIVE_DELAYED_PAPER | true |
| Лайв · Контроль 35–44¢ | `CONTROL_PRICE_BUCKET_C` | LIVE_CONTROL | LIVE_DELAYED_PAPER | true |
| Alpha 1 · Недооценённые исходы | `VALUE_BACKED_TAIL_REPRICING` | ALPHA | FACTS_ONLY | false |
| Alpha 2 · Арбитраж связанных рынков | `STATEWISE_PAYOFF_ARBITRAGE` | ALPHA | FACTS_ONLY | false |

## Воронка доказательств (пять прематч-стратегий; уровни не смешиваются)
| Стратегия | Все записанные BET | DB-first (время в БД) | До старта по расписанию | Авторитетно до старта (игры) | Проверенные независимые игры | Независимый расчёт W–L–VOID–UNKNOWN | Первые недоказанные звенья |
|---|---|---|---|---|---|---|---|
| P50_52_SAFE | 630 | 0 | 0 | 0 | 0 | 0–0–0–0 | контрактных BET ещё нет |
| PORTFOLIO_BROAD_SAFE | 630 | 0 | 0 | 0 | 0 | 0–0–0–0 | контрактных BET ещё нет |
| QUALITY_FILL_A_SAFE | 630 | 0 | 0 | 0 | 0 | 0–0–0–0 | контрактных BET ещё нет |
| QUALITY_FILL_D_SAFE | 630 | 0 | 0 | 0 | 0 | 0–0–0–0 | контрактных BET ещё нет |
| TENNIS_P50_52_SAFE | 341 | 3 | 0 | 0 | 0 | 0–0–0–0 | контрактных BET ещё нет |

# Forward BET ledger — CEO report (five SAFE strategies)

Generated: 2026-10-12T15:03:01.992Z (DBClone, read-only)

## Forward corpus (FORWARD_BET_V1, DB-first, independent CLOB settlement)
| Strategy | verified independent games | BET | WIN–LOSS–VOID–UNKNOWN | original WIN% | semantically validated WIN% | Gross | Fees | Net ROI | confidence | further games needed | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P50_52_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (verified settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |
| PORTFOLIO_BROAD_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (verified settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |
| QUALITY_FILL_A_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (verified settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |
| QUALITY_FILL_D_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (verified settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |
| TENNIS_P50_52_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (verified settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |

## Historical corpus (frozen, first persistence unknown, Gamma-settled — reference only)
| Strategy | verified independent games | BET | WIN–LOSS–VOID–UNKNOWN | original WIN% | semantically validated WIN% | Gross | Fees | Net ROI | confidence | further games needed | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P50_52_SAFE | 0 | 630 | 400–198–0–32 | 66.9% [63.0%, 70.5%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |
| PORTFOLIO_BROAD_SAFE | 0 | 630 | 375–216–0–39 | 63.5% [59.5%, 67.2%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |
| QUALITY_FILL_A_SAFE | 0 | 630 | 398–203–0–29 | 66.2% [62.3%, 69.9%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |
| QUALITY_FILL_D_SAFE | 0 | 630 | 429–166–0–35 | 72.1% [68.4%, 75.6%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |
| TENNIS_P50_52_SAFE | 0 | 338 | 157–123–0–58 | 56.1% [50.2%, 61.8%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |

Legacy DB-first rows without the contract (not counted as proven): P50_52_SAFE=0, PORTFOLIO_BROAD_SAFE=0, QUALITY_FILL_A_SAFE=0, QUALITY_FILL_D_SAFE=0, TENNIS_P50_52_SAFE=3

`UNPROVEN` = not established by evidence (never zero). Gross/Fees/Net ROI stay UNPROVEN until every counted BET carries an executable BUY authority.
