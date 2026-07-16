# Methodology

Evaluation uses 34 ordered Minsk operating-day blocks, a minimum of 12 prior blocks, and 22 next-block evaluations. Policy parameters are predeclared and never read the evaluated block. Results are historical walk-forward pseudo-out-of-sample, not true forward or live evidence.

Stage A contains the exact 24-candidate Cartesian product. Only eligible Stage A parents may seed Stage B; because none improved both walk-forward maximum fall and CVaR95 relative to Dynamic No-Vault while exceeding Fixed Safe walk-forward PnL, Stage B is empty. No third search is performed.

The top Pareto protected profile is `PRV2_T25_P50_R1_S0.05_C0.1`: full-history PnL `121.85057149u`, ending Vault `52.34252857u`, walk-forward PnL `21.15940525u`. It fails the strict walk-forward risk-improvement conditions and is evidence for founder review, not a selected winner.
