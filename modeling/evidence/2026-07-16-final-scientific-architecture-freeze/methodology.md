# Scientific methodology

The frozen corpus SHA-256 is `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`. Existing T−90, historical match identity, settlement labels, entry prices, model formulas, one-match grouping, and ranking are reused unchanged.

Minsk operating days run 18:00–17:59:59. The first 70% chronological blocks are development and the last 30% are confirmation. Development policy comparison uses one-block-ahead rows only after 12 prior blocks. Coarse search is exactly 25 policies; refinement is limited to three deterministic Pareto seeds and 35 total policies. Confirmation results do not determine refinement, capacity, or oracle inputs.

Fixed execution starts with $10,000 and stakes exactly $100. Dynamic execution fixes 3% of Active at the approved Minsk cycle boundary and never shrinks the cycle maximum because positions opened. Equal timestamps follow settlement batch → capital policy → entry batch. Active equals free cash plus unresolved cost basis; Total equals Active plus one-way Vault.

Policy families are No Vault, Static Capital Floor, High-Watermark Drawdown Floor, and one-way ratcheted CPPI with multiplier at most 1. These are explicit discrete project adaptations, not claims of exact academic trading-system replication.

The validated `arch==8.0.0` oracle uses stationary bootstrap, automatic `b_sb`, 20,000 replications, seed `20260716`, `studentize=true`, and `nested=false`. `consistent` is the Hansen SPA decision value, `upper` is conservative corroboration from the same engine, and `lower` is report-only. PRIMARY: `b_sb=0.26967172123214733`, `b_cb=0.3086970601083109`, consistent `0.5864`, upper `0.6408`. SENSITIVITY: `b_sb=0.6667700403846386`, `b_cb=0.763261161736156`, consistent `0.3873`, upper `0.42855`.

Both sequences select `NO_VAULT_FIXED100`: no non-control has a positive confirmation PnL differential with SPA consistent ≤0.10. The sequence verdict remains `CAPITAL_POLICY_SIGNAL_SEQUENCE_DEPENDENT` because confirmation PnL differs by at least $100, even though the selected policy ID is identical.

Capacity is selected on development from positions `[30,36,40,45,50,60]` × exposure `[0.80,0.85,0.90,0.95,1.00]`. Cells that fail the $4,035.199895 historical drawdown ceiling on development remain diagnostic-only and cannot win. Final selection maximizes confirmation PnL; candidates within $100 use CVaR95 maximum fall, probability below initial, fixed sizing, simpler filter, and deterministic hashes as tie-breaks.

CVaR95 maximum fall is the mean of the worst 5% stationary-bootstrap maximum absolute USD falls from previous Total peak. Probability below initial is the share of bootstrap terminal capitals below $10,000.
