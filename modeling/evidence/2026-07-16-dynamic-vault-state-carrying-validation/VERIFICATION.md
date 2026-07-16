# Verification

- Dataset SHA: b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45
- 231-ID SHA: 99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca
- Registry: 24 unchanged policies
- Continuous replay reproductions: PASS
- Block 23 end hash equals block 24 start hash: true

## Gate 1

**PASS WITH DOCUMENTED PRE-EXISTING BASELINE EXCEPTION**

The full suite still contains five failures. An exact parent-branch reproduction
proved that all five failures are pre-existing, unchanged, and unrelated to the
state-carrying milestone. The milestone added 22 tests, all passing, and
introduced no new modeling regression.

| Branch | Pass | Fail | Total |
| --- | ---: | ---: | ---: |
| Parent V2 | 1538 | 5 | 1543 |
| State-carrying | 1560 | 5 | 1565 |

Classification: `PRE_EXISTING_UNCHANGED_BASELINE_FAILURES`.

The unchanged baseline failures are:

- `buildHypothesisRegistry.test.ts` — `importing the module does not auto-run the CLI`; `AssertionError: true !== false`; line 229.
- `runBoundedRoutingExperiments.test.ts` — `importing the module does not auto-run the CLI`; `AssertionError: true !== false`; line 189.
- `runHistoricalResearchPipeline.test.ts` — `importing the module does not auto-run the CLI`; `AssertionError: true !== false`; line 167.
- `runPostCutoffModelEvaluation.test.ts` — `M34: manifest contains no absolute Windows path`; absolute temporary Windows path assertion; line 441.
- `runScoreComponentAnalysis.test.ts` — `importing the module does not auto-run the CLI`; `AssertionError: true !== false`; line 174.

Task-specific Gate 1: **PASS**.

Repository-wide known baseline: **5 pre-existing failures remain**.
