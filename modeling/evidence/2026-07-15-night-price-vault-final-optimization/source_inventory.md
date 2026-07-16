# Source inventory

- `lib/modeling/stakeReferenceSchedule.ts`: Europe/Minsk cycle keys, 18:00–09:00 window, immutable UTC/night/global references.
- `lib/modeling/priceBandStakePolicy.ts`: five exact price bands and deterministic 1,024/3,125 mapping enumeration.
- `lib/modeling/nightStakeArchitecture.ts`: deterministic capacity replay, terminal reasons and Minsk-night block bootstrap.
- `scripts/modeling/strategies/run-night-price-vault-final-optimization.ts`: frozen end-to-end artifact runner.
- Corresponding tests: `stakeReferenceSchedule.test.ts`, `priceBandStakePolicy.test.ts`, `nightStakeArchitecture.test.ts`.

No model, T-90, match identity, eSports rule, database schema, Ireland or production source was changed.
