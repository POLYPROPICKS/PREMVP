# Gate 1 evidence — Box B collector (PR #531), reviewed code SHA e928b4633ff4c209868fb3c255b344c722f9c398

| Check | Result |
|---|---|
| `git diff --check` | clean |
| `npm run control-plane:check` | PASS |
| `tests/research-clone/marketOutcomeCollector.test.ts` | 28/28 PASS (mutation-checked: composite-cursor revert fails the tie tests; dropping `C` from the cron exit fold fails the shell test) |
| `npm run test:research-clone-sync` | 264/265 — single failure `persisted narrow identity reaches the reader and tennis gate without settlement` |
| `tests/modeling/d1-modeling-conveyor.test.ts` | 16/17 — single failure `12. Railway runs the conveyor only after direct model-ready succeeds…` |
| `npm run build` (no env) | FAIL: `Missing required environment variable: SUPABASE_URL` while collecting `/api/*` page data |
| `npm run build` (placeholder env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY set to non-secret placeholders) | PASS |

## Baseline comparison (the failures are not counted as PASS)
The three failing items above fail **identically on the base commit 048406f3 (PR #530 head)** with this change stashed:
- `persisted narrow identity…`: red before and after (213th test on base, 241st with the new tests).
- `d1-modeling-conveyor` #12: red before and after — it asserts the bare command while the `startCommand` has been an `sh -c '…'` wrapper since before this work.
- `npm run build` without env: red before and after for the same missing-`SUPABASE_URL` reason; with placeholder values (no real secrets) it is green on this change.
This change introduces no new failing test and no new type error (`tsc` reports 0 errors in the new files; the repo has unrelated pre-existing type errors in `tests/contur3/*`).

Tests that pin the start command were updated for the new exit-code fold (`inplayPaperSettlementCycle.test.ts`) and a real `/bin/sh` execution test was added.
