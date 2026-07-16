# State-carrying Dynamic Vault validation

Старый block-local reset возвращал Active к 50u и Vault к 0u, поэтому не мог проверить накопительный Principal Recovery Vault. Новый контракт выполняет один непрерывный replay: капитал, Vault, high-water marks, открытые позиции, transfer progress и stake reference переходят через границы Minsk blocks.

Development winner: PRV2_T50_P25_R0.25_S0_C0.1. Confirmation: 52.46288893u. Full PnL: 158.53492847u. Vault: 25u. Status: STATE_CARRYING_VALIDATION_SUPPORTS_PROTECTED_DYNAMIC_CANDIDATE.

Это historical state-carrying pseudo-OOS, not true forward validation. Frozen bootstrap не применяется к state-dependent path; приведены exact chronological metrics.
