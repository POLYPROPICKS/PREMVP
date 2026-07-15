# Source inventory

- `historicalMatchIdentityRecovery.ts`: exact slug+start rescue anchored only by a unique v1 participant-pair identity.
- `capacityRejectionAttribution.ts`: fixed-cycle terminal reason and counterfactual attribution.
- `pnlEdgeEstimator.ts`: past-only hierarchical Beta-Binomial posterior and expected PnL per dollar.
- `pnlFirstStakeAllocator.ts`: deterministic simultaneous-batch tier allocation and terminal reasons.
- `pnlFirstReplay.ts`: isolated PnL-first historical replay.
- `founderRiskConfig.ts`: founder-controlled dimensionless risk contract.
- `vaultPolicyOptimizer.ts`: expanded deterministic vault grid, bootstrap, and Pareto frontier.
- `run-stake-vault-optimization.ts`: attributed artifact CLI. Command: `node --import tsx scripts/modeling/strategies/run-stake-vault-optimization.ts <frozen-export.json> <output-root>`.

Future Ireland wiring may read founder values only from an approved runtime configuration source and pass a validated `FounderRiskConfig`; the historical path accepts explicit input/config values. No database migration or dollar hardcoding exists.
