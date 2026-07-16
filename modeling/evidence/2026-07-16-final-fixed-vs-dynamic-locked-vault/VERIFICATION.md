# Verification

- Dataset SHA-256: `b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`.
- Sorted intended-ID SHA-256: `99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca`; every arm has a 231-row intended ledger.
- CPPI lock: one-way ratcheted, alpha `0.4`, multiplier `0.5`; no Vault-to-Active transfer.
- Reproduce:

```powershell
node --import tsx scripts/modeling/strategies/run-final-fixed-vs-dynamic-locked-vault.ts C:\WORK\KalshiProPulse\modeling-snapshots\2026-07-15_b2f5dfb5963e\generated_signal_pairs_export.json modeling\evidence\2026-07-16-final-fixed-vs-dynamic-locked-vault
```

The runner fails closed if the frozen dataset or locked ID hash changes. Statistical-oracle source and hashes are unchanged from the preceding locked-Vault milestone; this bounded comparison does not rerun an oracle or optimize a policy.
