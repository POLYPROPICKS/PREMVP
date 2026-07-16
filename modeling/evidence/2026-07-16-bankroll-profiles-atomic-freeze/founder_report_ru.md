# Атомарная фиксация профилей банка V1

Зафиксированы ровно два профиля: **Fixed Safe** (фиксированная ставка 1u и только его CPPI Vault `CPPI_0.4_0.5`) и **Dynamic Protected Growth** (3% от Active и только его Principal Recovery Vault `PRV2_T25_P50_R1_S0.05_C0.1`). Ставка и Vault образуют неделимый профиль: Dynamic без Vault, Dynamic с Fixed CPPI, Fixed с Dynamic Vault и любые неизвестные сочетания запрещены.

Production default не выбран: интеграция обязана передать явный approved profile ID. Хэши реестра, каждого профиля, общего signal-контракта и evidence lineage защищают параметры от скрытого изменения. Исторические метрики подтверждают зафиксированные варианты, но не гарантируют будущий или live результат.

Следующий шаг может только подключить PREMVP к этому реестру. Интеграции запрещено менять signal model, stake, Vault, capacity, параметры или evidence lineage. Ireland остаётся заблокирован до отдельного integration Gate 1 и inspect-only parity.
