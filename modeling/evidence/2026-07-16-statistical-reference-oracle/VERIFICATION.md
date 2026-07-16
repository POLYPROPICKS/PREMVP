# Verification

- RED: 8/8 tests errored because `reference_oracle.py` did not exist.
- GREEN: 12/12 reference-oracle tests pass, including two fresh-process runs of every successful fixture and exact file-hash validation.
- Fixture A fails closed as documented; B returns positive finite `b_sb` and `b_cb`.
- C–E exact output fixtures match; dimensions, finiteness, differential means, p-value bounds and ordering pass independent checks.
- Complete existing `test:modeling`: 1504/1509 pass. Five pre-existing, untouched CLI import/path assertions fail on the exact base; no TypeScript modeling source was changed by this milestone.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- changed-diff secret scan: PASS.
