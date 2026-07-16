# Source inventory

- `scripts/modeling/reference-statistics/reference_oracle.py`: JSON CLI, input/output validation, API/version gate, `optimal_block_length` and SPA invocation, canonical hashing.
- `tests/modeling/reference-statistics/test_reference_oracle.py`: wrapper TDD, official-error case, exact fixtures, independent checks, and fresh-process determinism.
- `fixtures/*.json`: exact deterministic oracle inputs.
- `expected/*.json`: exact `arch==8.0.0` outputs, except Fixture A's documented expected error.
- `runtime_lock.txt`, `fixture_hashes.json`, `manifest.json`, `VERIFICATION.md`: reproducibility evidence.

No model, T−90, match identity, bankroll/vault, dataset, production, database, or Ireland source is changed.
