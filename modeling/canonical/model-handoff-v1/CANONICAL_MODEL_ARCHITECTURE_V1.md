# Canonical Model Architecture V1

Пакет фиксирует модель B2_PRICE_FLOOR_030_TIMING_WITHIN_120M как селектор уже рассчитанных score-полей. **The approved selector consumes already-produced score fields. Score production itself is not reimplemented by this handoff package.** Формула score не изобретается.

Контракт: активный score threshold, исключение eSports, price floor 0.30, окно ≤120m, identity normalization, sporting-match grouping, ranking/tie-breaks и one execution per event определены executable source и тестами в SOURCE_TEST_EVIDENCE_MAP_V1.md. Порядок: детерминированный entry; settlement по времени с same-time batching; Minsk cycles; capacity 36 и exposure fail-closed.

Fixed: FIXED_1U + ONE_WAY_RATCHETED_CPPI CPPI_0.4_0.5 (alpha=0.4, multiplier=0.5). Dynamic: DYNAMIC_ACTIVE_3PCT + DYNAMIC_PRINCIPAL_RECOVERY_VAULT_V2 PRV2_T25_P50_R1_S0.05_C0.1. Active, Vault, freeActive/openPrincipal и carried state — капитал-состояние. Скрещивание Fixed stake с Dynamic Vault и Dynamic stake с Fixed Vault запрещено.
