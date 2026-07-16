# Preserved modeling-suite baseline exception

The exact known baseline remains five unrelated failures out of 1,509 existing modeling tests:

1. `buildHypothesisRegistry.test.ts` — `importing the module does not auto-run the CLI`, expected `false`, actual `true`.
2. `runBoundedRoutingExperiments.test.ts` — `importing the module does not auto-run the CLI`, expected `false`, actual `true`.
3. `runHistoricalResearchPipeline.test.ts` — `importing the module does not auto-run the CLI`, expected `false`, actual `true`.
4. `runPostCutoffModelEvaluation.test.ts` — `M34: manifest contains no absolute Windows path`; temporary input path is absolute.
5. `runScoreComponentAnalysis.test.ts` — `importing the module does not auto-run the CLI`, expected `false`, actual `true`.

None of these files is changed. This milestone must add no sixth failure and must not alter these identities.
