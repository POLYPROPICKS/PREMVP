## Десять исследовательских дорожек
| Стратегия | Independent games | BET | WIN–LOSS–VOID–UNKNOWN | Timing proof | Price proof | Gross/Fees/Net ROI | Confidence | Verdict |
|---|---|---|---|---|---|---|---|---|
| Прематч · Цена 50–52¢ (`P50_52_SAFE`) | 0 | 0 | 0–0–0–0 | forward-доказательств нет; без доказательства времени: 630 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Прематч · Широкий портфель (`PORTFOLIO_BROAD_SAFE`) | 0 | 0 | 0–0–0–0 | forward-доказательств нет; без доказательства времени: 630 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Прематч · Сбалансированный (`QUALITY_FILL_A_SAFE`) | 0 | 0 | 0–0–0–0 | forward-доказательств нет; без доказательства времени: 630 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Прематч · Футбольный расширенный (`QUALITY_FILL_D_SAFE`) | 0 | 0 | 0–0–0–0 | forward-доказательств нет; без доказательства времени: 630 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Прематч · Теннис 50–52¢ (`TENNIS_P50_52_SAFE`) | 0 | 0 | 0–0–0–0 | forward-доказательств нет; без доказательства времени: 339 | UNPROVEN | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (settled n=0) | NO_FORWARD_CONTRACT_BETS_YET |
| Лайв · Контроль 48–52¢ (`CONTROL_PRICE_BUCKET_A`) | 46 | 46 | UNPROVEN (результат не сохраняется в Ledger) | DELAYED_PAPER: 46; LIVE_PROSPECTIVE: 0; TIMING_UNPROVEN: 0 | исполнимый BUY VWAP полного стейка: 46/46 | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (games n=46) | DELAYED_PAPER_ONLY_NOT_FORWARD_EVIDENCE |
| Лайв · Контроль 53–58¢ (`CONTROL_PRICE_BUCKET_B`) | 46 | 46 | UNPROVEN (результат не сохраняется в Ledger) | DELAYED_PAPER: 46; LIVE_PROSPECTIVE: 0; TIMING_UNPROVEN: 0 | исполнимый BUY VWAP полного стейка: 46/46 | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (games n=46) | DELAYED_PAPER_ONLY_NOT_FORWARD_EVIDENCE |
| Лайв · Контроль 35–44¢ (`CONTROL_PRICE_BUCKET_C`) | 95 | 95 | UNPROVEN (результат не сохраняется в Ledger) | DELAYED_PAPER: 95; LIVE_PROSPECTIVE: 0; TIMING_UNPROVEN: 0 | исполнимый BUY VWAP полного стейка: 95/95 | UNPROVEN/UNPROVEN/UNPROVEN | INSUFFICIENT (games n=95) | DELAYED_PAPER_ONLY_NOT_FORWARD_EVIDENCE |
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

# Forward BET ledger — CEO report (five SAFE strategies)

Generated: 2026-10-12T13:54:20.587Z (DBClone, read-only)

## Forward corpus (FORWARD_BET_V1, DB-first, independent CLOB settlement)
| Strategy | independent proven games | BET | WIN–LOSS–VOID–UNKNOWN | original WIN% | semantically validated WIN% | Gross | Fees | Net ROI | confidence | further games needed | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P50_52_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |
| PORTFOLIO_BROAD_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |
| QUALITY_FILL_A_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |
| QUALITY_FILL_D_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |
| TENNIS_P50_52_SAFE | 0 | 0 | 0–0–0–0 | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | INSUFFICIENT (settled n=0) | 100 | NO_FORWARD_CONTRACT_BETS_YET |

## Historical corpus (frozen, first persistence unknown, Gamma-settled — reference only)
| Strategy | independent proven games | BET | WIN–LOSS–VOID–UNKNOWN | original WIN% | semantically validated WIN% | Gross | Fees | Net ROI | confidence | further games needed | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P50_52_SAFE | 0 | 630 | 400–198–0–32 | 66.9% [63.0%, 70.5%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |
| PORTFOLIO_BROAD_SAFE | 0 | 630 | 375–216–0–39 | 63.5% [59.5%, 67.2%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |
| QUALITY_FILL_A_SAFE | 0 | 630 | 398–203–0–29 | 66.2% [62.3%, 69.9%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |
| QUALITY_FILL_D_SAFE | 0 | 630 | 429–166–0–35 | 72.1% [68.4%, 75.6%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |
| TENNIS_P50_52_SAFE | 0 | 338 | 157–123–0–58 | 56.1% [50.2%, 61.8%] | UNPROVEN | UNPROVEN | UNPROVEN | UNPROVEN | n/a (reference) | n/a | HISTORICAL_REFERENCE_ONLY_NOT_FORWARD_EVIDENCE |

Legacy DB-first rows without the contract (not counted as proven): P50_52_SAFE=0, PORTFOLIO_BROAD_SAFE=0, QUALITY_FILL_A_SAFE=0, QUALITY_FILL_D_SAFE=0, TENNIS_P50_52_SAFE=1

`UNPROVEN` = not established by evidence (never zero). Gross/Fees/Net ROI stay UNPROVEN until every counted BET carries an executable BUY authority.
