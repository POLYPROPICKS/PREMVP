# Source / Test / Evidence Map V1

| Contract | Source / export | Test | Evidence | Coverage |
|---|---|---|---|---|
| signal/filter, threshold, eSports, floor, timing | lib/modeling/postCutoffModelMembership.ts | tests/modeling/postCutoffModelMembership.test.ts | modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/manifest.json | DIRECT UNIT |
| identity normalization/grouping/ranking/tie-breaks | lib/modeling/eventGroupSelection.ts | tests/modeling/eventGroupSelection.test.ts | modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/fixed_profile_ledger.json | REGRESSION |
| stake and capital state | lib/modeling/scientificCapitalArchitecture.ts | tests/modeling/scientificCapitalArchitecture.test.ts | modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/*_profile_curve.json | HISTORICAL EVIDENCE |
| Fixed/Dynamic profiles | lib/modeling/bankrollProfileRegistry.ts | tests/modeling/bankrollProfileRegistry.test.ts | modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/manifest.json | DETERMINISTIC HASH |
| identity/execution split | lib/modeling/canonicalModelHandoff.ts | tests/modeling/canonicalModelHandoff.test.ts | locked_*.json | DETERMINISTIC HASH |

Five pre-existing unchanged repository failures are KNOWN BASELINE GAP. Source export provenance is PARTIAL. Score production is outside this package. Exact dependency hashes are in source_hash_inventory.json; test names and classifications are in test_evidence_matrix.json.
