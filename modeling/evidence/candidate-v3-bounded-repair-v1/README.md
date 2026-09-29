# CANDIDATE_V3_BOUNDED_REPAIR_V1

Bounded repair of the Candidate V3 universe edge (soccer scope + market-type resolution) found by the Final Independent Review. `NOT_EXECUTION_AUTHORITY = true` for all artifacts.

Code: `scripts/modeling/candidate-v3-shadow-universe-gate.ts` (pure pre-gate + `runCandidateV3Selector`), tests in `tests/modeling/candidate-v3-shadow-universe-gate.test.ts`.

Files: REPAIR_CONTRACT.json, UNIVERSE_GATE_CONTRACT.json, AMENDED_CANDIDATE_V3_CONTRACT.json, REVIEW_BLOCKER_CLOSURE.md, README.md, SHA256SUMS.txt.

`modeling/evidence/candidate-v3-freeze-v1/` is preserved unmodified as provenance. The amended contract supersedes only SPORT_SCOPE enforcement and MARKET_ELIGIBILITY.

No DB query, no Gamma lookup, no production/live change. Verify: `cd modeling/evidence/candidate-v3-bounded-repair-v1 && sha256sum -c SHA256SUMS.txt`.
