# Verification

- Frozen input SHA-256: PASS (`b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45`).
- Identity audit: PASS (494 groups, zero collisions).
- Replay invariants: PASS (`177 === 177`; accepted eSports 0; collisions 0; simultaneous positions 22 ≤ 30; open exposure 52.03531144% ≤ 80%; daily accepted maximum 16 ≤ 100).
- Targeted test command: `node --import tsx --test tests/modeling/historicalSportingMatchIdentity.test.ts tests/modeling/bankrollVaultReplay.test.ts tests/modeling/historicalFunnelVariants.test.ts tests/modeling/boundedRoutingExperiments.test.ts` — 109/109 PASS.
- TypeScript command: `npx tsc --noEmit` (Windows PowerShell invocation used `npx.cmd`).
- Build command: `npm run build`.
