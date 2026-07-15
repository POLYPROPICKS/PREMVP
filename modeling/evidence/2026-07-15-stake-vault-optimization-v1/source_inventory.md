# Source inventory

- `lib/modeling/executionWaterfall.ts`: exact independent cohort reconciliation, T−90 grouping, old-control attrition.
- `lib/modeling/stakeCalibration.ts`: past-only hierarchy, Wilson lower bound, conservative Kelly and tier quantization.
- `lib/modeling/stakeAllocationOptimizer.ts`: deterministic capacity allocation.
- `lib/modeling/stakeVaultOptimization.ts`: chronological comparator simulation.
- `lib/modeling/vaultPolicyOptimizer.ts`: declared grid, realized-equity vault ledger and fixed-seed bootstrap.
- `scripts/modeling/strategies/run-execution-waterfall.ts` and `run-stake-vault-optimization.ts`: local frozen-data runners.

Recovered but rejected: `computeBaseStake`/`computeStake` at commit `2034b53` are live USD tier rules, not cycle-reference allocation; `scripts/firemodel1-stake-lab.ts` uses prohibited `score/100` proxy Kelly; its vault text is not an executable simulation. Reused comparator: chronological settlement/accounting from `bankrollVaultReplay.ts`, introduced at `30c0299` and corrected at `8b31031`.
