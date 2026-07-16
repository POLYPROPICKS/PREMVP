# Methodology

The canonical 34 Minsk operating-day blocks are reused unchanged: 23 development blocks and 11 locked confirmation blocks. The volatility target `0.0341769` is the median rolling realized volatility calculated only from development settlement-batch returns with lookback 14. All seven policies are fixed before confirmation replay.

Buffered Profit Harvest is one-way and profit-only. It transfers after settlement batches, never liquidates positions, never sends Vault funds back to Active, and applies the existing Minsk-cycle transfer cap. The Dynamic stake remains exactly 3% of the established cycle Active reference.

Eligibility on confirmation requires at least 80% PnL retention, 15% maximum-fall reduction, 10% CVaR95 maximum-fall reduction, positive Vault and PnL, valid capital, and no future leakage. No protected arm passed every gate.
