# POLYPROPICKS: post-June canonical walkthrough V1

## 1. Executive summary

Этот документ объясняет, что именно зафиксировано после исторического аудита и как это нужно читать человеку, который впервые открывает репозиторий. Зафиксирована не «готовая торговая система» и не обещание доходности. Зафиксирована ограниченная, повторяемая историческая база для независимой проверки: 124 уже отобранных решения, принятых не раньше 9 июня 2026 года по часовому поясу Europe/Minsk, их неизменный порядок исполнения, плоская контрольная оценка 1u и два fresh-state повтора уже существующих политик капитала. Все исходные байты, 231 исходная идентичность и ранние свидетельства сохранены; новый документ ничего не оптимизирует и не выбирает заново.

Для компактного визуального просмотра итоговых series используйте локальный автономный файл [post_june_canonical_pnl.html](../../../evidence/2026-07-17-post-june-canonical-freeze-v1/post_june_canonical_pnl.html). Он не является новой базой данных и не загружает внешние библиотеки: числа в нём должны проверяться по machine-readable JSON рядом с ним.

Полная история была поставлена под сомнение, потому что ранний участок 29 мая--7 июня давал непропорционально большую часть результата: Fixed +37.12524392u и в старом Dynamic представлении +78.00453764u. Это не доказывает ошибку, но требует различать момент принятия решения и момент позднего settlement. Аудит обнаружил, что попытка восстановить sport, league и market family для ранних наблюдений опирается почти исключительно на детерминированный разбор заголовков, а не на доверенные исходные metadata-поля.

Поэтому pre-8-June evidence **preserved but quarantined**: оно остаётся доступным для расследования, но не определяет основной исторический verdict. База post-9-June означает только следующее: это фиксированный срез уже locked 231 решений, который можно перепроверить без того, чтобы выдавать LOW-confidence раннюю атрибуцию за подтверждённый edge. Не утверждается, что будущие сделки будут прибыльны, что профиль готов к production, или что metadata уже отремонтирована для runtime.

## 2. Product и научная цель

Нахождение прибыльной последовательности в истории, проверка её временной устойчивости, выбор политики капитала и одобрение runtime-интеграции -- разные задачи. Историческая прибыльность отвечает на вопрос «что получилось бы на определённых уже известных строках при заданной формуле выплаты». Временная устойчивость спрашивает, не создан ли вывод одним ранним периодом, задержкой расчёта или конкретной группой решений. Политика капитала добавляет порядок, открытые позиции, пропуски, Active/Vault и ограничения. Интеграция в продукт добавляет получение данных, состояние, исполнение, наблюдаемость и риски реального окружения.

Следовательно, положительный fixed-1u результат не является рекомендацией торговать; положительный Dynamic replay не является одобрением профиля; проход тестов не является production approval. Исторические данные не гарантируют будущую доходность. Цель пакета -- сделать именно это ограничение видимым, проверяемым и трудным для случайного обхода.

## 3. Каноническая линия данных

Цепочка начинается с 49 400 observations в зафиксированном корпусе. Его gz-байты находятся в `modeling/canonical/datasets/2026-07-15-b2f5dfb5963e/`, а declared dataset SHA-256 равен `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`. Manifest и registry задают договорённые границы чтения. Из корпуса и frozen selector получен исходный locked identity set из 231 выбранной observation identities: SHA `99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca`. Отдельно зафиксирована execution sequence с SHA `5457240a539e5db189c1b23659678f157b322928105909a5812ce318a9d6b036`.

После карантина выборка не пересчитывалась: она фильтрует только уже joined audit rows по `decisionAtIso` в Minsk. Primary содержит 124 строки; membership hash `ed9d96af2bcdc6e262f2a018248e17cca8485846fa5e558265534012393bcc02`, execution-order hash `26a964d5d432e151f132698fa2f1a40906dddc409309d4bae4c90a1b846f4ce0`, replay-input hash `de83408797db5e508ed1d2231e9586232e40e02a9312d8266457804f0bb315cc`.

Термины нельзя смешивать. Dataset row -- одна строка замороженного экспорта. Observation identity -- устойчивый ID этой строки. Physical event -- исторически выводимая группа, но не обязательно provider-level identity. Selected decision -- строка, пережившая frozen selection. Execution order -- committed порядок, с которым replay должен применять решения. Capital-curve point -- состояние капитала на конкретной операции/settlement, а не новое решение. Один physical event может иметь несколько рынков; один selected decision не равен всему событию.

Практический смысл этой линии в том, что каждое утверждение можно привязать к определённому уровню. Когда reviewer хочет проверить PnL, ему нужны primary rows, payout control и execution sequence. Когда он хочет проверить, не подменён ли набор, ему нужны hashes membership и replay input. Когда вопрос касается происхождения строк, нужны freeze manifest и source lineage. Когда вопрос касается группировки события, нельзя переходить сразу от title к provider-level идентичности: такой переход был бы сильнее, чем доступные historical fields. Такой дисциплинарный разрыв между уровнями делает спор проверяемым: несогласие можно оформить как mismatch конкретного файла, а не как общий спор о «качестве данных».

В canonical package нет скрытой операции, которая превращает 49 400 строк в 124 «после просмотра результата». 231 identities уже locked, а последующая фильтрация зависит только от source-backed decisionAtIso и заранее названной границы времени. Primary sequence сохраняет относительный порядок из locked execution sequence. Таким образом, новый baseline сужает scope оценки, но не создаёт новый сигнал, новый pool или новую сортировку. Если независимый reviewer найдёт, что join rows и original sequence расходятся, это блокирующая проблема: документация не может сама решить такой конфликт.

## 4. Ограничение воспроизводимости корпуса

Corpus authority имеет значение `BYTE_FROZEN_SNAPSHOT`. Точные committed bytes и их manifest можно воспроизвести из Git и проверить хешем. Это сильное свойство: новый reviewer может получить тот же вход, а не похожий live ответ. Однако точный первичный database re-export воспроизводим только частично: полный исторический query contract и исходное состояние внешней базы не зафиксированы как повторно исполнимый экспорт. Поэтому честная формулировка такова: snapshot reproducible, original database provenance partial. Это не разрешает заменять bytes современными данными или дописывать отсутствующие поля.

Ограничение имеет два следствия. Во-первых, проверяющий способен воспроизвести этот пакет, но не может по одному Git snapshot доказать, что когда-то существовало каждое raw поле в удалённой исходной системе. Во-вторых, отсутствие возможности live re-export не даёт права «улучшать» историю актуальными API-ответами: они могут отличаться по категории, settlement или metadata. Поэтому в review нужно различать byte integrity и full external provenance. Первая проверяется хешем и Git; вторая остаётся partial и должна оставаться в verdict как data-trust limitation.

## 5. Signal model и статус score

Frozen selector называется `B2_PRICE_FLOOR_030_TIMING_WITHIN_120M`. Canonical contract и executable source показывают, что он работает с уже произведённым score field, применяет score/access contract, price floor 0.30, timing within 120 minutes, исключения и deterministic grouping/ranking. В этой handoff-цепочке не заморожена полная производственная upstream-формула score со всеми входами и весами. Поэтому точный статус:

`SCORE_CONTRACT_STATUS: UPSTREAM_SCORE_PRODUCTION_NOT_FROZEN`

Это не означает, что score не существовал в строках; это означает, что нельзя приписывать ему не найденные веса или «восстанавливать» формулу из результата. Selector consumes an already-produced score field. Документ намеренно не изобретает Signal Score inputs, коэффициенты или ML-интерпретацию.

Это различие особенно важно для будущего исполнителя. Он может проверить, что конкретная historical observation несла score и что classifier применил документированный порог/фильтры. Но он не должен говорить, будто этот пакет объясняет, почему upstream score был 72, 65 или 90. Воспроизводимый selector и воспроизводимая score-production -- два разных контракта. Пока второй не зафиксирован отдельно, новый runtime не должен считать себя эквивалентом исторического производителя score только на основании совпадения name модели. Именно поэтому независимому review поручено проверить selection source и тесты, а не угадывать недостающую модель по успешным исходам.

## 6. Воронка отбора

Доказуемый порядок такой: dataset input -> score/access contract -> frozen price/timing и другие classifier filters -> event grouping/ranking -> selected observation identities -> committed execution order. Ключевой момент: membership и ranking происходят до replay, а replay не имеет права пересортировать membership по красивому результату. Если источник не доказывает более тонкий порядок между двумя правилами, данный документ его не выдумывает.

Воронка также объясняет, почему outcome не должен использоваться для решения о включении. Result и resolvedAt нужны для retrospective payout и curve, но не для того, чтобы вернуть в набор строку, которая не проходила access/price/timing contract. Аналогично, капиталовая политика расположена после selection: она может исполнить или пропустить already selected row из-за состояния, но не должна превращать skipped row в новую signal identity. Такой порядок позволяет отдельно спрашивать: «правильно ли выбран сигнал?» и «правильно ли этот сигнал был профинансирован?». Смешение этих вопросов часто маскирует отрицательную policy replay положительной flat ROI.

## 7. Identity set не равен execution sequence

Membership hash отвечает на вопрос «какие IDs входят». Для детерминированного hashing IDs могут быть лексикографически отсортированы. Это не хронология. Execution sequence отвечает на вопрос «в каком порядке уже selected решения применялись». Именно второй файл нужен capital replay. При одинаковых timestamp порядок остаётся committed order, а не результатом новой сортировки. Подмена sequence membership-сортировкой меняет открытые позиции и может менять политику капитала, даже если набор ID тот же.

Для post-June фильтра это означает простую проверку: IDs primary должны быть subsequence исходных 231, а их executionIndex остаются в возрастающем committed порядке. Нельзя отсортировать их по resolvedAt, outcome, title или ID и затем называть полученное «тем же replay». Membership hash полезен для защиты от silent add/drop; execution-order hash -- от тихой перестановки. Replay-input hash покрывает всю строку, которую engine фактически получает. Reviewer должен проверять все три, поскольку совпадение только count=124 недостаточно: две разные выборки могут иметь один размер и противоположную статистику.

## 8. Почему полная история стала сомнительной

Ранние 29 мая--7 июня особенно сильно повлияли на график: Fixed +37.12524392u, а старое Dynamic представление показывало +78.00453764u. Аудит отделил chronology по settlement от chronology по decision. Первый график показывает, когда результат был учтён; второй -- когда решение было доступно. Поздние resolution, backfill и длинные лаги способны создать plateau после ранней серии и визуально усилить ранний вклад. Это не само по себе leakage, но достаточная причина требовать отдельной проверки и не называть ранний успех устойчивым без качественной атрибуции.

Концентрация имеет и содержательный риск. Если большая часть PnL относится к короткому временному окну, хорошая aggregate кривая может описывать один режим данных, один тип delayed settlement или один набор похожих событий. Это не обязательно плохой сигнал; но проверка должна искать отрицательные сегменты, просадки и долю крупнейших observations, а не только перечислять winners. Temporal audit поэтому оставлен неизменным: он является основанием для карантина, а не заменён новым красивым отчётом. Post-June freeze не «лечит» ранние строки и не присваивает им новую атрибуцию.

## 9. Результат attribution repair

Покрытие 231 locked rows точно такое: sport -- 230 LOW и 1 UNRESOLVED; league/competition -- 230 LOW и 1 UNRESOLVED; market family -- 231 LOW. HIGH/MEDIUM trusted coverage равно 0. Следовательно, Baseball, MLB и Moneyline, полученные из title/slug parsing, могут быть диагностическими гипотезами, но не trusted canonical metadata. В пакете также сохранён unresolved Dynamic attribution conflict: он не замазан выбором удобного значения. LOW не может незаметно засчитываться как HIGH/MEDIUM.

Причина этого правила не бюрократическая. Название события может быть неполным, рынок может иметь несколько похожих вариантов, а исторический slug может утратить provider context. Наличие правдоподобной строки «Seattle Mariners» не подтверждает автоматически sport/league или market family тем уровнем, который нужен для runtime filtering. Direct raw metadata, если есть и непротиворечиво нормализуется, было бы HIGH; комбинация frozen fields/исторического resolver -- MEDIUM; title parsing -- LOW. Здесь trusted coverage ноль, так что документы не используют полученные сегменты как доказательство источника edge.

## 10. Решение о карантине

Primary canonical cutoff: `decisionAt >= 2026-06-09T00:00:00 Europe/Minsk`. Sensitivity: `decisionAt >= 2026-06-08T00:00:00 Europe/Minsk`. Pre-8-June preserved but quarantined, потому что trusted HIGH/MEDIUM sport, league и market-family attribution coverage равно нулю. Это boundary data trust, а не новый profitability threshold. Не тестировались другие даты и не выбиралась дата с лучшей ROI. Карантин не удаляет ранние строки и не утверждает, что они ложны; он предотвращает представление LOW-confidence объяснения как доказанного edge.

## 11. Primary post-9-June subset

Primary включает 124 ordered decisions, 61 win и 63 loss, без void/other. При exactly 1u на каждую строку total stake равна 124u, gross PnL равен +16.82674451u, gross ROI 13.56995525%, maximum drawdown 5.86500797u, longest loss streak 4. Условие применено в Minsk: первая UTC-временная строка может иметь дату 8 июня UTC, если в Minsk уже 9 июня.

Sensitivity post-8-June содержит 126 решений, gross PnL +19.03913781u и gross ROI 15.11042684%. Это не конкурирующая canonical baseline и не доказательство того, что границу надо сдвинуть: это заранее фиксированная чувствительность к соседней дате.

В primary есть 61 win и 63 loss, то есть сам положительный gross PnL не сводится к заявлению о «необычно высоком проценте побед». Выплата зависит от entry price, поэтому бинарная частота выигрышей недостаточна. Median PnL равен -1u, лучший single decision +2.278688524590164u, худший -1u. Эти числа помогают reviewer-у увидеть, что одна и та же серия может иметь большинство losses и всё же positive gross return. Они также делают важной проверку payoff formula: ошибка в цене или трактовке win/loss легко меняет интерпретацию больше, чем несколько basis points cost sensitivity.

## 12. Почему fixed 1u -- основной сигнал-контроль

Flat 1u удаляет compounding, dynamic stake sizing, Vault transfers, CPPI skips и capital-policy confounding. Каждое selected primary decision исполняется ровно один раз, без capital skip. Поэтому эта серия отвечает на наиболее узкий вопрос: какова gross историческая выплата уже выбранной последовательности? Она не отвечает на вопрос, выдержит ли выбранная политика капитал, комиссии или реальный runtime.

Именно поэтому результаты Fixed Safe и Dynamic не должны подменять fixed-1u answer. У них иная цель: они проверяют, как frozen operating policies реагируют на same ordered subset при свежем начальном состоянии. Если Dynamic выше flat control, это не доказывает, что selector стал лучше; если Fixed Safe ниже нуля, это не доказывает, что payout control ложен. Сравнивать нужно как два слоя: сначала signal-quality control, затем отдельно implementation of capital constraints. Это также защищает от соблазна выбрать policy по уже известному историческому ответу.

## 13. Чувствительность к издержкам исполнения

Использована общая формула `costU = stakeU × costBps / 10,000`, применённая к каждому исполненному 1u. Это не заявление о фактической комиссии конкретной площадки. Результаты: 0 bps +16.82674451u; 25 bps +16.51674451u; 50 bps +16.20674451u; 100 bps +15.58674451u; 200 bps +14.34674451u. Exact break-even all-in cost равен 1356.99552498 bps. Даже эта цифра не отменяет slippage, availability или latency; она лишь показывает чувствительность к объявленной линейной формуле.

Cost table следует читать симметрично: она показывает, что при данных условных cost levels gross-positive контроль остаётся net-positive, но не измеряет реальный all-in execution. Никакая строка не говорит о spread, очереди, частичном fill, отмене, market impact или комиссии конкретного провайдера. До shadow evaluation отсутствие такой модели -- не повод назвать прибыль «net verified». В independent review допустим verdict с blocking condition именно по execution realism, даже если арифметика таблицы безупречна.

## 14. Fixed Safe profile

`FIXED_SAFE_V1` сочетает `FIXED_1U` и `CPPI_0.4_0.5`. CPPI, Constant Proportion Portfolio Insurance, здесь означает правило, которое определяет допускаемую Active-экспозицию как функцию капитального cushion; оно не гарантирует сохранность капитала. Fresh-state replay начинает с Active 50u, Vault 0u и не наследует pre-cutoff позиции или gains. Он исполнил 49 решений и пропустил 75: ending Active 25.42422762u, Vault 20.22407047u, Total 45.64829809u, PnL -4.35170191u, maximum fall 7.86222187u, CVaR95 13.46347823u.

Gross-positive signal sequence может дать negative policy outcome: ранние/открытые риски занимают доступный капитал, CPPI ограничивает последующие входы, а пропущенные положительные решения не компенсируют исполненные убыточные. Это свойство конкретного fresh replay, не аргумент задним числом менять policy.

Здесь особенно важно слово fresh-state. Результат не переносит Active/Vault, открытый principal или ранее достигнутые thresholds из quarantined периода. Это делает comparison с primary signal control более прозрачным, но также означает, что это не прогноз того, что произошло бы в непрерывной полной истории. Secondary carry-forward sensitivity могла бы отвечать на иной вопрос, однако она не должна определять canonical verdict, потому что именно pre-cutoff состояние quarantined. Reviewer обязан проверить ledger-to-curve reconciliation и то, что Active + Vault равно Total в применимых точках.

## 15. Dynamic Protected Growth

`DYNAMIC_PROTECTED_GROWTH_V1` использует `DYNAMIC_ACTIVE_3PCT` и `PRV2_T25_P50_R1_S0.05_C0.1`. Active -- капитал, доступный для текущей стратегии; Vault -- выделенный защищённый баланс; Total = Active + Vault; open principal -- ещё не освобождённая сумма открытых позиций; state carrying -- перенос этого состояния между committed операциями. Principal-recovery trigger определяет возвращение к recovery condition, skim -- долю переноса в Vault, transfer cap -- ограничение такого переноса. Эти определения описывают существующий engine, а не новую интерпретацию параметров.

Fresh-state replay исполнил 123, пропустил 1, закончил Active 75u, Vault 7.11107514u, Total 82.11107514u, PnL +32.11107514u, maximum fall 11.46632001u и maximum concurrency 33 при лимите 36; exposure-ceiling violations 0. State hash: `3c1749769327f84150a9ce0fdebb37c6b957e3dfb9ad3a463c7a1bd7918ffb3c`. Это positive fresh-state result, но не production approval. Capture `cvar95` в committed state равен 0, поэтому reviewer обязан проверить, означает ли это вычислительную особенность/недостаточную метрику, а не трактовать его как отсутствие tail risk.

Dynamic отличается от Fixed Safe не только размером stake. Он несёт состояние между решениями, поэтому порядок sequence и решение о том, когда principal считается открытым/освобождённым, становятся частью результата. Profile parameters заморожены и не могут быть переподобраны после просмотра +32.11107514u. Число 33 означает, что в этом replay лимит 36 не нарушен; оно не доказывает, что production scheduler будет так же обрабатывать timestamps, delayed resolution или одновременно доступные рынки. Именно поэтому production integration остаётся not approved.

## 16. Реальный worked example

Возьмём observation ID `6776a92e-0298-43d2-99fe-00ced5b2d64d` из `post_june9_primary_rows.json`. Это executionIndex 107; decisionAtIso `2026-06-08T21:05:00.000Z`, то есть уже 9 июня в Minsk; resolvedAtIso `2026-06-19T00:02:32.63+00:00`; entryPrice 0.465; result `loss`; event title Seattle Mariners vs. Baltimore Orioles; market title `$8K matched activity`. Sport и league здесь не объявляются доказанными: committed row хранит их null.

Fixed 1u использует stake 1 и получает -1u. В fixed-safe ledger эта строка тоже `EXECUTED_FULL`, stake 1, netPnl -1. В dynamic-protected ledger она `EXECUTED_FULL`, stake 1.5, netPnl -1.5. Разница не в переоценке результата или в новом score, а в state-carrying dynamic sizing. Дальнейшее изменение Active/Vault следует смотреть по committed capital curve вокруг decision/resolution timestamp; нельзя приписывать ему sport attribution или незафиксированную формулу score.

## 17. Temporal stability

Primary first half: 62 observations, 28/34 W/L, +0.84514956u, ROI 1.36314445%. Second half: 62, 33/29, +15.98159495u, ROI 25.77676605%. Это гетерогенность, а не статистическая гарантия. Rolling 20 ROI меняется от отрицательных окон, включая -21.68251099%, до положительных; последний доступный rolling 40 ROI равен 25.79281237%. Weekly decision-date результаты и весь rolling series находятся в `temporal_stability.json`; не следует заменять их settlement-week графиком.

В артефакте также зафиксированы deterministic bootstrap 10 000 resamples с seed 20260717, Wilson interval win rate, top-five contribution и concentration. Reviewer должен читать exact values из JSON и проверять способ расчёта, а не выводить уверенность из одной aggregate ROI. Выборка 124 наблюдения мала для доказательства стабильности в новом runtime, особенно при неизвестной полной upstream score-production и LOW metadata attribution.

Bootstrap interval отвечает на вопрос о неопределённости среднего PnL при повторном выборочном представлении уже имеющихся наблюдений; он не моделирует новую эпоху данных и не устраняет dependence между похожими событиями. Wilson interval относится к win rate, а не к payout-weighted ROI. Поэтому ни один из интервалов не должен быть превращён в «вероятность будущей прибыли». Их ценность практична: они заставляют reviewer-а видеть разброс и разделять частоту выигрышей, размеры выплат и концентрацию. Если top-five contribution слишком велика, положительная mean может оказаться менее переносимой, чем кажется по общей сумме.

## 18. TDD и verification

Изменения freeze проходили RED до появления нового модуля, затем targeted GREEN. Для этой объяснительной оболочки запускаются `npx vitest run tests/modeling/postJuneReviewBundle.test.ts`, `npx vitest run tests/modeling/postJuneCanonicalFreeze.test.ts`, `npx vitest run tests/modeling/suspiciousGrowthTemporalAudit.test.ts`, `npx vitest run tests/modeling/suspiciousGrowthAttributionRepair.test.ts`, `npx tsc --noEmit` и `npm run build`. Generator `npx tsx scripts/modeling/strategies/build-post-june-review-bundle.ts` запускается дважды; manifest и second run должны совпасть. Проверяются frozen-input hashes, отсутствие абсолютных путей, секретов и network dependency в review HTML/markdown. Тесты повышают воспроизводимость, но не заменяют независимую научную проверку.

RED означает не ритуальное упоминание теста, а зафиксированную ошибку import отсутствующего generator до его реализации. GREEN означает, что новый generator создаёт review files и test independently пересчитывает их SHA-256. Regression suites temporal-audit, attribution-repair и post-June-freeze защищают от того, чтобы docs task случайно меняла существующие modelling outputs. Determinism проверяется повторным запуском без нового diff. Diff check ищет whitespace и неожиданные файлы. Path/network scan исключает абсолютный путь к машине и необходимость сети для чтения bundle.

## 19. Git lineage

Temporal audit: `ccc46d1`, `1fe6a81`, `08760be`. Attribution repair: `401a142`, `2061356`. Post-June freeze: `cc2a1ec`, `e878e0e`. Финальный commit этой walkthrough/review задачи указан в review index после её создания. Цепочка нужна для поиска producing source, но authority остаётся за конкретным committed artifact и его SHA-256.

## 20. Current canonical verdict

PRIMARY CANONICAL PERIOD: POST-9-JUNE DECISION-TIME SUBSET. PRE-JUNE8: QUARANTINED. SIGNAL CONTROL: GROSS POSITIVE. FIXED SAFE: NEGATIVE FRESH-STATE REPLAY. DYNAMIC PROTECTED: POSITIVE FRESH-STATE REPLAY. CANONICAL BASELINE: FROZEN FOR REVIEW. PRODUCTION INTEGRATION: NOT APPROVED. IRELAND: BLOCKED.

## 21. Что обязан оспорить независимый reviewer

Проверить защитимость границы 9 июня и отсутствие скрытого temporal leakage; убедиться, что payout formula соответствует intended market contract; проверить, что fixed-1u -- корректный primary comparator; отделить generic costs от реальной комиссии; доказать, что Dynamic не наследует pre-cutoff state; пересчитать skips, concurrency и exposure; оценить достаточность sample для shadow evaluation; решить, требуется ли metadata attribution repair до runtime; перечислить доказательства, нужные до PREMVP integration. Любое несоответствие hash, subset, выплаты или state reconciliation является finding, а не поводом молча исправлять историю.

Reviewer не обязан подтверждать исходную гипотезу. Его задача -- пытаться её опровергнуть с той же аккуратностью, с какой авторы воспроизводят result. Полезные вопросы включают: одинаково ли interpreted time zone во всех test/source paths; может ли resolvedAt влиять на entry eligibility; соответствует ли entryPrice payout convention; есть ли selected identity с неполной source row; все ли Fixed Safe skips объясняются engine state; воспроизводится ли Dynamic capital curve из ledger; не скрывает ли cvar95=0 важную неполноту; не требуют ли LOW fields runtime repair даже при post-June quarantine. Ответ «тест проходит» без привязки к артефакту не достаточен.

## 22. Exact next steps

1. Провести независимый scientific review с `INDEPENDENT_REVIEW_PROMPT_RU.md` в свежей сессии GPT-5.6 Sol.
2. Разрешить все blocking findings reviewer-а документированно.
3. Founder принимает или отклоняет post-June baseline.
4. Только после принятия отдельно inspect runtime wiring PREMVP.
5. Интеграция остаётся новым bounded task, без изменения этого evidence package.
6. Ireland остаётся blocked.

### Как пользоваться evidence без подмены вывода

Новый читатель обычно начинает с итоговой цифры, затем пытается найти подтверждение в красивой curve. Для этого пакета правильнее идти в обратном направлении. Сначала открыть source inventory review bundle и убедиться, что hashes относятся к существующим committed files. Затем прочитать contract и locked sequence, потому что именно они определяют, что считается одной выбранной операцией. Потом открыть primary rows и сверить membership/order hashes. Только после этого имеет смысл сравнивать fixed-1u, cost sensitivity и policy curves. Такой порядок снижает риск, что reviewer примет aggregate result как доказательство корректности входа.

При чтении JSON нужно отделять source facts от derived facts. ID, timestamp, entryPrice и recorded result -- поля входной joined строки. Gross PnL, ROI, drawdown, rolling window и bootstrap -- derived computations. Active/Vault/Total в ledger/curve -- derived state engine. Название профиля и его parameters -- frozen contract. Текст walkthrough -- объяснение, которое должно совпадать с этими уровнями, но не имеет права их заменять. Если число в тексте и в machine artifact расходятся, authority у machine artifact, а расхождение надо записать как documentation defect.

### Границы того, что уже можно утверждать

На данный момент можно утверждать, что конкретный локальный snapshot, конкретные 231 IDs и конкретный post-June subset проверяемы детерминированно. Можно утверждать, что flat 1u replay указанной 124-row sequence даёт stated gross result при используемой payout convention. Можно утверждать, что fresh-state engines дали captured Fixed Safe и Dynamic outputs при frozen parameters. Можно утверждать, что ранняя metadata attribution не достигла trusted coverage и потому не должна поддерживать canonical full-history claim.

Нельзя утверждать, что edge причинно объяснён конкретным видом спорта; что metadata исправлена для production; что все реальные сделки будут доступны по entryPrice; что generic bps исчерпывают execution costs; что Dynamic profile safe; что partial export provenance равна полной provenance; что 124 наблюдения достаточны для масштаба; или что Ireland/PREMVP получили разрешение. Эти отрицательные утверждения не являются избыточной осторожностью. Они ограничивают класс решений, которые можно принять на основании evidence, и защищают будущего исполнителя от превращения historical audit в неявный production sign-off.

### Что считать хорошим review outcome

Хороший review может закончиться acceptance для shadow review, acceptance с blocking conditions или rejection. Любой из этих результатов полезнее, чем неструктурированное «выглядит хорошо». Acceptance для shadow review должен означать, что hashes, subset, calculation и scope выдержали независимую проверку, а не что будущий PnL гарантирован. Acceptance with blocking conditions может потребовать поправить runtime metadata, cost model, cvar calculation или test coverage до следующего этапа. Rejection pending data repair означает, что problem находится в provenance/attribution/inputs. Rejection model not promotable означает, что даже при корректных bytes или replay evidence риск модели/policy не приемлем для следующей стадии.

Ни один outcome не разрешает менять frozen package задним числом. Если reviewer находит ошибку, следующий milestone должен создавать новый versioned package с ясной lineage: что было обнаружено, какие артефакты остались immutable, какие новые computation outputs построены и какой verdict теперь применим. Так сохраняется возможность сравнить версии без переписывания истории. Этот V1, следовательно, является не концом исследования, а точкой, в которой исследование впервые становится достаточно ограниченным для честной независимой критики.

Наконец, reviewer должен записывать не только обнаруженные ошибки, но и объём выполненной проверки. Например: какой commit проверен, какие hashes пересчитаны, как был подтверждён Minsk cutoff, были ли independently сверены 124 IDs и 126 sensitivity IDs, какие ledger rows были выбраны для spot check, и какие исходные тесты прочитаны. Такой журнал не превращает review в повторный export или production action; он делает результат review воспроизводимым для founder-а и следующего исполнителя. Если какая-либо проверка не выполнена из-за отсутствия источника, это должно быть `UNRESOLVED`, а не подразумеваемое PASS. Именно это позволяет следующему milestone быть ограниченным конкретным finding, а не возвращаться к расплывчатому спору о всей модели.
