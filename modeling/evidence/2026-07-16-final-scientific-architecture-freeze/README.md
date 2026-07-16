# Final scientific historical architecture freeze

Status: `HISTORICAL_ARCHITECTURE_FROZEN`, `IRELAND_PARITY_PENDING`, `FORWARD_VALIDATION_PENDING`, `NOT_LIVE`.

The frozen historical architecture is:

- signal model: `B2_TIMING_WITHIN_120M`;
- capital policy: `NO_VAULT_FIXED100`;
- stake policy: `FIXED_100`;
- operation scenario: `NIGHT_ONLY`, 18:00–09:00 Europe/Minsk;
- capacity: 36 concurrent positions, 80% exposure, 100 accepted per Minsk operating day;
- starting capital: $10,000.

Confirmation result: 45 executions, PnL $1,364.53467215, ROI 30.32299271%, ending Total/Active/Vault $11,364.53467215 / $11,364.53467215 / $0, minimum Total $9,800, maximum fall from prior Total peak $321.52765544, CVaR95 maximum fall $609.29271625, probability below initial 0.09745.

Start with `founder_report_ru.md`, `final_selection.json`, `freeze_registry.json`, and `scientific_architecture_dashboard.html`. Full arrays and machine evidence remain in this bounded directory. This is historical pseudo-out-of-sample evidence, not true forward validation or live approval.
