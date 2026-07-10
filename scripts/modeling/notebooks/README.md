# Data Integrity Notebook/report (Phase 3D.2R)

Read-only founder review surface built entirely from two already-generated
local canonical exports:

```
modeling/local_exports/generated_signal_pairs_corpus_audit.json
modeling/local_exports/generated_signal_pairs_formula_cohort_comparison.json
```

Generate those two files first (existing Phase 3E.2i/3E.2j CLIs):

```
node --import tsx scripts/modeling/strategies/audit-generated-signal-pairs-corpus.ts
node --import tsx scripts/modeling/strategies/compare-formula-cohorts.ts
```

Then build the report:

```
node --import tsx scripts/modeling/notebooks/build-data-integrity-report.ts
```

Output (git-ignored, founder-run-locally):

```
modeling/local_exports/data_integrity_3d2r.html
```

The generator never queries Supabase, never reads `SUPABASE_*` env values,
and never recomputes dedup/ROI -- it only validates the cross-artifact
contract (retained rows === dedup rows, `droppedForFormulaVersion === 0`,
cohort row sums, `ALL_DEDUP_ROWS_CONTROL` row count) and renders the two
inputs' already-computed numbers. Exits non-zero with a JSON trace
(`inputArtifactPath`, `contractField`, `expected`/`actual`, `phase`) on any
contract violation or missing/invalid input.

Pure logic lives in `lib/modeling/dataIntegrityReport.ts` and is covered by
`tests/modeling/dataIntegrityReport.test.ts` using fixtures shaped exactly
like the two real generators' output -- no notebook execution or real data
required to run the test suite.
