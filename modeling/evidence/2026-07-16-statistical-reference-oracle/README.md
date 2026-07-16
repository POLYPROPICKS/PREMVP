# Statistical reference oracle

This package freezes numerical reference fixtures produced by `arch==8.0.0`. It validates the project convention for automatic block length and SPA outputs; it does not validate PolyProPicks profitability or independently reimplement the econometric algorithms.

Approved convention: stationary bootstrap, explicit block size, 20,000 replications, seed `20260716`, `studentize=true`, and `nested=false`. The Hansen SPA decision value is `pvalues.consistent`; `pvalues.upper` is conservative White-style recentering corroboration from the same SPA engine; `pvalues.lower` is report-only. The stationary `b_sb` result is the approved block length.

Run with the external environment:

```powershell
C:\WORK\KalshiProPulse\python-envs\polypropicks-stat-oracle\Scripts\python.exe -m unittest discover -s tests\modeling\reference-statistics -p 'test_*.py' -v
```
