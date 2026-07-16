# Verification

- Frozen dataset SHA-256: PASS.
- Oracle implementation/fixture diff from `ee08e429`: PASS, unchanged.
- RED: five new regression failures captured for settlement grouping, decision-block attribution, daily limit, Pareto refinement, and deterministic final selection.
- Targeted scientific/evidence/waterfall tests: 22/22 PASS.
- Independent two-directory generation: 17/17 generated artifacts byte-identical.
- Manifest, file, ledger, curve, freeze, dashboard, and oracle hash reconciliation: PASS.
- Full modeling suite: 1523/1528 PASS; exactly the same five documented baseline failures, with no sixth failure.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- changed-diff secret scan: PASS for both atomic staged diffs.
