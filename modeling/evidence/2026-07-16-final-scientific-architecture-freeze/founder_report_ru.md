# Финальный исторический scientific freeze — отчёт основателю

Проверены 25 coarse capital policies: No Vault, Static Capital Floor, High-Watermark Drawdown Floor и one-way ratcheted CPPI. Refinement выполнялся только вокруг максимум трёх development Pareto candidates; общий предел — 35. Это дискретные проектные адаптации, а не заявления о точном воспроизведении академических торговых стратегий.

Development — первые 70% Minsk operating-day blocks; confirmation — последние 30%. Внутри development использованы expanding one-block-ahead результаты только после 12 prior blocks. Confirmation не использовался для refinement, выбора capacity или SPA inputs. Это historical pseudo-out-of-sample evidence, не forward validation.

PRIMARY выбрал `NO_VAULT_FIXED100`; Hansen SPA consistent=0.5864, conservative upper=0.6408. SENSITIVITY выбрал `NO_VAULT_FIXED100`; consistent=0.3873, upper=0.42855. Verdict: `CAPITAL_POLICY_SIGNAL_SEQUENCE_DEPENDENT`.

- PNL_MAX: model `B2_TIMING_WITHIN_120M`, policy `NO_VAULT_FIXED100`, stake `FIXED_100`, scenario `NIGHT_ONLY`.
- Capacity: 36 positions, 0.8 exposure, 100 accepted per Minsk operating day.
- Confirmation: 45 executions, PnL $1364.53467215, ROI 30.32299271%, ending Total $11364.53467215.
- Minimum Total $9800, maximum fall $321.52765544, CVaR95 maximum fall $609.29271625, probability below initial 0.09745.

- RISK_MIN: model `B2_PRICE_FLOOR_030_TIMING_WITHIN_120M`, policy `NO_VAULT_FIXED100`, stake `FIXED_100`, scenario `24X7`.
- Capacity: 36 positions, 0.8 exposure, 100 accepted per Minsk operating day.
- Confirmation: 48 executions, PnL $1157.99668909, ROI 24.12493102%, ending Total $11157.99668909.
- Minimum Total $9800, maximum fall $321.52765544, CVaR95 maximum fall $584.53317581, probability below initial 0.06295.

- SCIENTIFIC_FINAL_WINNER: model `B2_TIMING_WITHIN_120M`, policy `NO_VAULT_FIXED100`, stake `FIXED_100`, scenario `NIGHT_ONLY`.
- Capacity: 36 positions, 0.8 exposure, 100 accepted per Minsk operating day.
- Confirmation: 45 executions, PnL $1364.53467215, ROI 30.32299271%, ending Total $11364.53467215.
- Minimum Total $9800, maximum fall $321.52765544, CVaR95 maximum fall $609.29271625, probability below initial 0.09745.

На банке $10,000 FIXED_100 всегда ставит ровно $100. DYNAMIC_ACTIVE_3PCT фиксирует 3% разрешённого Active reference на границе Minsk operating cycle и не уменьшает максимум из-за уже открытых позиций. Vault односторонний: переводы возможны только из free Active после settlement; автоматического возврата из Vault нет. Для одинакового timestamp сначала закрывается весь settlement batch, затем применяется capital policy, затем обрабатывается entry batch.

Цена защиты измеряется разницей PnL и skipped positions относительно No Vault и альтернативных capacity cells; полные значения находятся в machine-readable frontier и matrix. Отдельные 24×7 и NIGHT_ONLY результаты нельзя взаимозаменять: NIGHT_ONLY — окно 18:00–09:00 Europe/Minsk.

Ограничения: frozen historical dataset не является forward sample; SPA/upper подтверждают только процедуру multiple-testing на development blocks; результаты чувствительны к исторической последовательности, settlement labels и доступной выборке; комиссии и live slippage не добавлялись; Ireland parity и live readiness не проверялись.

Dataset SHA-256: `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`.
