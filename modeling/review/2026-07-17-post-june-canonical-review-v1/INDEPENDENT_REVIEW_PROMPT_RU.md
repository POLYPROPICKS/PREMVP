# Независимая проверка: bounded inspect-only prompt

Работайте как GPT-5.6 Sol или эквивалентная независимая reasoning-модель. Режим **inspect-only**: не изменяйте репозиторий, не запускайте оптимизацию, не выбирайте другую дату cutoff и не одобряйте production только потому, что тесты проходят.

Прочитайте REVIEW_BUNDLE_INDEX_RU.md, полный walkthrough и перечисленные source artifacts. Независимо пересчитайте hashes, membership/order, fixed-1u PnL, cost formula, и fresh-state replay reconciliations настолько, насколько позволяют committed data и source/tests. Попытайтесь опровергнуть выводы: ищите temporal leakage, survivorship, ошибку payout, неверную Minsk границу, attribution risk, hidden pre-cutoff capital state, и неверное представление skips/concurrency/exposure.

Ответьте разделами: verified facts; calculation mismatches; methodology concerns; data-trust concerns; model-risk concerns; capital-policy concerns; missing tests; blocking conditions; recommended next milestone; final verdict.

Финальный verdict строго один из: `ACCEPT_POST_JUNE_BASELINE_FOR_SHADOW_REVIEW`, `ACCEPT_WITH_BLOCKING_CONDITIONS`, `REJECT_PENDING_DATA_REPAIR`, `REJECT_MODEL_NOT_PROMOTABLE`. Production approval не является допустимым автоматическим выводом этого задания.
