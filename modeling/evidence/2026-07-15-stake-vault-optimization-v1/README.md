# Stake/Vault Optimization v1

Frozen source only: `C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15_b2f5dfb5963e\generated_signal_pairs_export.json`, SHA-256 `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`. No Supabase export was run.

Founder cap: `maxStakePct = 0.03` of UTC-cycle reference active equity. Signal Score is never treated as probability. Statistical stakes use past-only hierarchical observed outcomes, a one-sided Wilson 90% lower bound, conservative Kelly `(qLower - price)/(1-price)`, 3% cap, and downward tiers `0/30/50/70/100%`.

Dollar scaling (`unitValueUSD = chosenInitialCapitalUSD / 100`; `PnLUSD = PnLUnits × unitValueUSD`):

| Active bankroll | 3% maximum | 30% tier | 50% tier | 70% tier | 100% tier |
|---:|---:|---:|---:|---:|---:|
| $1,000.00 | $30.00 | $9.00 | $15.00 | $21.00 | $30.00 |
| $3,333.33 | $100.00 | $30.00 | $50.00 | $70.00 | $100.00 |
| $5,000.00 | $150.00 | $45.00 | $75.00 | $105.00 | $150.00 |
| $10,000.00 | $300.00 | $90.00 | $150.00 | $210.00 | $300.00 |

A fixed $100 maximum requires `$100 / 0.03 = $3,333.33` active bankroll. A result of 69 units is not inherently $6,900; it depends on the chosen initial-capital scaling.
