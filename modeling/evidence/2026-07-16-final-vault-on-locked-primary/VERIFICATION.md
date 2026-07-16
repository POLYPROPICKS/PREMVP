# Verification

- Frozen input SHA-256: `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`.
- Locked sorted execution-ID SHA-256: `99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca`; count: 231.
- Policy grid: 25 coarse policies; no fine search and no model reselection.
- Statistical reference runtime: `arch==8.0.0`, stationary bootstrap, 20,000 repetitions, seed `20260716`; block size 2.
- Reproduce from the repository root:

```powershell
node --import tsx scripts/modeling/strategies/run-final-vault-on-locked-primary.ts C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15_b2f5dfb5963e\generated_signal_pairs_export.json modeling\evidence\2026-07-16-final-vault-on-locked-primary C:\WORK\KalshiProPulse\python-envs\polypropicks-stat-oracle\Scripts\python.exe scripts\modeling\reference-statistics\reference_oracle.py
```

The generator fails closed when either frozen dataset or locked ID set differs.
