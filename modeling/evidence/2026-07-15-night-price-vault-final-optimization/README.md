# Финальный кандидат PREMVP bankroll architecture

Расчёт выполнен только на frozen dataset SHA-256 `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`.

Рекомендуемый кандидат: `MINSK_NIGHT_FIXED_MAX3_V1`, все решения сохраняют eligibility, all-100 price bands, 36 одновременно открытых позиций, exposure cap 100%, Vault `A1_T2_R0.25_S0`.

Простой смысл: в 18:00 по Минску фиксируется Active bankroll ночи. Максимум одного матча равен 3% этой суммы и не меняется до следующей границы. Если Active = $3,333.33, максимум = $100. Price-band поиск не доказал out-of-sample улучшение, поэтому коэффициенты не уменьшают stake автоматически.

Реальный execution window 18:00–09:00 проверен отдельно: он исключает 20 кандидатов, уменьшает executions на 11 и PnL на 36.78650541 units. Он не включён в candidate автоматически и остаётся явным founder trade-off.

Полные artifacts: `C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15_b2f5dfb5963e\night-price-vault-final-optimization`.
