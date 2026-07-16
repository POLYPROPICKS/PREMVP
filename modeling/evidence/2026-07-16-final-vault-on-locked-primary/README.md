# Final scientific Vault frontier — locked PRIMARY

This bounded evidence package evaluates only Vault capital policies over the locked 231-execution sequence of `B2_PRICE_FLOOR_030_TIMING_WITHIN_120M`. It does not select, compare, or replace signal models.

The replay contract is: 50u total starting capital, 0u Vault, fixed 1u stake, 24×7 decisions, and no dynamic sizing. One unit is $100. The frozen dataset SHA-256 and locked sorted execution-ID SHA-256 are recorded in `manifest.json`.

`vault_frontier.json` is the complete 25-policy grid; `winner_execution_ledger.json` and `winner_capital_curve.json` are the selected balanced policy; the two oracle input/output pairs reproduce block-length and SPA calculations. `dashboard.html` is self-contained and embeds the same machine evidence.
